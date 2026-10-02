import type pg from "pg";
import type { Logger } from "pino";
import type { Hex } from "viem";
import { type JsonValue, type RawLog, decodeLog, vaultOf } from "./abi.js";
import type { ChainSpec, ContractKind, DeploymentSpec } from "./config.js";
import type { ChainBlock, ChainReader } from "./reader.js";
import { NotWriterError, type Writer } from "./writer.js";
import { backoffMs, errorMessage, isRangeLimitError, mapLimit, maxBig, minBig, sleep } from "./util.js";

// Ingestion of one chain: every deployment's logs from its deploy block, in chunks, into `events`.
//
// Idempotent: a log is identified by (chain_id, tx_hash, log_index) and inserted with ON CONFLICT DO NOTHING, so a
// re-run or an overlapping range never duplicates a row.
// Reorg-safe: only blocks `confirmations` behind the head are read. The hash of each indexed range's last block is
// kept (cursors.last_indexed_hash) and compared with the chain on every tick; a block hash commits to its parents,
// so a match there means everything below it is still on the chain. On a mismatch the stored blocks are walked down
// to the highest one whose hash still matches (the fork point), everything above it is deleted and read again.
// Each chunk also checks that the block before it still has the hash stored for it, so a reorg that lands between
// the tick's check and the chunk is caught before the cursor moves.

/** A chunk saw a block hash that differs from the one stored or from its own logs: the chain moved under it. */
export class ReorgDuringRead extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReorgDuringRead";
  }
}

/** Reads the chain state the logs do not carry: USDG decimals (and, in tvl.ts, vault values). */
export interface DecimalsReader {
  usdgDecimals(dep: DeploymentSpec): Promise<number>;
}

export interface ChainIndexerOptions {
  chain: ChainSpec;
  reader: ChainReader;
  writer: Writer;
  pool: pg.Pool;
  log: Logger;
  /** Blocks behind the head that are indexed. */
  confirmations: bigint;
  /** Largest getLogs range; halved on an RPC range or size limit and grown back after successes. */
  maxRange: bigint;
  decimals?: DecimalsReader;
  /** Consecutive failures of a chunk (other than range limits) before the tick gives up. Default 3. */
  retries?: number;
  baseDelayMs?: number;
  /** Used for last_finalized_block when the RPC does not serve the `finalized` tag. Default 2000. */
  finalityFallbackBlocks?: bigint;
  blockConcurrency?: number;
}

export interface RangeResult {
  from: bigint;
  to: bigint;
  chunks: number;
  logs: number;
  inserted: number;
  vaultsFound: number;
}

export interface TickResult {
  head: bigint;
  finalized: bigint | null;
  target: bigint;
  reorg: { forkBlock: bigint; eventsRemoved: number } | null;
  deployments: Record<string, RangeResult | null>;
}

interface KnownContract {
  address: string;
  kind: ContractKind;
  deploymentId: string;
  firstBlock: bigint;
}

interface Row {
  blockNumber: bigint;
  blockHash: string;
  blockTime: Date;
  txHash: string;
  txIndex: number;
  logIndex: number;
  address: string;
  source: ContractKind;
  eventName: string | null;
  args: { [k: string]: JsonValue } | null;
  topics: string[];
  data: string;
}

const INSERT_BATCH = 1000;

export class ChainIndexer {
  readonly chain: ChainSpec;
  private readonly reader: ChainReader;
  private readonly writer: Writer;
  private readonly pool: pg.Pool;
  private readonly log: Logger;
  private readonly confirmations: bigint;
  private readonly maxRange: bigint;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly finalityFallback: bigint;
  private readonly blockConcurrency: number;
  private readonly decimals?: DecimalsReader;

