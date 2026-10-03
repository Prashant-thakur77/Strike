import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import type pg from "pg";
import type { Logger } from "pino";
import { BadRequest, queryAgents, queryEpochs, queryEvents } from "./queries.js";
import { RateLimiter, registerRateLimit } from "./rate-limit.js";
import { readStats } from "./stats.js";

// The HTTP API. Every route reads Postgres through the pool, so a standby instance (one that does not hold the
// writer lock) answers the same way as the writer. Each response carries an x-request-id (the caller's, when it
// sends a sane one), and each request is logged with it.

export interface ApiDeps {
  pool: pg.Pool;
  log: Logger;
  /** Chain ids this instance indexes (for /ready). */
  chains: number[];
  readyMaxLagBlocks: number;
  readyMaxHeadAgeSeconds: number;
  isWriter: () => boolean;
  version?: string;
  /** Requests per client IP per window on every route but /health; 0 or unset turns the limiter off. */
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  /** Take the client IP from X-Forwarded-For (only behind a proxy that sets it). */
  trustProxy?: boolean;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const DEPLOYMENT = /^\d+-[A-Za-z0-9.?]{1,16}$/;

type Query = Record<string, string | undefined>;

function intParam(
  q: Query,
  name: string,
  opts: { min: number; max: number; fallback?: number },
): number | undefined {
  const raw = q[name];
  if (raw === undefined || raw === "") return opts.fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < opts.min || n > opts.max) {
    throw new BadRequest(`${name} must be an integer from ${opts.min} to ${opts.max}`);
  }
  return n;
}

function chainParam(q: Query): number | undefined {
  return intParam(q, "chain", { min: 1, max: 2 ** 31 - 1 });
}

function vaultParam(q: Query): string | undefined {
  const v = q.vault;
  if (v === undefined || v === "") return undefined;
  if (!ADDRESS.test(v)) throw new BadRequest("vault must be a 0x address");
  return v.toLowerCase();
}

function accountParam(q: Query): string | undefined {
  const v = q.account;
  if (v === undefined || v === "") return undefined;
  if (!ADDRESS.test(v)) throw new BadRequest("account must be a 0x address");
  return v.toLowerCase();
}

