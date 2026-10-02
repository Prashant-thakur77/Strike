import { afterEach, describe, expect, it } from "vitest";
import { ReorgDuringRead } from "../src/ingest.js";
import {
  ABI,
  ALICE,
  CAROL,
  type Harness,
  POPULATED_EVENTS,
  SERIES_ID,
  addr,
  counts,
  encodeLog,
  eventDigest,
  harness,
} from "./helpers.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const dep = (x: Harness) => x.spec.deployments[0]!;

describe("ingestion", () => {
  it("stores every log of the deployment's contracts and of the vaults it creates, decoded", async () => {
    h = await harness();
    const r = await h.ix.ingestRange(dep(h), 1000n, 1020n);
    expect(r).toMatchObject({
      chunks: 1,
      logs: POPULATED_EVENTS,
      inserted: POPULATED_EVENTS,
      vaultsFound: 2,
    });
    expect(await counts(h.pool)).toEqual({
      events: POPULATED_EVENTS,
      raw: 1,
      blocks: 13,
      contracts: 7,
      discovered: 2,
    });

    const byName = await h.pool.query(
      "SELECT source, event_name, count(*)::int AS n FROM events GROUP BY 1, 2 ORDER BY 1, 2",
    );
    expect(byName.rows).toContainEqual({ source: "vault", event_name: "Deposit", n: 2 });
    expect(byName.rows).toContainEqual({ source: "agentRegistry", event_name: "AgentRegistered", n: 2 });
    expect(byName.rows).toContainEqual({ source: "mirrorFeed", event_name: "AnswerUpdated", n: 2 });
    expect(byName.rows).toContainEqual({ source: "epochManager", event_name: null, n: 1 });

    // Arguments as exact decimal strings and lowercase addresses; times from the block headers.
    const buy = await h.pool.query("SELECT * FROM events WHERE event_name = 'OptionsBought'");
    expect(buy.rows[0].args).toEqual({
      seriesId: SERIES_ID.toString(),
      buyer: CAROL.toLowerCase(),
      recipient: CAROL.toLowerCase(),
      amount: "4000000000000000000",
      premium: "7383870",
    });
    expect(Number(buy.rows[0].block_number)).toBe(1008);
    expect(buy.rows[0].block_hash).toBe(h.fake.hashOf(1008n));
    expect(new Date(buy.rows[0].block_time).getTime()).toBe((1_790_000_000 + 1008 * 2) * 1000);

    // The derived views read the same rows.
    const epochs = await h.pool.query("SELECT vault, epoch, state, series_id FROM v_epochs ORDER BY vault");
    expect(epochs.rows.map((r) => r.state).sort()).toEqual(["aborted", "settled"]);
    const agents = await h.pool.query("SELECT agent_id, signer, erc8004_id, bonded, slashed FROM v_agents");
    expect(agents.rows).toEqual([
      {
        agent_id: "1",
        signer: expect.any(String),
        erc8004_id: "114",
        bonded: "60000000",
        slashed: "10000000",
      },
    ]);
    const pushes = await h.pool.query("SELECT symbol, answer FROM v_mirror_pushes ORDER BY round_id");
    expect(pushes.rows).toEqual([
      { symbol: "TSLA", answer: "36936000000" },
      { symbol: "TSLA", answer: "37010000000" },
    ]);
    const flows = await h.pool.query(
      "SELECT kind, count(*)::int AS n FROM v_vault_flows GROUP BY 1 ORDER BY 1",
    );
    expect(flows.rows).toEqual([
      { kind: "Deposit", n: 2 },
      { kind: "DepositRequested", n: 1 },
      { kind: "RedeemRequested", n: 1 },
      { kind: "Withdraw", n: 1 },
    ]);
    const slashes = await h.pool.query("SELECT amount, reason, epoch FROM v_slashes");
    expect(slashes.rows).toEqual([{ amount: "10000000", reason: 3, epoch: 1 }]);
  });

  it("is idempotent: the same range twice leaves the same rows", async () => {
    h = await harness();
    await h.ix.ingestRange(dep(h), 1000n, 1020n);
    const first = { counts: await counts(h.pool), digest: await eventDigest(h.pool) };
    const again = await h.ix.ingestRange(dep(h), 1000n, 1020n);
    expect(again.logs).toBe(POPULATED_EVENTS);
    expect(again.inserted).toBe(0);
    expect({ counts: await counts(h.pool), digest: await eventDigest(h.pool) }).toEqual(first);
  });

  it("stores overlapping ranges once, the same as one range", async () => {
    h = await harness();
    await h.ix.ingestRange(dep(h), 1000n, 1020n);
    const whole = { counts: await counts(h.pool), digest: await eventDigest(h.pool) };
    await h.close();

    h = await harness();
    const a = await h.ix.ingestRange(dep(h), 1000n, 1007n);
    const b = await h.ix.ingestRange(dep(h), 1004n, 1020n);
    expect(a.inserted + b.inserted).toBe(POPULATED_EVENTS);
    expect(a.logs + b.logs).toBeGreaterThan(POPULATED_EVENTS); // blocks 1004-1007 were read twice
    expect({ counts: await counts(h.pool), digest: await eventDigest(h.pool) }).toEqual(whole);
    const cur = await h.pool.query("SELECT last_indexed_block, last_indexed_hash FROM cursors");
    expect(cur.rows[0]).toEqual({ last_indexed_block: 1020, last_indexed_hash: h.fake.hashOf(1020n) });
  });

  it("never moves the cursor past a gap", async () => {
    h = await harness();
    await h.ix.ingestRange(dep(h), 1000n, 1003n);
    await h.ix.ingestRange(dep(h), 1010n, 1020n);
    const cur = await h.pool.query("SELECT last_indexed_block FROM cursors");
    expect(cur.rows[0].last_indexed_block).toBe(1003);
  });

  it("halves a range the RPC refuses and still reads every log", async () => {
    h = await harness({ maxRange: 64n });
    h.fake.maxRange = 5n;
    const r = await h.ix.ingestRange(dep(h), 1000n, 1050n);
    expect(r.inserted).toBe(POPULATED_EVENTS);
    expect(h.fake.calls.refused).toBeGreaterThan(0);
    expect(r.chunks).toBeGreaterThan(10);
  });

  it("retries a failing RPC with backoff", async () => {
    h = await harness();
    h.fake.failNext = 2;
    const r = await h.ix.ingestRange(dep(h), 1000n, 1020n);
    expect(r.inserted).toBe(POPULATED_EVENTS);
  });

  it("gives up after the retries and leaves the cursor where it was", async () => {
    h = await harness();
    h.fake.failNext = 10;
    await expect(h.ix.ingestRange(dep(h), 1000n, 1020n)).rejects.toThrow("socket hang up");
    const cur = await h.pool.query("SELECT last_indexed_block FROM cursors");
    expect(cur.rows[0].last_indexed_block).toBe(999);
    expect((await counts(h.pool)).events).toBe(0);
  });

  it("indexes up to head - confirmations on each tick, and the rest once it is deep enough", async () => {
    h = await harness({ head: 1010n, confirmations: 5n });
    const t1 = await h.ix.tick();
    expect(t1.target).toBe(1005n);
    expect(
      Number((await h.pool.query("SELECT last_indexed_block FROM cursors")).rows[0].last_indexed_block),
    ).toBe(1005);
    const n1 = (await counts(h.pool)).events;
    expect(n1).toBe(9); // blocks 1001-1005
    h.fake.head = 1030n;
    const t2 = await h.ix.tick();
    expect(t2.target).toBe(1025n);
    expect((await counts(h.pool)).events).toBe(POPULATED_EVENTS);
    const heads = await h.pool.query("SELECT head_block FROM chain_heads");
    expect(heads.rows[0].head_block).toBe(1030);
  });

  it("backfills a contract added to the config after its deployment was indexed", async () => {
    h = await harness();
    await h.ix.tick();
    const extraFeed = addr("extra-feed");
    h.fake.add(
      extraFeed,
      encodeLog(ABI.mirrorFeed, "AnswerUpdated", { current: 1n, roundId: 1n, updatedAt: 2n }),
      1003n,
    );
    dep(h).contracts.push({ address: extraFeed.toLowerCase(), kind: "mirrorFeed", label: "NVDA" });
    await h.ix.sync();
    const pushes = await h.pool.query("SELECT symbol FROM v_mirror_pushes ORDER BY block_number");
    expect(pushes.rows.map((r) => r.symbol)).toEqual(["NVDA", "TSLA", "TSLA"]);
  });

  it("refuses a deployment record that changed under the same id", async () => {
    h = await harness();
    dep(h).epochManager = addr("another-em").toLowerCase();
    await expect(h.ix.sync()).rejects.toThrow("is not the one indexed");
  });
});

