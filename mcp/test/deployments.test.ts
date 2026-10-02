import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type SeriesState, type StrikeClient, type VaultState, WAD } from "@strike/sdk";
import { type Address, getAddress } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { type DeploymentClient, createStrikeMcpServer } from "../src/server.js";

// The read tools over several deployments of one chain (the remote endpoint's default: v2 and v3 on Robinhood Chain
// testnet). Each deployment is a stub client; a vault's manager() names its deployment.

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const EM_V2 = addr(0xe2);
const EM_V3 = addr(0xe3);
const TSLA = addr(0x51);
const V2_CC = addr(0x2001);
const V2_PUT = addr(0x2002);
const V3_CC = addr(0x3001);
const V3_PUT = addr(0x3002);
const MONDAY = 1_791_212_400n;
const FRIDAY = 1_791_576_000n;
const mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 691_200,
};

const putSeriesV3: SeriesState = {
  id: 77n,
  vault: V3_PUT,
  underlying: TSLA,
  agentId: 2n,
  expiry: FRIDAY,
  premiumBps: 10_000,
  isCall: false,
  settled: false,
  cancelled: false,
  strike: 350n * WAD,
  size: 20n * WAD,
  sold: 0n,
  premium: 0n,
  collateral: 0n,
  settlementPrice: 0n,
  payoutPerOption: 0n,
  escrow: 0n,
};

function vaultAt(address: Address, symbol: string, isCall: boolean, agentId: bigint): VaultState {
  const series = address === V3_PUT ? putSeriesV3 : null;
  return {
    address,
    name: `Strike TSLA ${isCall ? "Covered Call" : "Cash-Secured Put"}`,
    symbol,
    decimals: 18,
    kind: isCall ? "covered-call" : "cash-secured-put",
    isCall,
    asset: TSLA,
    assetSymbol: "TSLA",
    assetDecimals: 18,
    underlying: TSLA,
    underlyingSymbol: "TSLA",
    underlyingDecimals: 18,
    premiumToken: addr(0xd6),
    totalAssets: 10n * WAD,
    totalSupply: 10n * WAD,
    pricePerShare: WAD,
    depositCap: 10_000n * WAD,
    locked: series !== null,
    currentEpoch: series ? 1n : 0n,
    lastProcessedEpoch: 0n,
    pendingDepositAssets: 0n,
    pendingRedeemShares: 0n,
    curator: addr(0xa9),
    agentId,
    mandate,
    sigma: 600_000_000_000_000_000n,
    compensation: 0n,
    epoch: series
      ? { state: "Selling", openedAt: MONDAY, seriesId: series.id }
      : { state: "Idle", openedAt: 0n, seriesId: 0n },
    series,
  };
}

const vaultsOf = {
  [EM_V2]: [vaultAt(V2_CC, "sTSLA-CC", true, 1n), vaultAt(V2_PUT, "sTSLA-CSP-A2", false, 2n)],
  [EM_V3]: [vaultAt(V3_CC, "sTSLA-CC", true, 1n), vaultAt(V3_PUT, "sTSLA-CSP", false, 2n)],
} as Record<Address, VaultState[]>;
const managerOf = new Map<Address, Address>([
  [V2_CC, EM_V2],
  [V2_PUT, EM_V2],
  [V3_CC, EM_V3],
  [V3_PUT, EM_V3],
]);

/** A stub client bound to one EpochManager: it knows only that deployment's vaults and series. */
function stub(em: Address, opts: { listFails?: boolean } = {}) {
  const used: string[] = [];
  const mine = vaultsOf[em] ?? [];
  const own = (a: Address) => {
    const v = mine.find((x) => x.address === getAddress(a));
    if (!v) throw new Error(`${a} is not a registered Strike vault`);
    return v;
  };
  const client = {
    chainId: 46630,
    addresses: { epochManager: em, usdg: addr(0xd6) },
    viem: {
      publicClient: {
        readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
          if (functionName !== "manager") throw new Error(`unexpected read ${functionName}`);
          const m = managerOf.get(getAddress(address));
          if (!m) throw new Error("execution reverted");
          return m;
        },
      },
      walletClient: undefined,
    },
    listVaults: async () => {
      used.push("listVaults");
      if (opts.listFails) throw new Error("HTTP request failed: 503");
      return mine;
    },
    getVault: async (a: Address) => {
      used.push(`getVault:${a}`);
      return own(a);
    },
    getSeries: async (id: bigint) =>
      mine.map((v) => v.series).find((s): s is SeriesState => s?.id === id) ?? null,
    oracleStatus: async () => ({ status: "Ok", ok: true, price: 369n * WAD, updatedAt: MONDAY - 60n }),
    marketOpen: async () => true,
    blockTimestamp: async () => MONDAY,
    nextExpiry: async () => FRIDAY,
    saleCutoff: async () => 3600,
    usdgDecimals: async () => 6,
    quoteBuy: async (id: bigint, amount: bigint) => {
      used.push(`quoteBuy:${id}`);
      return { premium: (amount * 1_500_000n) / WAD, collateral: amount };
    },
    getAgent: async (id: bigint) => ({
      agentId: id,
      status: "Active",
      active: true,
      signer: addr(0xa9),
      bond: 50_000_000n,
      strikes: 0,
    }),
    agentStats: async (id: bigint) => {
      used.push(`agentStats:${id}`);
      return {
        agentId: id,
        owner: addr(0xa9),
        signer: addr(0xa9),
        payout: addr(0xa9),
        status: "Active",
        active: true,
        erc8004Id: 0n,
        bond: 50_000_000n,
        unbonding: 0n,
        strikes: 0,
        accepted: em === EM_V3 ? 1 : 0,
        rejected: 0,
        proposals: em === EM_V3 ? 1 : 0,
        acceptanceRate: em === EM_V3 ? 1 : null,
        strikesLeft: 3,
        rejectionsUntilInactive: 3,
        settledEpochs: 0,
        cumulativePnl: 0n,
        claimableFees: 0n,
        params: {
          minBond: 50_000_000n,
          slashAmount: 10_000_000n,
          maxStrikes: 3,
          reputationRegistry: addr(0),
        },
      };
    },
  };
  return { client: client as unknown as StrikeClient, used };
}

