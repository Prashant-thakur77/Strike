import type pg from "pg";
import type { Logger } from "pino";
import { WRITER_LOCK_KEY, createClient } from "./db.js";

/** Thrown when this process tries to write without holding the writer lock. */
export class NotWriterError extends Error {
  constructor(message = "this instance does not hold the writer lock") {
    super(message);
    this.name = "NotWriterError";
  }
}

/**
 * The single writer. It holds a session-level Postgres advisory lock on its own connection and runs every write
 * transaction on that same connection, so writes can only happen while the lock is held: if the connection drops,
 * Postgres releases the lock and the writes fail with it. A second instance's `acquire()` returns false; it serves
 * the API read-only and tries again later. Transactions are queued, so chains indexed concurrently never interleave
 * statements on the shared connection.
 */
export class Writer {
  private client: pg.Client | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private releasing = false;

  constructor(
    private readonly databaseUrl: string,
    private readonly log?: Logger,
    private readonly onLost?: (err: Error) => void,
  ) {}

  get held(): boolean {
    return this.client !== null;
  }

  /** Try to become the writer. True when this instance now holds the lock (or already did). */
  async acquire(): Promise<boolean> {
    if (this.client) return true;
    const client = createClient(this.databaseUrl);
    let settled = false;
    const lost = (err: Error) => {
      if (!settled || this.client !== client) return;
      this.client = null;
      if (!this.releasing) {
        this.log?.error({ err: err.message }, "writer connection lost; the lock is released");
        this.onLost?.(err);
      }
    };
    client.on("error", lost);
    client.on("end", () => lost(new Error("writer connection closed")));
    await client.connect();
    const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [
      WRITER_LOCK_KEY,
    ]);
    if (!rows[0]?.ok) {
      await client.end().catch(() => {});
      return false;
    }
    settled = true;
    this.client = client;
    this.releasing = false;
    return true;
  }

  /** Run `fn` in a transaction on the writer's connection. Throws {@link NotWriterError} when the lock is not held. */
  tx<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const c = this.client;
      if (!c) throw new NotWriterError();
      await c.query("BEGIN");
      try {
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Release the lock and close the connection (after queued transactions finish). */
  async release(): Promise<void> {
    const c = this.client;
    if (!c) return;
    this.releasing = true;
    await this.queue;
    await c.query("SELECT pg_advisory_unlock($1)", [WRITER_LOCK_KEY]).catch(() => {});
    this.client = null;
    await c.end().catch(() => {});
  }
}
