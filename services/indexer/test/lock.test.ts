import { afterEach, describe, expect, it } from "vitest";
import { ChainIndexer } from "../src/ingest.js";
import { NotWriterError, Writer } from "../src/writer.js";
import { type Harness, counts, harness, silent } from "./helpers.js";

let h: Harness | null = null;
const extra: Writer[] = [];
afterEach(async () => {
  for (const w of extra.splice(0)) await w.release();
  await h?.close();
  h = null;
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("single writer", () => {
  it("refuses a second writer while the first holds the lock", async () => {
    h = await harness();
    expect(h.writer.held).toBe(true);
    const second = new Writer(h.url, silent);
    extra.push(second);
    expect(await second.acquire()).toBe(false);
    expect(second.held).toBe(false);
    await expect(second.tx((db) => db.query("SELECT 1"))).rejects.toBeInstanceOf(NotWriterError);

    // An indexer on the refused writer cannot write anything.
    const ix = new ChainIndexer({
      chain: h.spec,
      reader: h.fake,
      writer: second,
      pool: h.pool,
      log: silent,
      confirmations: 5n,
      maxRange: 1000n,
    });
    await expect(ix.ingestRange(h.spec.deployments[0]!, 1000n, 1020n)).rejects.toBeInstanceOf(NotWriterError);
    await expect(ix.tick()).rejects.toBeInstanceOf(NotWriterError);
    expect((await counts(h.pool)).events).toBe(0);
  });

  it("hands over when the writer releases the lock", async () => {
    h = await harness();
    const second = new Writer(h.url, silent);
    extra.push(second);
    expect(await second.acquire()).toBe(false);
    await h.writer.release();
    expect(h.writer.held).toBe(false);
    expect(await second.acquire()).toBe(true);
    await expect(h.writer.tx((db) => db.query("SELECT 1"))).rejects.toBeInstanceOf(NotWriterError);
  });

  it("stops writing when its connection dies (Postgres frees the lock with it)", async () => {
    h = await harness();
    let lost = false;
    const first = new Writer(h.url, silent, () => {
      lost = true;
    });
    await h.writer.release();
    expect(await first.acquire()).toBe(true);
    extra.push(first);
    const locks = await h.pool.query(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    expect(locks.rows).toHaveLength(1);
    await h.pool.query("SELECT pg_terminate_backend($1)", [locks.rows[0].pid]);
    await until(() => !first.held);
    expect(lost).toBe(true);
    await expect(first.tx((db) => db.query("SELECT 1"))).rejects.toBeInstanceOf(NotWriterError);
    const second = new Writer(h.url, silent);
    extra.push(second);
    expect(await second.acquire()).toBe(true);
  });

  it("queues transactions so concurrent chains never interleave on the one connection", async () => {
    h = await harness();
    const order: string[] = [];
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        h!.writer.tx(async (db) => {
          order.push(`${name}:begin`);
          await db.query("SELECT pg_sleep(0.02)");
          order.push(`${name}:end`);
        }),
      ),
    );
    expect(order).toEqual(["a:begin", "a:end", "b:begin", "b:end", "c:begin", "c:end"]);
  });
});