  constructor(o: ChainIndexerOptions) {
    this.chain = o.chain;
    this.reader = o.reader;
    this.writer = o.writer;
    this.pool = o.pool;
    this.log = o.log.child({ chain: o.chain.chainId });
    this.confirmations = o.confirmations;
    this.maxRange = o.maxRange > 0n ? o.maxRange : 1n;
    this.retries = o.retries ?? 3;
    this.baseDelayMs = o.baseDelayMs ?? 1000;
    this.finalityFallback = o.finalityFallbackBlocks ?? 2000n;
    this.blockConcurrency = o.blockConcurrency ?? 8;
    this.decimals = o.decimals;
  }

  get chainId(): number {
    return this.chain.chainId;
  }

  /**
   * Record the chain, its deployments, their configured contracts and a cursor per deployment (at the block before
   * the deploy block). A contract added to the config after its deployment was indexed is backfilled from its
   * deployment's deploy block up to the cursor. Reads USDG decimals once.
   */
  async sync(): Promise<void> {
    const c = this.chain;
    const backfill: { dep: DeploymentSpec; addresses: string[]; to: bigint }[] = [];
    await this.writer.tx(async (db) => {
      await db.query(
        `INSERT INTO chains (chain_id, name, short_name, explorer) VALUES ($1, $2, $3, $4)
         ON CONFLICT (chain_id) DO UPDATE SET name = EXCLUDED.name, short_name = EXCLUDED.short_name,
           explorer = EXCLUDED.explorer, updated_at = now()`,
        [c.chainId, c.name, c.short, c.explorer],
      );
      for (const [i, d] of c.deployments.entries()) {
        const prior = await db.query<{ epoch_manager: string; deploy_block: number }>(
          "SELECT epoch_manager, deploy_block FROM deployments WHERE id = $1",
          [d.id],
        );
        const p = prior.rows[0];
        if (p && (p.epoch_manager !== d.epochManager || BigInt(p.deploy_block) !== d.deployBlock)) {
          throw new Error(
            `deployment ${d.id} in ${d.file} is not the one indexed (EpochManager or deploy block changed): give it a new version or reset the database`,
          );
        }
        await db.query(
          `INSERT INTO deployments (id, chain_id, version, ordinal, deploy_block, usdg, stock_oracle, epoch_manager,
             vault_factory, agent_registry, decision_log, source_file)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO UPDATE SET ordinal = EXCLUDED.ordinal, usdg = EXCLUDED.usdg,
             stock_oracle = EXCLUDED.stock_oracle, vault_factory = EXCLUDED.vault_factory,
             agent_registry = EXCLUDED.agent_registry, decision_log = EXCLUDED.decision_log,
             source_file = EXCLUDED.source_file, updated_at = now()`,
          [
            d.id,
            c.chainId,
            d.version,
            i,
            d.deployBlock.toString(),
            d.usdg,
            d.stockOracle,
            d.epochManager,
            d.vaultFactory,
            d.agentRegistry,
            d.decisionLog ?? null,
            d.file,
          ],
        );
        const start = (d.deployBlock > 0n ? d.deployBlock - 1n : 0n).toString();
        await db.query(
          `INSERT INTO cursors (deployment_id, chain_id, last_indexed_block, last_finalized_block)
           VALUES ($1, $2, $3, $3) ON CONFLICT (deployment_id) DO NOTHING`,
          [d.id, c.chainId, start],
        );
        const cursor = await db.query<{ last_indexed_block: number }>(
          "SELECT last_indexed_block FROM cursors WHERE deployment_id = $1",
          [d.id],
        );
        const added: string[] = [];
        for (const k of d.contracts) {
          const r = await db.query(
            `INSERT INTO contracts (chain_id, address, deployment_id, kind, label, first_block, discovered)
             VALUES ($1, $2, $3, $4, $5, $6, false)
             ON CONFLICT (chain_id, address) DO UPDATE SET label = coalesce(EXCLUDED.label, contracts.label),
               discovered = false
             RETURNING (xmax = 0) AS inserted`,
            [c.chainId, k.address, d.id, k.kind, k.label ?? null, d.deployBlock.toString()],
          );
          if (r.rows[0]?.inserted) added.push(k.address);
        }
        const last = BigInt(cursor.rows[0]?.last_indexed_block ?? start);
        if (added.length && last >= d.deployBlock) backfill.push({ dep: d, addresses: added, to: last });
      }
    });
    for (const b of backfill) {
      this.log.info(
        { deployment: b.dep.id, addresses: b.addresses, to: b.to.toString() },
        "backfilling new contracts",
      );
      await this.ingestRange(b.dep, b.dep.deployBlock, b.to, {
        addresses: b.addresses,
        advanceCursor: false,
      });
    }
    if (this.decimals) {
      for (const d of c.deployments) {
        const { rows } = await this.pool.query("SELECT usdg_decimals FROM deployments WHERE id = $1", [d.id]);
        if (rows[0]?.usdg_decimals !== null && rows[0]?.usdg_decimals !== undefined) continue;
        try {
          const dec = await this.decimals.usdgDecimals(d);
          await this.writer.tx((db) =>
            db.query("UPDATE deployments SET usdg_decimals = $2 WHERE id = $1", [d.id, dec]),
          );
        } catch (err) {
          this.log.warn(
            { deployment: d.id, err: errorMessage(err) },
            "could not read USDG decimals; retrying next start",
          );
        }
      }
    }
  }

