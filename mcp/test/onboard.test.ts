import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type CreateVaultParams, DEFAULT_MANDATE, type StrikeClient, WAD } from "@strike/sdk";
import { type Address, getAddress } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStrikeMcpServer } from "../src/server.js";

// register_agent and create_vault: a third party joins Strike through the MCP server. The Strike client is a stub;
// the tests check what each tool checks, explains and sends.

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const ME = addr(0xbeef);
const TSLA = addr(0x51);
const NVDA = addr(0x52);
const USDG = addr(0xd6);
const IDENTITY_REGISTRY = addr(0x8004);
const NEW_VAULT = addr(0x2002);

const params = {
  minBond: 50_000_000n,
  slashAmount: 10_000_000n,
  maxStrikes: 3,
  unbondDelay: 691_200,
  identityRegistry: addr(0),
  reputationRegistry: addr(0),
};
const agentInfo = (over: Record<string, unknown> = {}) => ({
  agentId: 7n,
  owner: ME,
  signer: ME,
  payout: ME,
  status: "Active",
  strikes: 0,
  accepted: 0,
  rejected: 0,
  unbondAt: 0n,
  erc8004Id: 0n,
  bond: 0n,
  unbonding: 0n,
  active: false,
  settledEpochs: 0,
  cumulativePnl: 0n,
  ...over,
});
const seededVault = {
  address: addr(0x1001),
  symbol: "sTSLA-CC",
  name: "Strike TSLA Covered Call",
  underlying: TSLA,
  underlyingSymbol: "TSLA",
  underlyingDecimals: 18,
};

interface Opts {
  /** Agent id already registered for this wallet's key (0: none). */
  existing?: bigint;
  existingBond?: bigint;
  usdgBalance?: bigint;
  identityRegistry?: Address;
  identityOwner?: Address | null;
  allowed?: boolean;
  /** Symbols of vaults already on chain. */
  symbols?: string[];
}

function stub(opts: Opts = {}) {
  let registered = opts.existing ?? 0n;
  let bond = opts.existingBond ?? 0n;
  const calls = { registerAgent: vi.fn(), postBond: vi.fn(), createVault: vi.fn() };
  const client = {
    viem: {
      walletClient: { account: { address: ME } },
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) =>
          functionName === "symbol" ? "NVDA" : 18,
      },
    },
    addresses: { usdg: USDG },
    usdgDecimals: async () => 6,
    agentRegistryParams: async () => ({
      ...params,
      identityRegistry: opts.identityRegistry ?? params.identityRegistry,
    }),
    agentOfSigner: async () => registered,
    tokenBalance: async () => opts.usdgBalance ?? 1_000_000_000n,
    identityOwner: async () => opts.identityOwner ?? null,
    getAgent: async (id: bigint) =>
      id === registered && id !== 0n
        ? agentInfo({ agentId: id, bond, active: bond >= params.minBond })
        : agentInfo({ agentId: id, status: "None", owner: addr(0), signer: addr(0) }),
    registerAgent: async (p: { signer: Address; payout: Address; erc8004Id?: bigint }) => {
      calls.registerAgent(p);
      registered = 7n;
      return { hash: "0xregister", agentId: 7n, owner: ME, signer: p.signer, erc8004Id: p.erc8004Id ?? 0n };
    },
    postBond: async (id: bigint, amount: bigint) => {
      calls.postBond(id, amount);
      bond += amount;
      return { hash: "0xbond" };
    },
    listVaults: async () => (opts.symbols ?? ["sTSLA-CC"]).map((symbol) => ({ ...seededVault, symbol })),
    isUnderlyingAllowed: async () => opts.allowed ?? true,
    maxDepositCap: async () => 1_000_000n * WAD,
    createVault: async (p: CreateVaultParams) => {
      calls.createVault(p);
      return { hash: "0xcreate", vault: NEW_VAULT, curator: ME, agentId: p.agentId };
    },
  };
  return { client: client as unknown as StrikeClient, calls };
}

let mcp: Client | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
});

async function connect(client: StrikeClient) {
  const server = createStrikeMcpServer({ chainId: 31337, client: () => client });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  mcp = new Client({ name: "strike-test", version: "0.0.0" });
  await mcp.connect(clientTransport);
  await mcp.listTools();
  return mcp;
}

type Out = Record<string, unknown> & {
  explanation: string;
  nextStep: string;
  checks: { check: string; ok: boolean; blocking: boolean; detail: string }[];
};
async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<Out> {
  const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error((r.content[0] as { text: string }).text);
  return r.structuredContent as Out;
}
const checkNamed = (out: Out, name: string) => out.checks.find((c) => c.check === name);

