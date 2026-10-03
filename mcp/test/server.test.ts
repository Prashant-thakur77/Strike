import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_SHOCKS,
  type ProposalParams,
  type SeriesRisk,
  type SeriesState,
  type StrikeClient,
  type VaultState,
  WAD,
} from "@strike/sdk";
import { type Address, getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStrikeMcpServer } from "../src/server.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const VAULT = addr(0x1001);
const TSLA = addr(0x51);
const AGENT = addr(0xa9);
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
const vault: VaultState = {
  address: VAULT,
  name: "Strike TSLA Covered Call",
  symbol: "sTSLA-CC",
  decimals: 18,
  kind: "covered-call",
  isCall: true,
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
  locked: false,
  currentEpoch: 0n,
  lastProcessedEpoch: 0n,
  pendingDepositAssets: 0n,
  pendingRedeemShares: 0n,
  curator: AGENT,
  agentId: 1n,
  mandate,
  sigma: 600_000_000_000_000_000n,
  compensation: 0n,
  epoch: { state: "Idle", openedAt: 0n, seriesId: 0n },
  series: null,
};
const agent = {
  agentId: 1n,
  owner: AGENT,
  signer: AGENT,
  payout: AGENT,
  status: "Active",
  strikes: 0,
  accepted: 0,
  rejected: 0,
  unbondAt: 0n,
  erc8004Id: 0n,
  bond: 50_000_000n,
  unbonding: 0n,
  active: true,
  settledEpochs: 0,
  cumulativePnl: 0n,
};
const params = {
  minBond: 50_000_000n,
  slashAmount: 10_000_000n,
  maxStrikes: 3,
  unbondDelay: 691_200,
  identityRegistry: addr(0),
  reputationRegistry: addr(0),
};

/** A preview that rejects strikes below $380 for their ~0.49 delta and accepts the rest at 0.20. */
async function previewProposal(_vault: Address, p: ProposalParams) {
  const reckless = p.strike < 380n * WAD;
  return {
    reason: reckless ? "DeltaOutOfBand" : "None",
    reasonCode: reckless ? 8 : 0,
    accepted: !reckless,
    fairValue: reckless ? 9n * WAD : 2_440_000_000_000_000_000n,
    delta: reckless ? 490_000_000_000_000_000n : 200_000_000_000_000_000n,
    capacity: 10n * WAD,
  };
}

// The buyer side: a live 389.79 call (2.44 USDG per option) and a live 350 put (1.50 USDG per option).
const PUT_VAULT = addr(0x1002);
const USDG = addr(0xd6);
const EPOCH_MANAGER = addr(0xe0);
const BUYER = addr(0xb0b);
const callSeries: SeriesState = {
  id: 42n,
  vault: VAULT,
  underlying: TSLA,
  agentId: 1n,
  expiry: FRIDAY,
  premiumBps: 10_000,
  isCall: true,
  settled: false,
  cancelled: false,
  strike: 389_790_000_000_000_000_000n,
  size: 8n * WAD,
  sold: 0n,
  premium: 0n,
  collateral: 0n,
  settlementPrice: 0n,
  payoutPerOption: 0n,
  escrow: 0n,
};
const putSeries: SeriesState = {
  ...callSeries,
  id: 43n,
  vault: PUT_VAULT,
  isCall: false,
  strike: 350n * WAD,
  size: 100n * WAD,
};
const putVault: VaultState = {
  ...vault,
  address: PUT_VAULT,
  name: "Strike TSLA Cash-Secured Put",
  symbol: "sTSLA-CSP",
  decimals: 6,
  kind: "cash-secured-put",
  isCall: false,
  asset: USDG,
  assetSymbol: "USDG",
  assetDecimals: 6,
  totalAssets: 50_000_000_000n,
  totalSupply: 50_000_000_000n,
  pricePerShare: 1_000_000n,
};
const selling = (v: VaultState, s: SeriesState): VaultState => ({
  ...v,
  locked: true,
  currentEpoch: 1n,
  epoch: { state: "Selling", openedAt: MONDAY, seriesId: s.id },
  series: s,
});
const PER_OPTION: Record<string, bigint> = { "42": 2_440_000n, "43": 1_500_000n };