  /** One pass: read the head, handle a reorg, index every deployment up to head - confirmations. */
  async tick(signal?: AbortSignal): Promise<TickResult> {
    const started = Date.now();
    const head = await this.reader.getBlockNumber();
    const finalized = await this.reader.getFinalizedBlockNumber();
    await this.writer.tx((db) =>
      db.query(
        `INSERT INTO chain_heads (chain_id, head_block, finalized_block, seen_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (chain_id) DO UPDATE SET head_block = EXCLUDED.head_block,
           finalized_block = EXCLUDED.finalized_block, seen_at = now()`,
        [this.chainId, head.toString(), finalized?.toString() ?? null],
      ),
    );
    const reorg = await this.checkReorg();
    const target = head - this.confirmations;
    const finalBlock = finalized ?? head - this.finalityFallback;
    const deployments: Record<string, RangeResult | null> = {};
    for (const dep of this.chain.deployments) {
      if (signal?.aborted) break;
      const cursor = await this.cursor(dep.id);
      if (cursor.lastIndexed >= target) {
        deployments[dep.id] = null;
        continue;
      }
      deployments[dep.id] = await this.ingestRange(dep, cursor.lastIndexed + 1n, target, {
        finalized: finalBlock,
        signal,
      });
    }
    // Hashes below every cursor's finalized block can no longer change: drop them. Clear the error of a failed tick.
    await this.writer.tx(async (db) => {
      await db.query(
        `DELETE FROM blocks WHERE chain_id = $1
           AND number < (SELECT min(last_finalized_block) FROM cursors WHERE chain_id = $1)`,
        [this.chainId],
      );
      await db.query("UPDATE chain_heads SET last_error = NULL, last_error_at = NULL WHERE chain_id = $1", [
        this.chainId,
      ]);
    });
    const indexed = Object.values(deployments).filter((r): r is RangeResult => r !== null);
    this.log.info(
      {
        head: head.toString(),
        finalized: finalized?.toString() ?? null,
        target: target.toString(),
        logs: indexed.reduce((s, r) => s + r.logs, 0),
        inserted: indexed.reduce((s, r) => s + r.inserted, 0),
        reorg: reorg ? { forkBlock: reorg.forkBlock.toString(), eventsRemoved: reorg.eventsRemoved } : null,
        durationMs: Date.now() - started,
      },
      "tick",
    );
    return { head, finalized, target, reorg, deployments };
  }