describe("register_agent", () => {
  it("dry-runs: explains the minimum bond, the slash and the strikes without sending", async () => {
    const { client, calls } = stub();
    const c = await connect(client);
    const out = await call(c, "register_agent", { bond: "min", dryRun: true });
    expect(out).toMatchObject({
      dryRun: true,
      submitted: false,
      agentId: null,
      signer: ME,
      minBond: "50",
      slashAmount: "10",
      maxStrikes: 3,
      registerTxHash: null,
    });
    expect(out.explanation).toMatch(/Dry run: would register .* and bond 50 USDG/);
    expect(out.explanation).toMatch(/at least 50 USDG bonded to propose; 10 USDG slashed/);
    expect(checkNamed(out, "USDG for the bond")?.ok).toBe(true);
    expect(calls.registerAgent).not.toHaveBeenCalled();
    expect(calls.postBond).not.toHaveBeenCalled();
  });

  it("registers this wallet as signer and bonds the minimum", async () => {
    const { client, calls } = stub();
    const c = await connect(client);
    const out = await call(c, "register_agent", { bond: "min" });
    expect(calls.registerAgent).toHaveBeenCalledWith({ signer: ME, payout: ME, erc8004Id: 0n });
    expect(calls.postBond).toHaveBeenCalledWith(7n, 50_000_000n);
    expect(out).toMatchObject({
      submitted: true,
      agentId: "7",
      bondPosted: "50",
      bond: "50",
      active: true,
      registerTxHash: "0xregister",
      bondTxHash: "0xbond",
    });
    expect(out.nextStep).toMatch(/create_vault/);
    expect(out.nextStep).toMatch(/setVaultAgent\(vault, 7\)/);
  });

  it("registers without a bond and warns that the agent cannot propose yet", async () => {
    const { client, calls } = stub();
    const c = await connect(client);
    const out = await call(c, "register_agent", { payout: addr(0xfee) });
    expect(calls.registerAgent).toHaveBeenCalledWith({ signer: ME, payout: addr(0xfee), erc8004Id: 0n });
    expect(calls.postBond).not.toHaveBeenCalled();
    expect(out).toMatchObject({ submitted: true, active: false, bondTxHash: null, payout: addr(0xfee) });
    expect(checkNamed(out, "Bond at least minBond")).toMatchObject({ ok: false, blocking: false });
    expect(out.explanation).toMatch(/cannot propose until its bond reaches 50 USDG/);
  });

  it("refuses when the wallet cannot pay the bond", async () => {
    const { client, calls } = stub({ usdgBalance: 20_000_000n });
    const c = await connect(client);
    const out = await call(c, "register_agent", { bond: "50" });
    expect(out.submitted).toBe(false);
    expect(out.dryRun).toBe(false);
    expect(out.explanation).toMatch(
      /Not sent\. USDG for the bond: the bond is 50 USDG but the wallet holds 20 USDG/i,
    );
    expect(calls.registerAgent).not.toHaveBeenCalled();
  });

  it("checks that this wallet owns the ERC-8004 identity it links", async () => {
    const other = addr(0xabc);
    const refused = await call(
      await connect(stub({ identityRegistry: IDENTITY_REGISTRY, identityOwner: other }).client),
      "register_agent",
      { erc8004Id: 114 },
    );
    expect(refused.submitted).toBe(false);
    expect(checkNamed(refused, "ERC-8004 identity")).toMatchObject({ ok: false, blocking: true });
    expect(refused.explanation).toMatch(/belongs to .*NotIdentityOwner/);
    await mcp?.close();

    const { client, calls } = stub({ identityRegistry: IDENTITY_REGISTRY, identityOwner: ME });
    const ok = await call(await connect(client), "register_agent", { erc8004Id: "114" });
    expect(ok.submitted).toBe(true);
    expect(calls.registerAgent).toHaveBeenCalledWith({ signer: ME, payout: ME, erc8004Id: 114n });
  });

  it("does not register a taken signer twice, but tops up its bond", async () => {
    const { client, calls } = stub({ existing: 7n, existingBond: 20_000_000n });
    const c = await connect(client);
    const refused = await call(c, "register_agent");
    expect(refused).toMatchObject({ submitted: false, alreadyRegistered: true, agentId: "7" });
    expect(refused.explanation).toMatch(/already agent #7 \(one agent per signer\)/);

    const topped = await call(c, "register_agent", { bond: "30" });
    expect(calls.registerAgent).not.toHaveBeenCalled();
    expect(calls.postBond).toHaveBeenCalledWith(7n, 30_000_000n);
    expect(topped).toMatchObject({ submitted: true, registerTxHash: null, bond: "50", active: true });
  });
});

describe("create_vault", () => {
  it("dry-runs with default mandate and names, and explains the floors", async () => {
    const { client, calls } = stub({ existing: 7n, existingBond: 50_000_000n });
    const c = await connect(client);
    const out = await call(c, "create_vault", { underlying: "tsla", kind: "put", dryRun: true });
    expect(out).toMatchObject({
      dryRun: true,
      submitted: false,
      vault: null,
      agentId: "7",
      kind: "cash-secured-put",
      collateral: "USDG",
      name: "Strike TSLA Cash-Secured Put (agent 7)",
      symbol: "sTSLA-CSP-A7",
      depositCap: "1000000",
      underlying: { address: TSLA, symbol: "TSLA" },
      floors: { minPremiumBps: 9000, maxTenorDays: 35 },
      mandate: { ...DEFAULT_MANDATE },
    });
    expect(out.checks.every((c) => c.ok)).toBe(true);
    expect(out.explanation).toMatch(/Dry run: would create sTSLA-CSP-A7/);
    expect(calls.createVault).not.toHaveBeenCalled();
  });

  it("creates the vault with this wallet's agent", async () => {
    const { client, calls } = stub({ existing: 7n, existingBond: 50_000_000n });
    const c = await connect(client);
    const out = await call(c, "create_vault", {
      underlying: "TSLA",
      kind: "call",
      mandate: { maxDeltaBps: 3000, maxTenor: 14 * 86_400 },
      depositCap: "500",
    });
    expect(calls.createVault).toHaveBeenCalledWith({
      underlying: TSLA,
      isCall: true,
      agentId: 7n,
      depositCap: 500n * WAD,
      name: "Strike TSLA Covered Call (agent 7)",
      symbol: "sTSLA-CC-A7",
      mandate: { ...DEFAULT_MANDATE, maxDeltaBps: 3000, maxTenor: 14 * 86_400 },
    });
    expect(out).toMatchObject({ submitted: true, vault: NEW_VAULT, txHash: "0xcreate", curator: ME });
    expect(out.nextStep).toMatch(/propose_epoch with vault "sTSLA-CC-A7"/);
  });

  it("refuses a mandate below the protocol floors", async () => {
    const { client, calls } = stub({ existing: 7n, existingBond: 50_000_000n });
    const c = await connect(client);
    const out = await call(c, "create_vault", {
      underlying: "TSLA",
      kind: "put",
      mandate: { minPremiumBps: 8000, maxTenor: 40 * 86_400 },
    });
    expect(out.submitted).toBe(false);
    expect(checkNamed(out, "Mandate inside the floors")?.ok).toBe(false);
    expect(out.explanation).toMatch(/minPremiumBps must be at least 9000/);
    expect(out.explanation).toMatch(/35 days/);
    expect(calls.createVault).not.toHaveBeenCalled();
  });

  it("refuses without an agent, on a token that is not allowed, and over the cap", async () => {
    const noAgent = await call(await connect(stub().client), "create_vault", {
      underlying: "TSLA",
      kind: "put",
    });
    expect(noAgent.submitted).toBe(false);
    expect(noAgent.explanation).toMatch(/no agent: run register_agent first/);
    await mcp?.close();

    const { client, calls } = stub({ existing: 7n, existingBond: 50_000_000n, allowed: false });
    const c = await connect(client);
    const blocked = await call(c, "create_vault", { underlying: NVDA, kind: "call", depositCap: "2000000" });
    expect(blocked.underlying).toEqual({ address: NVDA, symbol: "NVDA" });
    expect(checkNamed(blocked, "Stock token allowed")?.ok).toBe(false);
    expect(checkNamed(blocked, "Deposit cap")?.detail).toMatch(/above the factory's 1000000 NVDA ceiling/);
    expect(calls.createVault).not.toHaveBeenCalled();
  });

  it("warns (without blocking) when the agent is unbonded or signs with another key", async () => {
    const { client, calls } = stub({ existing: 7n, existingBond: 0n, symbols: ["sTSLA-CSP-A7"] });
    const c = await connect(client);
    const out = await call(c, "create_vault", { underlying: "TSLA", kind: "put" });
    expect(out.submitted).toBe(true);
    expect(out.symbol).toBe("sTSLA-CSP-A7-2"); // the default symbol was taken
    expect(checkNamed(out, "Agent bonded")).toMatchObject({ ok: false, blocking: false });
    expect(out.explanation).toMatch(/bond below minBond \(50 USDG\) cannot propose/);
    expect(calls.createVault).toHaveBeenCalledOnce();
  });

  it("names the known stock tokens for an unknown symbol", async () => {
    const c = await connect(stub({ existing: 7n }).client);
    const r = (await c.callTool({
      name: "create_vault",
      arguments: { underlying: "NOPE", kind: "call" },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(
      /unknown stock token "NOPE"; known on chain 31337: TSLA/,
    );
  });
});