const ENGINE = getAddress("0x61158d98c6c2b7ccb22755a098d0da2bbcf2a4ec");
/** The live TSLA covered call's risk as the Stylus engine computed it (see sdk/test/risk.test.ts), as series 42. */
const LOSSES = [
  ...Array<bigint>(8).fill(0n),
  60_581_999_999_999_999_654n,
  130_582_999_999_999_999_374n,
  200_583_999_999_999_998_534n,
  270_584_999_999_999_999_794n,
  340_585_999_999_999_999_374n,
];
const risk: SeriesRisk = {
  seriesId: 42n,
  vault: VAULT,
  underlying: TSLA,
  isCall: true,
  strike: 369_860_000_000_000_000_000n,
  expiry: FRIDAY,
  settled: false,
  cancelled: false,
  riskEngine: ENGINE,
  source: "riskEngine",
  riskLens: null,
  riskLensFunction: null,
  chainId: 46630,
  epochManager: getAddress("0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99"),
  version: "v2",
  chainTime: FRIDAY - 191_788n,
  tenor: 191_788n,
  spot: 350_005_000_000_000_000_000n,
  spotStatus: "Ok",
  sigma: 600_000_000_000_000_000n,
  sigmaSource: "epoch-open",
  currentSigma: 600_000_000_000_000_000n,
  tokenDecimals: 18,
  usdgDecimals: 6,
  sold: 4n * WAD,
  soldWad: 4n * WAD,
  collateral: 4n * WAD,
  collateralUnit: "token",
  premium: 10_005_944n,
  greeks: {
    delta: 123_873_382_260_320_738n,
    gamma: 12_490_389_829_484_384n,
    vega: 5_583_294_857_298_036_735n,
    theta: -754_577_985_594_328_775n,
  },
  exposure: {
    delta: -495_493_529_041_282_952n,
    gamma: -49_961_559_317_937_536n,
    vega: -22_333_179_429_192_146_940n,
    theta: 3_018_311_942_377_315_100n,
  },
  atCurrentSigma: null,
  scenarios: DEFAULT_SHOCKS.map((shock, i) => ({
    shock,
    spot: (350_005_000_000_000_000_000n * (WAD + shock)) / WAD,
    loss: LOSSES[i] as bigint,
  })),
  worstLoss: 340_585_999_999_999_999_374n,
  worstShock: 300_000_000_000_000_000n,
  worstPayout: 748_529_966_055_429_976n,
  worstShareOfCollateralBps: 1871,
  impliedVol: {
    sigma: 600_000_021_748_298_880n,
    fairValue: 2_501_486_000_000_000_000n,
    pricePaid: 2_501_486_000_000_000_000n,
    spot: 352_453_000_000_000_000_000n,
    pricedSpot: 354_215_265_000_000_000_000n,
    spotBufferBps: 50,
    tenor: 269_415n,
    blockNumber: 126_302_569n,
    txHash: "0x425e5b63ddeb1fcff5d63aa9f5a9fd11f4d3c0f52facd05e0fb44096f2ede9f9",
  },
  impliedVolNote: "solved by the risk engine's impliedVol from the last buy's price",
};

interface StubOptions {
  wallet?: boolean;
  vaults?: VaultState[];
  series?: SeriesState[];
  now?: bigint;
  marketOpen?: boolean;
  usdgBalance?: bigint;
  /** Option balances of the wallet by series id. */
  balances?: Record<string, bigint>;
  /** vaultSeriesIds result, newest first. */
  seriesIds?: bigint[];
}

