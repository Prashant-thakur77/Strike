import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { Logger } from "pino";
import { buildApi } from "./api.js";
import type { IndexerSpec, Settings } from "./config.js";
import { createPool, migrate } from "./db.js";
import { ChainIndexer } from "./ingest.js";
import { type ChainReader, viemChainReader } from "./reader.js";
import { type StateReader, refreshTvl, viemStateReader } from "./tvl.js";
import { errorMessage, sleep } from "./util.js";
import { NotWriterError, Writer } from "./writer.js";

// The running service: migrations, the HTTP API, and the ingestion loop of every chain. Only the instance holding
// the writer lock ingests; the others serve the API from the same database and take over when the lock frees up.

export interface ServiceOptions {
  settings: Settings;
  spec: IndexerSpec;
  log: Logger;
  env?: NodeJS.ProcessEnv;
  /** Chain readers by chain id (tests pass fakes; default: viem over the SDK's RPC endpoints). */
  readers?: Map<number, ChainReader>;
  /** Chain state readers by chain id (USDG decimals, vault values). Default: viem. */
  states?: Map<number, StateReader | null>;
  /** First retry delay of a failing chunk (doubled per attempt). Default 1000 ms. */
  retryBaseDelayMs?: number;
  version?: string;
}

export class IndexerService {
  readonly pool: pg.Pool;
  readonly writer: Writer;
  readonly indexers: ChainIndexer[];
  readonly api: FastifyInstance;
  private readonly controller = new AbortController();
  private readonly states = new Map<number, StateReader | null>();
  private readonly lastTvl = new Map<number, number>();
  private loop: Promise<void> | null = null;
  private synced = false;

  constructor(private readonly o: ServiceOptions) {
    const { settings, spec, log } = o;
    this.pool = createPool(settings.databaseUrl, settings.poolMax);
    this.writer = new Writer(settings.databaseUrl, log, () => {
      this.synced = false;
    });
    this.indexers = spec.chains.map((chain) => {
      let reader = o.readers?.get(chain.chainId);
      let state = o.states?.has(chain.chainId) ? (o.states.get(chain.chainId) ?? null) : undefined;
      if (!reader) {
        const live = viemChainReader(chain.chainId, o.env);
        reader = live;
        if (state === undefined) state = viemStateReader(live.client);
      }
      this.states.set(chain.chainId, state ?? null);
      log.info(
        { chain: chain.chainId, rpc: reader.description, deployments: chain.deployments.map((d) => d.id) },
        "chain",
      );
      return new ChainIndexer({
        chain,
        reader,
        writer: this.writer,
        pool: this.pool,
        log,
        confirmations: settings.confirmations,
        maxRange: settings.maxRange,
        ...(o.retryBaseDelayMs !== undefined ? { baseDelayMs: o.retryBaseDelayMs } : {}),
        ...(state ? { decimals: state } : {}),
      });
    });
    this.api = buildApi({
      pool: this.pool,
      log,
      chains: spec.chains.map((c) => c.chainId),
      readyMaxLagBlocks: settings.readyMaxLagBlocks,
      readyMaxHeadAgeSeconds: settings.readyMaxHeadAgeSeconds,
      isWriter: () => this.writer.held,
      ...(o.version ? { version: o.version } : {}),
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The chain state reader of a chain (null when there is none). */
  stateOf(chainId: number): StateReader | null {
    return this.states.get(chainId) ?? null;
  }

  /** Apply pending migrations. */
  async migrate(): Promise<void> {
    const applied = await migrate(this.pool, { log: this.o.log });
    this.o.log.info({ applied: applied.length, source: this.o.spec.source }, "database ready");
  }

  /** Apply migrations, start listening, start the ingestion loop. Returns the address the API listens on. */
  async start(opts: { listen?: boolean } = {}): Promise<string | null> {
    const { settings } = this.o;
    await this.migrate();
    let address: string | null = null;
    if (opts.listen ?? true) {
      address = await this.api.listen({ host: settings.host, port: settings.port });
    }
    this.loop = this.run().catch((err) =>
      this.o.log.fatal({ err: errorMessage(err) }, "ingestion loop stopped"),
    );
    return address;
  }

  /** Become the writer if possible and sync the configured deployments. False when another instance writes. */
  async ensureWriter(): Promise<boolean> {
    const { log } = this.o;
    if (!this.writer.held) {
      const ok = await this.writer.acquire();
      if (!ok) return false;
      log.info("writer lock acquired");
      this.synced = false;
    }
    if (!this.synced) {
      for (const ix of this.indexers) await ix.sync();
      this.synced = true;
    }
    return true;
  }

  /** One round: every chain's tick (concurrently), then vault values where they are due. */
  async round(): Promise<void> {
    const { log, settings } = this.o;
    await Promise.all(
      this.indexers.map(async (ix) => {
        try {
          await ix.tick(this.signal);
        } catch (err) {
          if (err instanceof NotWriterError) throw err;
          log.error({ chain: ix.chainId, err: errorMessage(err) }, "tick failed");
          await ix.recordError(err);
          return;
        }
        const state = this.states.get(ix.chainId);
        const due = (this.lastTvl.get(ix.chainId) ?? 0) + settings.tvlIntervalMs <= Date.now();
        if (state && settings.tvlIntervalMs > 0 && due && !this.signal.aborted) {
          try {
            await refreshTvl({ chain: ix.chain, state, pool: this.pool, writer: this.writer, log });
            this.lastTvl.set(ix.chainId, Date.now());
          } catch (err) {
            if (err instanceof NotWriterError) throw err;
            log.error({ chain: ix.chainId, err: errorMessage(err) }, "vault values failed");
          }
        }
      }),
    );
  }

  private async run(): Promise<void> {
    const { log, settings } = this.o;
    let standbyLogged = false;
    while (!this.signal.aborted) {
      try {
        if (!(await this.ensureWriter())) {
          if (!standbyLogged) log.info("standby: another instance holds the writer lock; serving reads");
          standbyLogged = true;
          await sleep(settings.pollIntervalMs * 3, this.signal);
          continue;
        }
        standbyLogged = false;
        await this.round();
      } catch (err) {
        log.error(
          { err: errorMessage(err) },
          err instanceof NotWriterError ? "lost the writer lock" : "round failed",
        );
        this.synced = false;
      }
      await sleep(settings.pollIntervalMs, this.signal);
    }
  }

  /** Stop the loop (the chunk in flight commits or rolls back first), close the API, release the lock and pool. */
  async stop(reason = "stop"): Promise<void> {
    const { log, settings } = this.o;
    log.info({ reason }, "shutting down");
    this.controller.abort();
    const timeout = new Promise<"timeout">((r) =>
      setTimeout(() => r("timeout"), settings.shutdownTimeoutMs).unref(),
    );
    const finished = await Promise.race([this.loop ?? Promise.resolve(), timeout]);
    if (finished === "timeout") log.warn("ingestion did not stop in time; closing anyway");
    await this.api.close().catch(() => {});
    await this.writer.release().catch(() => {});
    await this.pool.end().catch(() => {});
    log.info("stopped");
  }
}