let mcp: Client | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
});

async function connect(deployments: DeploymentClient[]) {
  const server = createStrikeMcpServer({
    chainId: 46630,
    readOnly: true,
    client: () => deployments[0]!.client,
    deployments: () => deployments,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  mcp = new Client({ name: "strike-deployments-test", version: "0.0.0" });
  await mcp.connect(a);
  await mcp.listTools(); // caches the output schemas, so the client validates every structured result
  return mcp;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
  return {
    r,
    out: r.structuredContent as Record<string, any>,
    text: (r.content[0] as { text: string }).text,
  };
}

function twoDeployments(opts: { v3ListFails?: boolean } = {}) {
  const v2 = stub(EM_V2);
  const v3 = stub(EM_V3, { listFails: opts.v3ListFails });
  return {
    v2,
    v3,
    deployments: [
      { version: "v2", client: v2.client },
      { version: "v3", client: v3.client },
    ],
  };
}

describe("read tools over every deployment of a chain", () => {
  it("list_vaults lists both deployments' vaults, each labelled with its chain and version", async () => {
    const { deployments } = twoDeployments();
    const { r, out } = await call(await connect(deployments), "list_vaults");
    expect(r.isError).toBeFalsy();
    expect(out.chainId).toBe(46630);
    expect(out.deployments).toEqual([
      { chainId: 46630, version: "v2", epochManager: EM_V2, default: true, vaults: 2, error: null },
      { chainId: 46630, version: "v3", epochManager: EM_V3, default: false, vaults: 2, error: null },
    ]);
    expect(out.vaults.map((v: any) => [v.symbol, v.version, v.chainId, v.address])).toEqual([
      ["sTSLA-CC", "v2", 46630, V2_CC],
      ["sTSLA-CSP-A2", "v2", 46630, V2_PUT],
      ["sTSLA-CC", "v3", 46630, V3_CC],
      ["sTSLA-CSP", "v3", 46630, V3_PUT],
    ]);
  });

  it("list_vaults still lists the other deployments when one cannot be read", async () => {
    const { deployments } = twoDeployments({ v3ListFails: true });
    const { r, out } = await call(await connect(deployments), "list_vaults");
    expect(r.isError).toBeFalsy();
    expect(out.vaults.map((v: any) => v.version)).toEqual(["v2", "v2"]);
    expect(out.deployments[1]).toMatchObject({
      version: "v3",
      vaults: 0,
      error: expect.stringMatching(/503/),
    });
  });

  it("strike_info names the deployments it reads", async () => {
    const { deployments } = twoDeployments();
    const { out } = await call(await connect(deployments), "strike_info");
    expect(out).toMatchObject({ chainId: 46630, mode: "read-only", deployed: true });
    expect(out.deployments).toEqual([
      { chainId: 46630, version: "v2", epochManager: EM_V2, default: true },
      { chainId: 46630, version: "v3", epochManager: EM_V3, default: false },
    ]);
  });

  it("vault_state reads a v3 vault through the v3 deployment its manager() names", async () => {
    const { deployments, v2, v3 } = twoDeployments();
    const { r, out } = await call(await connect(deployments), "vault_state", { vault: V3_PUT });
    expect(r.isError).toBeFalsy();
    expect(out.vault).toMatchObject({ address: V3_PUT, symbol: "sTSLA-CSP", version: "v3", chainId: 46630 });
    expect(out.agent.agentId).toBe("2");
    expect(v3.used).toContain(`getVault:${V3_PUT}`);
    expect(v2.used.filter((u) => u.startsWith("getVault"))).toEqual([]);
  });

  it("a share symbol in both deployments means the default deployment's vault; one only in v3 is found there", async () => {
    const { deployments } = twoDeployments();
    const c = await connect(deployments);
    const shared = await call(c, "vault_state", { vault: "sTSLA-CC" });
    expect(shared.out.vault).toMatchObject({ address: V2_CC, version: "v2" });
    const onlyV3 = await call(c, "vault_state", { vault: "stsla-csp" });
    expect(onlyV3.out.vault).toMatchObject({ address: V3_PUT, version: "v3" });
    const unknown = await call(c, "vault_state", { vault: "sNVDA-CC" });
    expect(unknown.r.isError).toBe(true);
    expect(unknown.text).toMatch(/unknown vault "sNVDA-CC".*sTSLA-CSP \(v3\)/);
  });

  it("refuses an address that is no deployment's vault, naming the deployments", async () => {
    const { deployments } = twoDeployments();
    const { r, text } = await call(await connect(deployments), "vault_state", { vault: addr(0xbad) });
    expect(r.isError).toBe(true);
    expect(text).toMatch(/is not a vault of a Strike deployment on chain 46630 \(deployments: v2, v3\)/);
  });

  it("quote finds a series id in the deployment that has it", async () => {
    const { deployments, v2, v3 } = twoDeployments();
    const { r, out } = await call(await connect(deployments), "quote", { seriesId: "77", amount: "2" });
    expect(r.isError).toBeFalsy();
    expect(out).toMatchObject({ seriesId: "77", vault: V3_PUT, premium: "3" });
    expect(v3.used).toContain("quoteBuy:77");
    expect(v2.used.some((u) => u.startsWith("quoteBuy"))).toBe(false);
  });

  it("hedge_plan considers every deployment's vaults on the stock and buys from the one on sale", async () => {
    const { deployments, v3 } = twoDeployments();
    const { r, out } = await call(await connect(deployments), "hedge_plan", { position: "10 TSLA" });
    expect(r.isError).toBeFalsy();
    expect(out.considered.map((x: any) => [x.vaultSymbol, x.version, x.usable])).toEqual([
      ["sTSLA-CC", "v2", false],
      ["sTSLA-CSP-A2", "v2", false],
      ["sTSLA-CC", "v3", false],
      ["sTSLA-CSP", "v3", true],
    ]);
    expect(out.hedge).toMatchObject({ vault: V3_PUT, version: "v3", seriesId: "77", options: "10" });
    // A vault outside the default deployment is named by address: its symbol is also a v2 vault's.
    expect(out.explanation).toContain(`buy_options { "vault": "${V3_PUT}"`);
    expect(v3.used).toContain("quoteBuy:77");
  });

  it("agent_stats reads an agent id in the deployment asked for, or the vault's own", async () => {
    const { deployments, v2, v3 } = twoDeployments();
    const c = await connect(deployments);
    const byDefault = await call(c, "agent_stats", { agentId: 2 });
    expect(byDefault.out).toMatchObject({ agentId: "2", version: "v2", proposals: 0 });
    const byVersion = await call(c, "agent_stats", { agentId: 2, version: "v3" });
    expect(byVersion.out).toMatchObject({ agentId: "2", version: "v3", proposals: 1 });
    const byVault = await call(c, "agent_stats", { vault: V3_PUT });
    expect(byVault.out).toMatchObject({ agentId: "2", version: "v3" });
    expect(v2.used.filter((u) => u.startsWith("agentStats"))).toEqual(["agentStats:2"]);
    expect(v3.used.filter((u) => u.startsWith("agentStats"))).toEqual(["agentStats:2", "agentStats:2"]);
    const missing = await call(c, "agent_stats", { agentId: 2, version: "v4" });
    expect(missing.r.isError).toBe(true);
    expect(missing.text).toMatch(/no v4 deployment here; this server reads v2, v3/);
  });

  it("a single client keeps the old behaviour: no manager() reads, its version from the SDK's map", async () => {
    const v2 = stub(EM_V2);
    const server = createStrikeMcpServer({ chainId: 46630, readOnly: true, client: () => v2.client });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    mcp = new Client({ name: "strike-deployments-test", version: "0.0.0" });
    await mcp.connect(a);
    await mcp.listTools();
    const { out } = await call(mcp, "list_vaults");
    // EM_V2 is a stub address, not in the SDK's map, so the version is unknown.
    expect(out.deployments).toEqual([
      { chainId: 46630, version: null, epochManager: EM_V2, default: true, vaults: 2, error: null },
    ]);
    const state = await call(mcp, "vault_state", { vault: V2_PUT });
    expect(state.out.vault).toMatchObject({ address: V2_PUT, version: null });
  });
});
