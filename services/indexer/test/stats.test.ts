import {
  agentRegistryAbi,
  decisionLogAbi,
  epochManagerAbi,
  strikeVaultAbi,
  vaultFactoryAbi,
} from "@strike/sdk";
import type pg from "pg";
import { type Abi, type Hex, decodeEventLog } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareStats } from "../src/compare.js";
import type { DeploymentSpec } from "../src/config.js";
import { createPool, migrate } from "../src/db.js";
import { ChainIndexer } from "../src/ingest.js";
import { CHAIN_LABELS, TEAM_WALLETS } from "../src/meta.js";
import { type UsageStats, readStats } from "../src/stats.js";
import { type StateReader, refreshTvl } from "../src/tvl.js";
import { Writer } from "../src/writer.js";
import {
  ALICE,
  type Addrs,
  CAROL,
  FakeChain,
  addr,
  addrs,
  chainSpec,
  deploymentSpec,
  freshDb,
  populate,
  silent,
} from "./helpers.js";

// The indexer's /stats against the app's own counter (app/src/lib/usage/aggregate.ts `aggregateUsage`), run on the
// same logs: three deployments on two chains, team and outside wallets, a wallet active on both chains, a vault
// that cannot be valued. Every field must be equal.

const fromApp = (p: string) => new URL(`../../../app/src/lib/usage/${p}`, import.meta.url).pathname;

interface AppUsageLog {
  source: string;
  address: string;
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: string;
  blockNumber: bigint;
  logIndex: number;
}
interface AppAggregate {
  aggregateUsage: (inputs: unknown[], opts?: { generatedAt?: Date }) => Omit<UsageStats, "indexer">;
}

// The app decodes the registry with the v2 ABI and reads no feed logs (src/lib/usage/scan.ts).
const APP_ABI: Record<string, Abi> = {
  epochManager: epochManagerAbi as Abi,
  vaultFactory: vaultFactoryAbi as Abi,
  agentRegistry: agentRegistryAbi as Abi,
  decisionLog: decisionLogAbi as Abi,
  vault: strikeVaultAbi as Abi,
};

/** The app's DeploymentInput for one deployment, decoded the app's way from the fake chain's logs. */
function appInput(
  fake: FakeChain,
  dep: DeploymentSpec,
  a: Addrs,
  name: string,
  short: string,
  toBlock: bigint,
  tvlUsd: number | null,
) {
  const source = new Map<string, string>([
    [a.epochManager.toLowerCase(), "epochManager"],
    [a.vaultFactory.toLowerCase(), "vaultFactory"],
    [a.agentRegistry.toLowerCase(), "agentRegistry"],
    [a.decisionLog.toLowerCase(), "decisionLog"],
    [a.callVault.toLowerCase(), "vault"],
    [a.putVault.toLowerCase(), "vault"],
  ]);
  const logs: AppUsageLog[] = [];
  for (const l of fake.allLogs()) {
    const s = source.get(l.address);
    if (!s || l.blockNumber > toBlock) continue;
    try {
      const d = decodeEventLog({
        abi: APP_ABI[s]!,
        data: l.data,
        topics: l.topics as [Hex, ...Hex[]],
        strict: true,
      });
      logs.push({
        source: s,
        address: l.address,
        eventName: d.eventName ?? "",
        args: (d.args ?? {}) as Record<string, unknown>,
        transactionHash: l.transactionHash,
        blockNumber: l.blockNumber,
        logIndex: l.logIndex,
      });
    } catch {
      // not counted by the app
    }
  }
  return {
    chainId: dep.chainId,
    chainName: name,
    chainShort: short,
    version: dep.version,
    explorer: "https://explorer.example",
    contracts: {
      epochManager: dep.epochManager,
      vaultFactory: dep.vaultFactory,
      agentRegistry: dep.agentRegistry,
      decisionLog: dep.decisionLog,
    },
    fromBlock: dep.deployBlock,
    toBlock,
    usdgDecimals: 6,
    logs,
    tvlUsd,
  };
}