describe("reorgs", () => {
  it("roll back above the fork point and re-index the new blocks", async () => {
    h = await harness({ head: 1030n });
    await h.ix.tick(); // indexed to 1025
    const before = await h.pool.query("SELECT tx_hash FROM events WHERE event_name = 'OptionsBought'");
    expect(before.rows).toHaveLength(1);

    // Blocks from 1008 on are replaced: the buy moves to 1009 in another transaction, ALICE buys too, and the
    // decision record, rounds, withdrawal and settlement are gone.
    const dropped = h.fake.reorg(1008n);
    expect(dropped.length).toBe(9);
    const buyer = addr("dave");
    h.fake.add(
      h.a.epochManager,
      encodeLog(ABI.epochManager, "OptionsBought", {
        seriesId: SERIES_ID,
        buyer,
        recipient: buyer,
        amount: 2n * 10n ** 18n,
        premium: 3_000_000n,
      }),
      1009n,
    );
    h.fake.add(
      h.a.epochManager,
      encodeLog(ABI.epochManager, "OptionsBought", {
        seriesId: SERIES_ID,
        buyer: ALICE,
        recipient: ALICE,
        amount: 10n ** 18n,
        premium: 1_500_000n,
      }),
      1012n,
    );

    const t = await h.ix.tick();
    expect(t.reorg).toEqual({ forkBlock: 1007n, eventsRemoved: 9 });
    const buys = await h.pool.query(
      "SELECT block_number, args ->> 'buyer' AS buyer FROM events WHERE event_name = 'OptionsBought' ORDER BY block_number",
    );
    expect(buys.rows).toEqual([
      { block_number: 1009, buyer: buyer.toLowerCase() },
      { block_number: 1012, buyer: ALICE.toLowerCase() },
    ]);
    expect((await counts(h.pool)).events).toBe(POPULATED_EVENTS - 9 + 2);
    // Every stored event's block hash is the chain's current one.
    const stale = await h.pool.query("SELECT block_number, block_hash FROM events");
    for (const r of stale.rows) expect(r.block_hash).toBe(h.fake.hashOf(BigInt(r.block_number)));
    const cur = await h.pool.query("SELECT last_indexed_block, last_indexed_hash FROM cursors");
    expect(cur.rows[0]).toEqual({ last_indexed_block: 1025, last_indexed_hash: h.fake.hashOf(1025n) });
    const log = await h.pool.query("SELECT stale_block, fork_block, events_removed FROM reorgs");
    expect(log.rows).toEqual([{ stale_block: 1025, fork_block: 1007, events_removed: 9 }]);
  });

  it("roll back a vault found in a replaced block", async () => {
    h = await harness({ head: 1030n });
    await h.ix.tick();
    h.fake.reorg(1002n); // the put vault's VaultCreated (1002) and everything after it are gone
    await h.ix.tick();
    const vaults = await h.pool.query("SELECT vault FROM v_vaults");
    expect(vaults.rows.map((r) => r.vault)).toEqual([h.a.callVault.toLowerCase()]);
    const c = await counts(h.pool);
    expect(c.discovered).toBe(1);
    expect(c.events).toBe(2); // the call vault's VaultCreated and VaultRegistered at 1001
  });

  it("are no-ops when the stored tip still matches", async () => {
    h = await harness({ head: 1030n });
    await h.ix.tick();
    const digest = await eventDigest(h.pool);
    h.fake.reorg(1027n); // above the indexed tip (1025): nothing stored is affected
    const t = await h.ix.tick();
    expect(t.reorg).toBeNull();
    expect(await eventDigest(h.pool)).toBe(digest);
  });

  it("stop a chunk whose previous block changed after the check", async () => {
    h = await harness({ head: 1030n });
    await h.ix.ingestRange(dep(h), 1000n, 1010n);
    h.fake.reorg(1005n);
    await expect(h.ix.ingestRange(dep(h), 1011n, 1020n)).rejects.toThrow(ReorgDuringRead);
    const cur = await h.pool.query("SELECT last_indexed_block FROM cursors");
    expect(cur.rows[0].last_indexed_block).toBe(1010);
    // The next tick finds the fork and re-reads from it.
    const t = await h.ix.tick();
    expect(t.reorg?.forkBlock).toBe(1004n);
    const stale = await h.pool.query("SELECT block_number, block_hash FROM events");
    for (const r of stale.rows) expect(r.block_hash).toBe(h.fake.hashOf(BigInt(r.block_number)));
  });

  it("never look below the finalized block", async () => {
    h = await harness({ head: 1030n });
    h.fake.finalized = 1020n;
    await h.ix.tick();
    const cur = await h.pool.query("SELECT last_finalized_block FROM cursors");
    expect(cur.rows[0].last_finalized_block).toBe(1020);
    const blocks = await h.pool.query("SELECT min(number)::int AS lo FROM blocks");
    expect(blocks.rows[0].lo).toBeGreaterThanOrEqual(1020); // hashes below the finalized block are pruned
  });
});