export function buildApi(deps: ApiDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.log as unknown as FastifyBaseLogger,
    genReqId: (req) => {
      const h = req.headers["x-request-id"];
      return typeof h === "string" && REQUEST_ID.test(h) ? h : randomUUID();
    },
    return503OnClosing: true,
    forceCloseConnections: "idle",
    trustProxy: deps.trustProxy ?? false,
  });
  const started = Date.now();

  registerRateLimit(
    app,
    new RateLimiter({ max: deps.rateLimitMax ?? 0, windowMs: deps.rateLimitWindowMs ?? 60_000 }),
  );

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof BadRequest) return reply.code(400).send({ error: err.message, requestId: req.id });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as Error).message, requestId: req.id });
    }
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "internal error", requestId: req.id });
  });

  app.get("/", async () => ({
    service: "strike-indexer",
    endpoints: ["/health", "/ready", "/stats", "/events", "/agents", "/epochs"],
  }));

  // Liveness: the process is up and serving. No database call, so a database outage does not restart it.
  app.get("/health", async () => ({
    status: "ok",
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    writer: deps.isWriter(),
    ...(deps.version ? { version: deps.version } : {}),
  }));

  // Readiness: the database answers and every chain is within the lag threshold of its head.
  app.get("/ready", async (_req, reply) => {
    const t0 = Date.now();
    let dbOk = true;
    let dbError: string | undefined;
    try {
      await deps.pool.query("SELECT 1");
    } catch (err) {
      dbOk = false;
      dbError = (err as Error).message;
    }
    const latencyMs = Date.now() - t0;
    let rows: Record<string, unknown>[] = [];
    if (dbOk) {
      rows = (
        await deps.pool.query(
          `SELECT c.chain_id, h.head_block, h.finalized_block, h.last_error,
             extract(epoch FROM now() - h.seen_at)::float AS head_age,
             json_agg(json_build_object('id', cu.deployment_id, 'lastIndexedBlock', cu.last_indexed_block)
                      ORDER BY cu.deployment_id) AS deployments
           FROM chains c
           LEFT JOIN chain_heads h ON h.chain_id = c.chain_id
           LEFT JOIN cursors cu ON cu.chain_id = c.chain_id
           WHERE c.chain_id = ANY($1::int[])
           GROUP BY c.chain_id, h.chain_id`,
          [deps.chains],
        )
      ).rows;
    }
    const byChain = new Map(rows.map((r) => [Number(r.chain_id), r]));
    const chains = deps.chains.map((chainId) => {
      const r = byChain.get(chainId);
      const head = r?.head_block === null || r?.head_block === undefined ? null : Number(r.head_block);
      const deployments = (
        (r?.deployments as { id: string | null; lastIndexedBlock: number }[] | undefined) ?? []
      )
        .filter((d) => d.id !== null)
        .map((d) => ({
          id: d.id,
          lastIndexedBlock: Number(d.lastIndexedBlock),
          lagBlocks: head === null ? null : Math.max(0, head - Number(d.lastIndexedBlock)),
        }));
      const lag =
        deployments.length && head !== null ? Math.max(...deployments.map((d) => d.lagBlocks ?? 0)) : null;
      const age = r?.head_age === null || r?.head_age === undefined ? null : Math.round(Number(r.head_age));
      const reasons: string[] = [];
      if (!r || head === null) reasons.push("head not read yet");
      if (lag !== null && lag > deps.readyMaxLagBlocks)
        reasons.push(`lag ${lag} > ${deps.readyMaxLagBlocks} blocks`);
      if (age !== null && age > deps.readyMaxHeadAgeSeconds) {
        reasons.push(`head read ${age} s ago > ${deps.readyMaxHeadAgeSeconds} s`);
      }
      return {
        chainId,
        ok: reasons.length === 0,
        headBlock: head,
        finalizedBlock:
          r?.finalized_block === null || r?.finalized_block === undefined ? null : Number(r.finalized_block),
        lagBlocks: lag,
        maxLagBlocks: deps.readyMaxLagBlocks,
        headAgeSeconds: age,
        maxHeadAgeSeconds: deps.readyMaxHeadAgeSeconds,
        lastError: (r?.last_error as string | null | undefined) ?? null,
        deployments,
        ...(reasons.length ? { reasons } : {}),
      };
    });
    const ready = dbOk && chains.every((c) => c.ok);
    return reply.code(ready ? 200 : 503).send({
      ready,
      db: { ok: dbOk, latencyMs, ...(dbError ? { error: dbError } : {}) },
      writer: deps.isWriter(),
      chains,
    });
  });

  // The app's /api/stats shape (plus an `indexer` block saying how fresh it is).
  app.get("/stats", async (req: FastifyRequest<{ Querystring: Query }>, reply) => {
    const chain = chainParam(req.query);
    const stats = await readStats(deps.pool, chain ? { chains: [chain] } : {});
    reply.header("Cache-Control", "public, max-age=30");
    reply.header("Access-Control-Allow-Origin", "*");
    return stats;
  });

  app.get("/events", async (req: FastifyRequest<{ Querystring: Query }>, reply) => {
    const q = req.query;
    const types = (q.type ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (types.some((t) => !EVENT_NAME.test(t)))
      throw new BadRequest("type must be event names, comma-separated");
    if (q.deployment && !DEPLOYMENT.test(q.deployment))
      throw new BadRequest("deployment must look like 46630-v3");
    const page = await queryEvents(deps.pool, {
      chain: chainParam(q),
      types,
      vault: vaultParam(q),
      account: accountParam(q),
      deployment: q.deployment || undefined,
      limit: intParam(q, "limit", { min: 1, max: 500, fallback: 50 })!,
      cursor: q.cursor || undefined,
    });
    reply.header("Access-Control-Allow-Origin", "*");
    return page;
  });

  app.get("/agents", async (req: FastifyRequest<{ Querystring: Query }>, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    return { agents: await queryAgents(deps.pool, chainParam(req.query)) };
  });

  app.get("/epochs", async (req: FastifyRequest<{ Querystring: Query }>, reply) => {
    const q = req.query;
    const state = q.state || undefined;
    if (state && !["open", "running", "settled", "aborted"].includes(state)) {
      throw new BadRequest("state must be open, running, settled or aborted");
    }
    reply.header("Access-Control-Allow-Origin", "*");
    return {
      epochs: await queryEpochs(deps.pool, {
        chain: chainParam(q),
        vault: vaultParam(q),
        state,
        limit: intParam(q, "limit", { min: 1, max: 500, fallback: 100 })!,
      }),
    };
  });

  return app;
}