describe("/stats", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let pool: pg.Pool;
  let writer: Writer;
  let ours: UsageStats;
  let theirs: Omit<UsageStats, "indexer">;

  beforeAll(async () => {
    db = await freshDb();
    pool = createPool(db.url, 4);
    await migrate(pool);
    writer = new Writer(db.url, silent);
    await writer.acquire();

    const rh = new FakeChain(46630, 3000n);
    const arb = new FakeChain(421614, 9000n);
    const [a2, a3, aArb] = [addrs("rh-v2"), addrs("rh-v3"), addrs("arb-v3")];
    populate(rh, a2, 1000n);
    populate(rh, a3, 2000n, { buyer: addr("dave") });
    populate(arb, aArb, 8000n); // CAROL buys here too: one wallet on two chains
    const d2 = deploymentSpec(46630, "v2", a2, 1000n);
    const d3 = deploymentSpec(46630, "v3", a3, 2000n);
    const dArb = deploymentSpec(421614, "v3", aArb, 8000n);
    const rhSpec = { ...chainSpec(46630, [d2, d3]), name: "Robinhood Chain testnet", short: "RH testnet" };
    const arbSpec = { ...chainSpec(421614, [dArb]), name: "Arbitrum Sepolia", short: "Arb Sepolia" };

    // Vault values: the Arbitrum put vault cannot be valued (spot 0), so that deployment's value is unknown.
    const values: Record<string, number | null> = {
      [a2.callVault.toLowerCase()]: 1000.5,
      [a2.putVault.toLowerCase()]: 932.9,
      [a3.callVault.toLowerCase()]: 900.25,
      [a3.putVault.toLowerCase()]: 943.15,
      [aArb.callVault.toLowerCase()]: 880.4,
      [aArb.putVault.toLowerCase()]: null,
    };
    const state: StateReader = {
      usdgDecimals: async () => 6,
      vaultValue: async (_dep, vault) => ({
        blockNumber: 1n,
        isCall: true,
        totalAssets: 1n,
        assetDecimals: 18,
        spotPrice: 1n,
        tvlUsd: values[vault] ?? null,
      }),
    };
    for (const [fake, spec] of [
      [rh, rhSpec],
      [arb, arbSpec],
    ] as const) {
      const ix = new ChainIndexer({
        chain: spec,
        reader: fake,
        writer,
        pool,
        log: silent,
        confirmations: 5n,
        maxRange: 100_000n,
        decimals: state,
      });
      await ix.sync();
      await ix.tick();
      await refreshTvl({ chain: spec, state, pool, writer, log: silent });
    }
    ours = await readStats(pool);

    const app = (await import(fromApp("aggregate.ts"))) as AppAggregate;
    const sum = (...xs: (number | null)[]) =>
      xs.some((x) => x === null) ? null : xs.reduce<number>((s, x) => s + x!, 0);
    theirs = app.aggregateUsage([
      appInput(rh, d2, a2, rhSpec.name, rhSpec.short, 2995n, sum(1000.5, 932.9)),
      appInput(rh, d3, a3, rhSpec.name, rhSpec.short, 2995n, sum(900.25, 943.15)),
      appInput(arb, dArb, aArb, arbSpec.name, arbSpec.short, 8995n, sum(880.4, null)),
    ]);
  });

  afterAll(async () => {
    await writer.release();
    await pool.end();
    await db.drop();
  });

  it("equals the app's counter on the same logs, field by field", () => {
    const { indexer, generatedAt: _g, ...rest } = ours;
    const { generatedAt: _t, ...app } = theirs;
    expect(app.deployments).toHaveLength(3);
    expect(app.outside).toHaveLength(4);
    expect(rest).toEqual(app);
    expect(indexer.source).toBe("indexer");
    expect(compareStats(ours, theirs)).toEqual([]);
  });

  it("counts what the fixture holds", () => {
    expect(ours.deployments.map((d) => d.key)).toEqual(["46630-v2", "46630-v3", "421614-v3"]);
    const d = ours.deployments[0]!;
    expect(d).toMatchObject({
      vaults: 2,
      epochsOpened: 2,
      epochsSettled: 1,
      epochsAborted: 1,
      proposalsAccepted: 1,
      proposalsRejected: 1,
      buys: 1,
      optionsBought: 4,
      premiumUsdg: 7.38387,
      slashedUsdg: 10,
      deposits: 2,
      queuedDeposits: 1,
      withdrawals: 2,
      agentsRegistered: 1, // AgentRegistered twice for the same id (identity link)
      bondsPosted: 1,
      bondedUsdg: 60,
      decisionRecords: 1,
      wallets: 5, // two team wallets, ALICE, BOB, CAROL; never the put vault that owned a deposit
      outsideWallets: 3,
      tvlUsd: 1933.4,
    });
    expect(ours.deployments[2]!.tvlUsd).toBeNull();
    expect(ours.total.wallets).toBe(6); // team x2, ALICE, BOB, CAROL (both chains), dave
    expect(ours.total.tvlUsd).toBe(3776.8);
    const carol = ours.outside.find((w) => w.address === CAROL.toLowerCase());
    expect(carol).toEqual({ address: CAROL.toLowerCase(), chains: [46630, 421614], roles: ["buyer"] });
    const alice = ours.outside.find((w) => w.address === ALICE.toLowerCase());
    expect(alice?.roles).toEqual(["depositor"]);
  });

  it("filters by chain", async () => {
    const arb = await readStats(pool, { chains: [421614] });
    expect(arb.deployments.map((d) => d.key)).toEqual(["421614-v3"]);
    expect(arb.total.vaults).toBe(2);
  });
});

describe("copied lists", () => {
  it("TEAM_WALLETS matches the app's", async () => {
    const team = (await import(fromApp("team.ts"))) as { TEAM_WALLETS: { address: string }[] };
    expect([...TEAM_WALLETS]).toEqual(team.TEAM_WALLETS.map((w) => w.address.toLowerCase()));
  });

  it("chain labels match the app's", async () => {
    const chains = (await import(new URL("../../../app/src/lib/chains.ts", import.meta.url).pathname)) as {
      CHAIN_META: Record<number, { label: string; short: string }>;
    };
    for (const [id, meta] of Object.entries(chains.CHAIN_META)) {
      expect(CHAIN_LABELS[Number(id)]).toEqual({ name: meta.label, short: meta.short });
    }
  });
});
