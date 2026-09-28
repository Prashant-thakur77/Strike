import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ProposalParams, type StrikeClient, type VaultState, WAD } from "@strike/sdk";
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

function stub(opts: { wallet?: boolean } = {}) {
  const calls = { openEpoch: vi.fn(), proposeSeries: vi.fn(), proposeByDelta: vi.fn() };
  const client = {
    viem: { walletClient: opts.wallet ? { account: { address: AGENT } } : undefined },
    listVaults: async () => [vault],
    getVault: async () => vault,
    oracleStatus: async () => ({ status: "Ok", ok: true, price: 369n * WAD, updatedAt: MONDAY - 60n }),
    blockTimestamp: async () => MONDAY,
    usdgDecimals: async () => 6,
    nextExpiry: async () => FRIDAY,
    solveStrike: async () => 389_790_000_000_000_000_000n,
    previewProposal,
    marketOpen: async () => true,
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
      "list_vaults",
      "propose_epoch",
      "quote",
      "risk_check",
      "settle_epoch",
      "strike_info",
      "vault_state",
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
});