function stub(opts: StubOptions = {}) {
  const calls = {
    openEpoch: vi.fn(),
    proposeSeries: vi.fn(),
    proposeByDelta: vi.fn(),
    buy: vi.fn(),
    redeemOptions: vi.fn(),
    seriesRisk: vi.fn(),
  };
  const vaults = opts.vaults ?? [vault];
  const series = opts.series ?? [callSeries, putSeries];
  const client = {
    viem: { walletClient: opts.wallet ? { account: { address: AGENT } } : undefined },
    addresses: { usdg: USDG, epochManager: EPOCH_MANAGER },
    listVaults: async () => vaults,
    getVault: async (a: Address) => vaults.find((v) => v.address === a) ?? vault,
    getSeries: async (id: bigint) => series.find((s) => s.id === id) ?? null,
    oracleStatus: async () => ({ status: "Ok", ok: true, price: 369n * WAD, updatedAt: MONDAY - 60n }),
    blockTimestamp: async () => opts.now ?? MONDAY,
    saleCutoff: async () => 3600,
    usdgDecimals: async () => 6,
    quoteBuy: async (id: bigint, amount: bigint) => ({
      premium: (amount * (PER_OPTION[id.toString()] ?? 0n)) / WAD,
      collateral: amount,
    }),
    tokenBalance: async () => opts.usdgBalance ?? 1_000_000_000n,
    optionBalance: async (id: bigint) => opts.balances?.[id.toString()] ?? 0n,
    vaultSeriesIds: async () => opts.seriesIds ?? [],
    seriesRisk: async (id: bigint) => {
      calls.seriesRisk(id);
      if (id !== 42n) throw new Error(`series ${id} does not exist`);
      return risk;
    },
    buy: async (id: bigint, amount: bigint, o: { slippageBps?: number; to?: Address }) => {
      calls.buy(id, amount, o);
      return {
        hash: "0xbuy",
        seriesId: id,
        amount,
        premium: (amount * (PER_OPTION[id.toString()] ?? 0n)) / WAD,
      };
    },
    redeemOptions: async (id: bigint, o: { amount?: bigint; to?: Address }) => {
      calls.redeemOptions(id, o);
      const s = series.find((x) => x.id === id) as SeriesState;
      const amount = o.amount ?? 0n;
      return {
        hash: "0xredeem",
        amount,
        paid: s.isCall ? (amount * s.payoutPerOption) / WAD : (amount * s.payoutPerOption) / 10n ** 30n,
      };
    },
    nextExpiry: async () => FRIDAY,
    solveStrike: async () => 389_790_000_000_000_000_000n,
    previewProposal,
    marketOpen: async () => opts.marketOpen ?? true,
    getAgent: async () => agent,
    registryParams: async () => params,
    agentOfSigner: async () => 1n,
    agentStats: async () => ({
      ...agent,
      params,
      proposals: 0,
      acceptanceRate: null,
      strikesLeft: 3,
      rejectionsUntilInactive: 1,
      claimableFees: 0n,
    }),
    openEpoch: async (v: Address) => {
      calls.openEpoch(v);
      return { hash: "0xopen" };
    },
    proposeSeries: async (v: Address, p: ProposalParams) => {
      calls.proposeSeries(v, p);
      return {
        hash: "0xpropose",
        accepted: false,
        reason: "DeltaOutOfBand",
        epoch: 1n,
        strike: p.strike,
        expiry: p.expiry,
        size: p.size,
        premiumBps: p.premiumBps,
        seriesId: null,
        fairValue: null,
        delta: null,
        slashed: 10_000_000n,
      };
    },
    proposeByDelta: calls.proposeByDelta,
  };
  return { client: client as unknown as StrikeClient, calls };
}

let mcp: Client | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
});

async function connect(client: () => StrikeClient, skillPath?: string) {
  const server = createStrikeMcpServer({ chainId: 31337, client, skillPath });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  mcp = new Client({ name: "strike-test", version: "0.0.0" });
  await mcp.connect(clientTransport);
  await mcp.listTools(); // caches output schemas so the client validates structured results
  return mcp;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  return (await c.callTool({ name, arguments: args })) as CallToolResult;
}

const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;