  /** Record a failed tick on chain_heads (for /ready), when this instance is the writer. */
  async recordError(err: unknown): Promise<void> {
    await this.writer
      .tx((db) =>
        db.query(`UPDATE chain_heads SET last_error = $2, last_error_at = now() WHERE chain_id = $1`, [
          this.chainId,
          errorMessage(err).slice(0, 500),
        ]),
      )
      .catch(() => {});
  }

  private async cursor(
    id: string,
  ): Promise<{ lastIndexed: bigint; hash: string | null; lastFinalized: bigint }> {
    const { rows } = await this.pool.query(
      "SELECT last_indexed_block, last_indexed_hash, last_finalized_block FROM cursors WHERE deployment_id = $1",
      [id],
    );
    const r = rows[0];
    if (!r) throw new Error(`no cursor for ${id}: run sync() first`);
    return {
      lastIndexed: BigInt(r.last_indexed_block),
      hash: r.last_indexed_hash,
      lastFinalized: BigInt(r.last_finalized_block),
    };
  }

  /**
   * Compare each deployment's stored tip with the chain. When one differs, find the fork point (the highest stored
   * block whose hash still matches, or the finalized floor) and roll back everything above it.
   */
  async checkReorg(): Promise<{ forkBlock: bigint; eventsRemoved: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT last_indexed_block AS block, last_indexed_hash AS hash
       FROM cursors WHERE chain_id = $1 AND last_indexed_hash IS NOT NULL AND last_indexed_block > last_finalized_block
       ORDER BY block DESC`,
      [this.chainId],
    );
    let stale: { block: bigint; hash: string } | null = null;
    for (const r of rows) {
      const b = await this.reader.getBlock(BigInt(r.block));
      if (b.hash.toLowerCase() !== r.hash) {
        stale = { block: BigInt(r.block), hash: r.hash };
        break;
      }
    }
    if (!stale) return null;
    const floorRow = await this.pool.query(
      "SELECT min(last_finalized_block) AS floor FROM cursors WHERE chain_id = $1",
      [this.chainId],
    );
    const floor = BigInt(floorRow.rows[0]?.floor ?? 0);
    const stored = await this.pool.query(
      "SELECT number, hash FROM blocks WHERE chain_id = $1 AND number > $2 AND number < $3 ORDER BY number DESC",
      [this.chainId, floor.toString(), stale.block.toString()],
    );
    let fork = floor;
    for (const s of stored.rows) {
      const b = await this.reader.getBlock(BigInt(s.number));
      if (b.hash.toLowerCase() === s.hash) {
        fork = BigInt(s.number);
        break;
      }
    }
    const eventsRemoved = await this.rollback(fork, stale);
    this.log.warn(
      { staleBlock: stale.block.toString(), forkBlock: fork.toString(), eventsRemoved },
      "reorg: rolled back above the fork point; re-indexing",
    );
    return { forkBlock: fork, eventsRemoved };
  }

  /** Delete everything above `fork` on this chain and move the cursors back to it. Returns the events removed. */
  async rollback(fork: bigint, stale: { block: bigint; hash: string }): Promise<number> {
    const chainId = this.chainId;
    const f = fork.toString();
    return this.writer.tx(async (db) => {
      const ev = await db.query("DELETE FROM events WHERE chain_id = $1 AND block_number > $2", [chainId, f]);
      await db.query("DELETE FROM contracts WHERE chain_id = $1 AND discovered AND first_block > $2", [
        chainId,
        f,
      ]);
      await db.query("DELETE FROM blocks WHERE chain_id = $1 AND number > $2", [chainId, f]);
      await db.query(
        `UPDATE cursors cu SET
           last_indexed_block = GREATEST($2::bigint, d.deploy_block - 1),
           last_indexed_hash = (SELECT b.hash FROM blocks b WHERE b.chain_id = $1
                                  AND b.number = GREATEST($2::bigint, d.deploy_block - 1)),
           last_finalized_block = LEAST(cu.last_finalized_block, GREATEST($2::bigint, d.deploy_block - 1)),
           updated_at = now()
         FROM deployments d
         WHERE d.id = cu.deployment_id AND cu.chain_id = $1 AND cu.last_indexed_block > $2::bigint`,
        [chainId, f],
      );
      await db.query(
        `INSERT INTO reorgs (chain_id, stale_block, stale_hash, fork_block, events_removed)
         VALUES ($1, $2, $3, $4, $5)`,
        [chainId, stale.block.toString(), stale.hash, f, ev.rowCount ?? 0],
      );
      return ev.rowCount ?? 0;
    });
  }

  /**
   * Index [from, to] for one deployment, in chunks of up to `maxRange` blocks, each committed in one transaction.
   * A chunk the RPC refuses as too large is retried in halves; other failures are retried with backoff, then thrown.
   * With `advanceCursor` (the default) the cursor moves to `to` when the range starts at or before the block after
   * it; `addresses` limits the read to those contracts (a backfill) and leaves the cursor alone.
   */
  async ingestRange(
    dep: DeploymentSpec,
    from: bigint,
    to: bigint,
    opts: { addresses?: string[]; advanceCursor?: boolean; finalized?: bigint; signal?: AbortSignal } = {},
  ): Promise<RangeResult> {
    const total: RangeResult = { from, to, chunks: 0, logs: 0, inserted: 0, vaultsFound: 0 };
    let size = this.maxRange;
    let start = from;
    let failures = 0;
    while (start <= to) {
      if (opts.signal?.aborted) break;
      const end = minBig(start + size - 1n, to);
      const started = Date.now();
      try {
        const r = await this.ingestChunk(dep, start, end, opts);
        total.chunks += 1;
        total.logs += r.logs;
        total.inserted += r.inserted;
        total.vaultsFound += r.vaultsFound;
        this.log.info(
          {
            deployment: dep.id,
            from: start.toString(),
            to: end.toString(),
            logs: r.logs,
            inserted: r.inserted,
            vaultsFound: r.vaultsFound,
            durationMs: Date.now() - started,
          },
          "range indexed",
        );
        failures = 0;
        start = end + 1n;
        if (size < this.maxRange) size = minBig(size * 2n, this.maxRange);
      } catch (err) {
        if (err instanceof NotWriterError) throw err;
        if (isRangeLimitError(err) && size > 1n) {
          size = maxBig(size / 2n, 1n);
          this.log.debug(
            { deployment: dep.id, from: start.toString(), size: size.toString() },
            "range refused; halving",
          );
          continue;
        }
        failures += 1;
        this.log.warn(
          {
            deployment: dep.id,
            from: start.toString(),
            to: end.toString(),
            attempt: failures,
            err: errorMessage(err),
          },
          "chunk failed",
        );
        if (failures > this.retries) throw err;
        await sleep(backoffMs(failures, this.baseDelayMs), opts.signal);
      }
    }
    return total;
  }

  private async contracts(): Promise<KnownContract[]> {
    const { rows } = await this.pool.query(
      "SELECT address, kind, deployment_id, first_block FROM contracts WHERE chain_id = $1",
      [this.chainId],
    );
    return rows.map((r) => ({
      address: r.address,
      kind: r.kind,
      deploymentId: r.deployment_id,
      firstBlock: BigInt(r.first_block),
    }));
  }

  private async ingestChunk(
    dep: DeploymentSpec,
    from: bigint,
    to: bigint,
    opts: { addresses?: string[]; advanceCursor?: boolean; finalized?: bigint },
  ): Promise<{ logs: number; inserted: number; vaultsFound: number }> {
    const all = await this.contracts();
    const only = opts.addresses ? new Set(opts.addresses.map((a) => a.toLowerCase())) : null;
    const known = all.filter(
      (c) => c.deploymentId === dep.id && c.firstBlock <= to && (!only || only.has(c.address)),
    );
    const kindOf = new Map(all.map((c) => [c.address, c]));

    // The last block first: a reorg after this read changes its hash, which the next tick sees.
    const tip = await this.reader.getBlock(to);
    if (tip.number !== to) throw new Error(`asked for block ${to}, got ${tip.number}`);
    const raw = known.length
      ? await this.reader.getLogs(
          known.map((c) => c.address as Hex),
          from,
          to,
        )
      : [];

    const rows: Omit<Row, "blockTime">[] = [];
    const found = new Map<string, bigint>();
    const take = (l: RawLog, kind: ContractKind) => {
      const d = decodeLog(l, kind);
      rows.push({
        blockNumber: l.blockNumber,
        blockHash: l.blockHash.toLowerCase(),
        txHash: l.transactionHash.toLowerCase(),
        txIndex: l.transactionIndex,
        logIndex: l.logIndex,
        address: l.address.toLowerCase(),
        source: kind,
        eventName: d?.eventName ?? null,
        args: d?.args ?? null,
        topics: l.topics.map((t) => t.toLowerCase()),
        data: l.data.toLowerCase(),
      });
      const v = d ? vaultOf(kind, d.eventName, d.args) : null;
      if (v && !kindOf.has(v) && !found.has(v)) found.set(v, l.blockNumber);
    };
    const knownSet = new Map(known.map((c) => [c.address, c.kind]));
    for (const l of raw) {
      const kind = knownSet.get(l.address.toLowerCase());
      if (kind) take(l, kind);
    }
    // Vaults created in this chunk: their logs from the block that created them.
    if (found.size && !only) {
      const first = [...found.values()].reduce(minBig);
      const vaultLogs = await this.reader.getLogs([...found.keys()] as Hex[], first, to);
      for (const l of vaultLogs) take(l, "vault");
    }

    // Block hashes and times of every block with a log, checked against the logs' own block hashes.
    const numbers = [...new Set(rows.map((r) => r.blockNumber))].filter((n) => n !== to);
    const fetched = await mapLimit(numbers, this.blockConcurrency, (n) => this.reader.getBlock(n));
    const blocks = new Map<bigint, ChainBlock>([[to, tip], ...fetched.map((b) => [b.number, b] as const)]);
    for (const r of rows) {
      const b = blocks.get(r.blockNumber);
      if (!b || b.hash.toLowerCase() !== r.blockHash) {
        throw new ReorgDuringRead(
          `log in block ${r.blockNumber} has hash ${r.blockHash}, the block has ${b?.hash}`,
        );
      }
    }
    // The block before the chunk must still be the one stored for it (a reorg between ticks' checks).
    const prev = from > 0n ? from - 1n : null;
    const prevStored =
      prev === null
        ? null
        : (
            await this.pool.query<{ hash: string }>(
              "SELECT hash FROM blocks WHERE chain_id = $1 AND number = $2",
              [this.chainId, prev.toString()],
            )
          ).rows[0];
    if (prev !== null && prevStored) {
      const canonical = blocks.get(prev) ?? (await this.reader.getBlock(prev));
      if (canonical.hash.toLowerCase() !== prevStored.hash) {
        throw new ReorgDuringRead(
          `block ${prev} changed (stored ${prevStored.hash}, chain ${canonical.hash})`,
        );
      }
    }

    const dated: Row[] = rows.map((r) => ({
      ...r,
      blockTime: new Date(Number(blocks.get(r.blockNumber)!.timestamp) * 1000),
    }));
    const advance = opts.advanceCursor ?? !only;
    const chainId = this.chainId;

    const inserted = await this.writer.tx(async (db) => {
      const blockList = [...blocks.values()];
      const stored = await db.query<{ number: number; hash: string }>(
        "SELECT number, hash FROM blocks WHERE chain_id = $1 AND number = ANY($2::bigint[])",
        [chainId, blockList.map((b) => b.number.toString())],
      );
      for (const s of stored.rows) {
        const b = blocks.get(BigInt(s.number));
        if (b && b.hash.toLowerCase() !== s.hash) {
          throw new ReorgDuringRead(
            `block ${s.number} is stored with hash ${s.hash}, the chain now has ${b.hash}`,
          );
        }
      }
      await db.query(
        `INSERT INTO blocks (chain_id, number, hash, parent_hash, block_time)
         SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::text[], $5::timestamptz[])
         ON CONFLICT (chain_id, number) DO NOTHING`,
        [
          chainId,
          blockList.map((b) => b.number.toString()),
          blockList.map((b) => b.hash.toLowerCase()),
          blockList.map((b) => b.parentHash.toLowerCase()),
          blockList.map((b) => new Date(Number(b.timestamp) * 1000).toISOString()),
        ],
      );
      for (const [address, block] of found) {
        await db.query(
          `INSERT INTO contracts (chain_id, address, deployment_id, kind, first_block, discovered)
           VALUES ($1, $2, $3, 'vault', $4, true) ON CONFLICT (chain_id, address) DO NOTHING`,
          [chainId, address, dep.id, block.toString()],
        );
      }
      let count = 0;
      for (let i = 0; i < dated.length; i += INSERT_BATCH) {
        const batch = dated.slice(i, i + INSERT_BATCH);
        const r = await db.query(
          `INSERT INTO events (chain_id, deployment_id, block_number, block_hash, block_time, tx_hash, tx_index,
             log_index, address, source, event_name, args, topics, data)
           SELECT $1, $2, u.block_number, u.block_hash, u.block_time, u.tx_hash, u.tx_index, u.log_index, u.address,
             u.source, u.event_name, u.args, string_to_array(u.topics, ','), u.data
           FROM unnest($3::bigint[], $4::text[], $5::timestamptz[], $6::text[], $7::int[], $8::int[], $9::text[],
             $10::text[], $11::text[], $12::jsonb[], $13::text[], $14::text[])
             AS u(block_number, block_hash, block_time, tx_hash, tx_index, log_index, address, source, event_name, args,
               topics, data)
           ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
          [
            chainId,
            dep.id,
            batch.map((r) => r.blockNumber.toString()),
            batch.map((r) => r.blockHash),
            batch.map((r) => r.blockTime.toISOString()),
            batch.map((r) => r.txHash),
            batch.map((r) => r.txIndex),
            batch.map((r) => r.logIndex),
            batch.map((r) => r.address),
            batch.map((r) => r.source),
            batch.map((r) => r.eventName),
            batch.map((r) => (r.args === null ? null : JSON.stringify(r.args))),
            batch.map((r) => r.topics.join(",")),
            batch.map((r) => r.data),
          ],
        );
        count += r.rowCount ?? 0;
      }
      if (advance) {
        const cur = await db.query(
          "SELECT last_indexed_block, last_finalized_block FROM cursors WHERE deployment_id = $1 FOR UPDATE",
          [dep.id],
        );
        const c = cur.rows[0];
        if (!c) throw new Error(`no cursor for ${dep.id}`);
        const last = BigInt(c.last_indexed_block);
        // Only a range that continues the indexed one moves the cursor (never past a gap).
        if (from <= last + 1n && to > last) {
          const fin = maxBig(BigInt(c.last_finalized_block), minBig(to, opts.finalized ?? -1n));
          await db.query(
            `UPDATE cursors SET last_indexed_block = $2, last_indexed_hash = $3, last_finalized_block = $4,
               updated_at = now() WHERE deployment_id = $1`,
            [dep.id, to.toString(), tip.hash.toLowerCase(), fin.toString()],
          );
        }
      }
      return count;
    });
    return { logs: rows.length, inserted, vaultsFound: found.size };
  }
}