describe("Strike MCP server", () => {
  it("registers every tool with input and output schemas and annotations", async () => {
    const c = await connect(() => stub().client);
    const { tools } = await c.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      "agent_stats",
      "buy_options",
      "create_vault",
      "explain_decision",
      "hedge_plan",
      "list_vaults",
      "propose_epoch",
      "quote",
      "redeem_options",
      "register_agent",
      "risk_check",
      "series_risk",
      "set_signer",
      "settle_epoch",
      "strike_info",
      "vault_state",
      "wallet_statement",
    ]);
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.annotations?.readOnlyHint, t.name).toBeTypeOf("boolean");
      expect(t.annotations?.destructiveHint, t.name).toBeTypeOf("boolean");
      expect(t.annotations?.idempotentHint, t.name).toBeTypeOf("boolean");
    }
    expect(byName.propose_epoch?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.risk_check?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.risk_check?.inputSchema.properties).toHaveProperty("targetDeltaBps");
    for (const name of ["buy_options", "redeem_options"]) {
      expect(byName[name]?.annotations, name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
    }
    expect(byName.hedge_plan?.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.buy_options?.inputSchema.properties).toHaveProperty("maxSlippageBps");
  });

  it("serves STRIKE_SKILL.md as a resource", async () => {
    const c = await connect(() => stub().client);
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain("strike://skill");
    const res = await c.readResource({ uri: "strike://skill" });
    const content = res.contents[0] as { text: string; mimeType: string };
    expect(content.mimeType).toBe("text/markdown");
    expect(content.text).toMatch(/# Strike skill for AI agents/);
    expect(content.text).toMatch(/DeltaOutOfBand/);
  });

  it("describes itself in read-only mode", async () => {
    const c = await connect(() => stub().client);
    const r = await call(c, "strike_info");
    expect(r.structuredContent).toMatchObject({
      protocol: "Strike",
      chainId: 31337,
      mode: "read-only",
      deployed: true,
    });
  });

  it("lists vaults in human units", async () => {
    const c = await connect(() => stub().client);
    const r = await call(c, "list_vaults");
    expect(r.isError).toBeFalsy();
    const vaults = (r.structuredContent as { vaults: Record<string, unknown>[] }).vaults;
    expect(vaults[0]).toMatchObject({
      address: VAULT,
      symbol: "sTSLA-CC",
      kind: "covered-call",
      totalAssets: "10",
      epochState: "Idle",
      sigma: 0.6,
      series: null,
    });
    expect((vaults[0]?.mandate as { summary: string }).summary).toMatch(/\|delta\| 0\.10-0\.35/);
    expect(JSON.parse(text(r))).toEqual(r.structuredContent);
  });

  it("risk_check explains a reckless strike and suggests a compliant one", async () => {
    const c = await connect(() => stub().client);
    const r = await call(c, "risk_check", { vault: "stsla-cc", strike: "370", size: "8" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      ok: false,
      reason: "DeltaOutOfBand",
      proposal: { mode: "strike", strike: "370", size: "8", premiumBps: 10_000, expiry: Number(FRIDAY) },
      measured: { delta: 0.49, capacity: "10" },
      spot: "369",
      suggestion: { targetDeltaBps: 2000, strike: "389.79", ok: true, reason: "None", size: "8" },
    });
    const explanation = (r.structuredContent as { explanation: string }).explanation;
    expect(explanation).toMatch(/0\.4900/);
    expect(explanation).toMatch(/further out of the money/);
    expect(explanation).toMatch(/slash/);
  });

  it("risk_check by target delta uses the solved strike", async () => {
    const c = await connect(() => stub().client);
    const r = await call(c, "risk_check", { vault: VAULT, targetDeltaBps: 2000 });
    expect(r.structuredContent).toMatchObject({
      ok: true,
      reason: "None",
      proposal: { mode: "delta", targetDeltaBps: 2000, strike: "389.79" },
    });
  });

  it("rejects ambiguous and unknown input", async () => {
    const c = await connect(() => stub().client);
    const both = await call(c, "risk_check", { vault: VAULT, strike: "390", targetDeltaBps: 2000 });
    expect(both.isError).toBe(true);
    expect(text(both)).toMatch(/either strike or targetDeltaBps/);
    const unknown = await call(c, "vault_state", { vault: "sNOPE" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/known vaults: sTSLA-CC/);
  });

  it("refuses write tools in read-only mode", async () => {
    const c = await connect(() => stub().client);
    for (const [name, args] of [
      ["propose_epoch", { vault: VAULT, targetDeltaBps: 2000 }],
      ["settle_epoch", { vault: VAULT }],
      ["buy_options", { vault: VAULT, amount: "1" }],
      ["redeem_options", { vault: VAULT }],
      ["register_agent", { bond: "min" }],
      ["create_vault", { underlying: "TSLA", kind: "put" }],
    ] as const) {
      const r = await call(c, name, args);
      expect(r.isError, name).toBe(true);
      expect(text(r)).toMatch(/read-only mode.*STRIKE_AGENT_PRIVATE_KEY/);
    }
  });

  it("will not send a proposal that fails the dry run unless forced", async () => {
    const { client, calls } = stub({ wallet: true });
    const c = await connect(() => client);
    const refused = await call(c, "propose_epoch", { vault: VAULT, strike: "370" });
    expect(refused.structuredContent).toMatchObject({
      submitted: false,
      accepted: null,
      reason: "DeltaOutOfBand",
      txHash: null,
      suggestion: { ok: true },
    });
    expect(calls.openEpoch).not.toHaveBeenCalled();
    expect(calls.proposeSeries).not.toHaveBeenCalled();

    const forced = await call(c, "propose_epoch", { vault: VAULT, strike: "370", force: true });
    expect(calls.openEpoch).toHaveBeenCalledWith(VAULT);
    expect(calls.proposeSeries).toHaveBeenCalledOnce();
    expect(forced.structuredContent).toMatchObject({
      submitted: true,
      forced: true,
      accepted: false,
      reason: "DeltaOutOfBand",
      slashed: "10",
      openTxHash: "0xopen",
      txHash: "0xpropose",
    });
    expect((forced.structuredContent as { explanation: string }).explanation).toMatch(/Rejected on-chain/);
  });

  it("reports agent stats for the server's own agent", async () => {
    const c = await connect(() => stub({ wallet: true }).client);
    const r = await call(c, "agent_stats");
    expect(r.structuredContent).toMatchObject({
      agentId: "1",
      status: "Active",
      bond: "50",
      minBond: "50",
      slashAmount: "10",
      rejectionsUntilInactive: 1,
      settledEpochs: 0,
      cumulativePnl: "0",
    });
  });

  describe("series_risk", () => {
    it("reads the vault's live series from the Stylus risk engine and explains it", async () => {
      const { client, calls } = stub({ vaults: [selling(vault, callSeries)] });
      const c = await connect(() => client);
      const r = await call(c, "series_risk", { vault: "sTSLA-CC" });
      expect(r.isError).toBeFalsy();
      expect(calls.seriesRisk).toHaveBeenCalledWith(42n);
      const out = r.structuredContent as Record<string, unknown>;
      expect(out).toMatchObject({
        seriesId: "42",
        vaultSymbol: "sTSLA-CC",
        underlying: "TSLA",
        strike: "369.86",
        computedBy: { riskEngine: ENGINE, functions: ["greeks", "scenarioLoss", "impliedVol"] },
        tenorDays: 2.22,
        spot: "350.005",
        sigma: 0.6,
        sigmaSource: "epoch-open",
        sold: "4",
        collateral: "4",
        collateralUnit: "TSLA",
        premiumCollected: "10.005944",
        perOption: { delta: 0.123873, gamma: 0.01249, vega: 5.583295, theta: -0.754578 },
        vaultExposure: { delta: -0.495494, gamma: -0.049962, vega: -22.333179, theta: 3.018312 },
        worst: { shockPct: 30, payout: "340.586", payoutInCollateral: "0.748529", shareOfCollateral: 0.1871 },
        impliedVol: { sigma: 0.60000002, pricedSpot: "354.2152", tenorDays: 3.118 },
      });
      const scenarios = out.scenarios as { shockPct: number; payout: string; net: string }[];
      expect(scenarios).toHaveLength(13);
      expect(scenarios[0]).toEqual({ shockPct: -30, spot: "245.0035", payout: "0", net: "10.005944" });
      expect(scenarios[8]).toMatchObject({ shockPct: 10, payout: "60.582", net: "-50.576056" });
      expect((out.explanations as { delta: string }).delta).toBe(
        "Delta −0.50: the vault loses about $0.50 for every $1 TSLA rises, across the 4 options sold.",
      );
      expect(out.summary).toMatch(
        /Worst case on the ±30% grid: \+30% pays \$340\.59 \(0\.748529 TSLA, 18\.7% of the 4 TSLA locked\) against \$10\.005944 premium/,
      );
    });

    it("takes a seriesId, and refuses a vault without a live series", async () => {
      const { client, calls } = stub();
      const c = await connect(() => client);
      const r = await call(c, "series_risk", { seriesId: "42" });
      expect(r.isError).toBeFalsy();
      expect(calls.seriesRisk).toHaveBeenCalledWith(42n);
      const idle = await call(c, "series_risk", { vault: "sTSLA-CC" });
      expect(idle.isError).toBe(true);
      expect(text(idle)).toMatch(/no live series \(epoch is Idle\)/);
      const none = await call(c, "series_risk", {});
      expect(text(none)).toMatch(/give a vault or a seriesId/);
      const unknown = await call(c, "series_risk", { seriesId: "7" });
      expect(text(unknown)).toMatch(/series 7 does not exist/);
    });
  });

  it("keeps working when the client cannot be built", async () => {
    const c = await connect(() => {
      throw new Error("No Strike deployment for chain 46630");
    });
    const info = await call(c, "strike_info");
    expect(info.structuredContent).toMatchObject({ deployed: false, mode: "read-only" });
    const r = await call(c, "list_vaults");
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No Strike deployment/);
  });
  describe("buyers", () => {
    const market = [selling(vault, callSeries), selling(putVault, putSeries)];

    it("buy_options quotes, buys and reports max loss and breakeven for a call", async () => {
      const { client, calls } = stub({ wallet: true, vaults: market });
      const c = await connect(() => client);
      const r = await call(c, "buy_options", { vault: "sTSLA-CC", amount: "4" });
      expect(r.isError).toBeFalsy();
      expect(calls.buy).toHaveBeenCalledWith(42n, 4n * WAD, { slippageBps: 100, to: AGENT });
      expect(r.structuredContent).toMatchObject({
        seriesId: "42",
        amount: "4",
        isCall: true,
        strike: "389.79",
        expiry: Number(FRIDAY),
        quotedPremium: "9.76",
        maxPremium: "9.8576",
        premiumPaid: "9.76",
        premiumPerOption: "2.44",
        maxLoss: "9.76",
        breakeven: "392.23",
        payoutAsset: "TSLA",
        recipient: AGENT,
        txHash: "0xbuy",
      });
      const explanation = (r.structuredContent as { explanation: string }).explanation;
      expect(explanation).toMatch(/Max loss: the premium, 9\.76 USDG/);
      expect(explanation).toMatch(/redeem_options/);
    });

    it("buy_options puts: breakeven below the strike, custom slippage and recipient", async () => {
      const { client, calls } = stub({ wallet: true, vaults: market });
      const c = await connect(() => client);
      const r = await call(c, "buy_options", {
        vault: PUT_VAULT,
        amount: 10,
        maxSlippageBps: 50,
        recipient: BUYER.toLowerCase(),
      });
      expect(calls.buy).toHaveBeenCalledWith(43n, 10n * WAD, { slippageBps: 50, to: BUYER });
      expect(r.structuredContent).toMatchObject({
        isCall: false,
        premiumPaid: "15",
        maxPremium: "15.075",
        breakeven: "348.5",
        payoutAsset: "USDG",
        recipient: BUYER,
      });
    });

    it("buy_options refuses when the series cannot be bought", async () => {
      const cases: [StubOptions, Record<string, unknown>, RegExp][] = [
        [{ vaults: [vault] }, { vault: VAULT, amount: "1" }, /no series on sale \(epoch is Idle\)/],
        [
          { now: FRIDAY - 1800n },
          { vault: VAULT, amount: "1" },
          /sales of series 42 closed at .*60 minutes before expiry/,
        ],
        [{ now: FRIDAY + 60n }, { vault: VAULT, amount: "1" }, /expired .* settle_epoch/],
        [{ marketOpen: false }, { vault: VAULT, amount: "1" }, /NYSE is closed/],
        [
          { usdgBalance: 1_000_000n },
          { vault: VAULT, amount: "1" },
          /premium is 2\.44 USDG but .* holds 1 USDG/,
        ],
        [{}, { vault: VAULT, amount: "9" }, /only 8 options of series 42 are left/],
        [{}, { vault: VAULT, amount: "0" }, /amount must be positive/],
      ];
      for (const [opts, args, message] of cases) {
        const { client, calls } = stub({ wallet: true, vaults: market, ...opts });
        const c = await connect(() => client);
        const r = await call(c, "buy_options", args);
        expect(r.isError, String(message)).toBe(true);
        expect(text(r)).toMatch(message);
        expect(calls.buy).not.toHaveBeenCalled();
        await c.close();
      }
    });

    it("redeem_options finds the newest settled series held and reports the payout", async () => {
      // Settled at $400: each 389.79 call pays (400 - 389.79) / 400 = 0.025525 TSLA.
      const settled = {
        ...callSeries,
        settled: true,
        settlementPrice: 400n * WAD,
        payoutPerOption: 25_525_000_000_000_000n,
      };
      const live = { ...callSeries, id: 44n };
      const { client, calls } = stub({
        wallet: true,
        series: [settled, live],
        seriesIds: [44n, 42n],
        balances: { "42": 4n * WAD },
      });
      const c = await connect(() => client);
      const r = await call(c, "redeem_options", { vault: "sTSLA-CC" });
      expect(r.isError).toBeFalsy();
      expect(calls.redeemOptions).toHaveBeenCalledWith(42n, { amount: 4n * WAD, to: AGENT });
      expect(r.structuredContent).toMatchObject({
        seriesId: "42",
        status: "settled",
        settlementPrice: "400",
        amount: "4",
        paid: "0.1021",
        paidAsset: "TSLA",
        paidValue: "40.84",
        remaining: "0",
        txHash: "0xredeem",
      });
      expect((r.structuredContent as { explanation: string }).explanation).toMatch(/in the money/);
    });

    it("redeem_options reports worthless options, put payouts and partial redemptions", async () => {
      const otm = { ...callSeries, settled: true, settlementPrice: 380n * WAD };
      const itmPut = { ...putSeries, settled: true, settlementPrice: 340n * WAD, payoutPerOption: 10n * WAD };
      const { client } = stub({
        wallet: true,
        series: [otm, itmPut],
        balances: { "42": 2n * WAD, "43": 5n * WAD },
      });
      const c = await connect(() => client);
      const worthless = await call(c, "redeem_options", { seriesId: "42" });
      expect(worthless.structuredContent).toMatchObject({
        paid: "0",
        paidAsset: "TSLA",
        settlementPrice: "380",
      });
      expect((worthless.structuredContent as { explanation: string }).explanation).toMatch(
        /expired worthless/,
      );
      const put = await call(c, "redeem_options", { seriesId: "43", amount: "3" });
      expect(put.structuredContent).toMatchObject({
        paid: "30",
        paidAsset: "USDG",
        paidValue: "30",
        remaining: "2",
      });
    });

    it("redeem_options refuses series that are not final, not held, or over-asked", async () => {
      const { client, calls } = stub({
        wallet: true,
        series: [callSeries, { ...putSeries, cancelled: true }],
        seriesIds: [42n],
        balances: { "42": WAD, "43": WAD },
      });
      const c = await connect(() => client);
      const pending = await call(c, "redeem_options", { vault: "sTSLA-CC" });
      expect(text(pending)).toMatch(/series 42 is not settled yet.*settle_epoch/);
      const tooMany = await call(c, "redeem_options", { seriesId: "43", amount: "2" });
      expect(text(tooMany)).toMatch(/holds only 1 options of series 43/);
      expect(text(await call(c, "redeem_options", {}))).toMatch(/give a vault or a seriesId/);
      expect(calls.redeemOptions).not.toHaveBeenCalled();
      await c.close();

      const empty = await connect(() => stub({ wallet: true, seriesIds: [42n] }).client);
      const none = await call(empty, "redeem_options", { vault: "sTSLA-CC" });
      expect(text(none)).toMatch(/holds no options of sTSLA-CC/);
    });

    it("hedge_plan sizes a put hedge for tokens held", async () => {
      const c = await connect(() => stub({ vaults: market }).client);
      const r = await call(c, "hedge_plan", { position: "10 TSLA" });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({
        underlying: "TSLA",
        side: "long",
        position: "10",
        spot: "369",
        positionValue: "3690",
        hedgeable: true,
        canBuyNow: true,
        hedge: {
          vaultSymbol: "sTSLA-CSP",
          seriesId: "43",
          optionType: "put",
          options: "10",
          coverage: 1,
          premium: "15",
          premiumPerOption: "1.5",
          costBps: 40.65,
          protectedPrice: "350",
          effectivePrice: "348.5",
          maxLoss: "205", // (369 - 350) x 10 + 15
          saleClosesAt: Number(FRIDAY) - 3600,
        },
      });
      const out = r.structuredContent as {
        explanation: string;
        considered: { vaultSymbol: string; usable: boolean; note: string }[];
      };
      expect(out.considered).toEqual([
        expect.objectContaining({
          vaultSymbol: "sTSLA-CC",
          usable: false,
          note: expect.stringMatching(/sells calls/),
        }),
        expect.objectContaining({ vaultSymbol: "sTSLA-CSP", usable: true }),
      ]);
      expect(out.explanation).toMatch(/worth at least \$350/);
      expect(out.explanation).toMatch(/buy_options \{ "vault": "sTSLA-CSP", "amount": "10" \}/);
    });

    it("hedge_plan covers what is left and hedges shorts with calls", async () => {
      const c = await connect(() => stub({ vaults: market, marketOpen: false }).client);
      const partial = await call(c, "hedge_plan", { underlying: "tsla", position: 150 });
      expect(partial.structuredContent).toMatchObject({
        canBuyNow: false,
        hedge: { options: "100", coverage: 0.6666 },
      });
      expect((partial.structuredContent as { explanation: string }).explanation).toMatch(
        /50 TSLA stay unhedged.*NYSE is closed/,
      );

      const short = await call(c, "hedge_plan", { vault: "sTSLA-CC", position: "5" });
      expect(short.structuredContent).toMatchObject({
        side: "short",
        hedge: {
          optionType: "call",
          options: "5",
          premium: "12.2",
          protectedPrice: "389.79",
          effectivePrice: "392.23",
          maxLoss: "116.15", // (389.79 - 369) x 5 + 12.2
        },
      });
    });

    it("hedge_plan says so when no suitable series is live", async () => {
      const c = await connect(() => stub({ vaults: [selling(vault, callSeries), putVault] }).client);
      const r = await call(c, "hedge_plan", { position: "10 TSLA" });
      expect(r.structuredContent).toMatchObject({ hedgeable: false, canBuyNow: false, hedge: null });
      expect((r.structuredContent as { explanation: string }).explanation).toMatch(
        /No TSLA put series can hedge a long position right now .*sTSLA-CSP: sTSLA-CSP has no series on sale \(epoch is Idle\)/,
      );
      const unknown = await call(c, "hedge_plan", { position: "3 NVDA" });
      expect(text(unknown)).toMatch(/no Strike vault on NVDA; vaults exist on: TSLA/);
      const clash = await call(c, "hedge_plan", { vault: "sTSLA-CC", position: "3 NVDA" });
      expect(text(clash)).toMatch(/is a TSLA vault, not NVDA/);
    });
  });
});
