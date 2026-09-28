import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type StrikeClient,
  WAD,
  createStrikeClient,
  mirrorFeedAbi,
  strikeLocalChain,
  testStockTokenAbi,
} from "@strike/sdk";
import { type Address, createPublicClient, createTestClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANVIL_KEYS, type Devnet, devnetUnavailableReason, startDevnet } from "../../sdk/test/devnet.mjs";
import { createStrikeMcpServer } from "../src/server.js";

// The MCP server against a real local deployment. Skipped without Foundry (or with STRIKE_DEVNET=0).
const unavailable = devnetUnavailableReason();

describe.skipIf(unavailable !== null)("Strike MCP server on a local devnet", () => {
  let devnet: Devnet;
  let strike: StrikeClient;
  let mcp: Client;
  let callVault: Address;
  let putVault: Address;
  const account = privateKeyToAccount(ANVIL_KEYS[0]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
    if (r.isError) throw new Error(`${name} failed: ${(r.content[0] as { text: string }).text}`);
    return r.structuredContent as Record<string, unknown>;
  };

  beforeAll(async () => {
    devnet = await startDevnet();
    const chain = { ...strikeLocalChain, rpcUrls: { default: { http: [devnet.rpcUrl] } } };
    const transport = http(devnet.rpcUrl);
    const publicClient = createPublicClient({ chain, transport, pollingInterval: 50 });
    const walletClient = createWalletClient({ account, chain, transport });
    strike = createStrikeClient({ publicClient, walletClient, chainId: 31337, addresses: devnet.deployment });
    callVault = devnet.vaults.TSLA_covered_call;
    putVault = devnet.vaults.TSLA_cash_secured_put;

    const tsla = devnet.deployment.stocks.TSLA?.token as Address;
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: tsla,
        abi: testStockTokenAbi,
        functionName: "mint",
        args: [account.address, 10n * WAD],
      }),
    });
    await strike.deposit(callVault, 10n * WAD);
    await strike.deposit(putVault, 50_000_000_000n);

    const server = createStrikeMcpServer({ chainId: 31337, client: () => strike });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    mcp = new Client({ name: "strike-e2e", version: "0.0.0" });
    await mcp.connect(clientTransport);
    await mcp.listTools();
  }, 180_000);

  afterAll(async () => {
    await mcp?.close();
    devnet?.stop();
  });

  it("lists the vaults and explains what to do next", async () => {
    const { vaults } = (await call("list_vaults")) as { vaults: { symbol: string; epochState: string }[] };
    expect(vaults.map((v) => v.symbol)).toEqual(["sTSLA-CC", "sTSLA-CSP"]);
    const state = await call("vault_state", { vault: "sTSLA-CC" });
    expect(state).toMatchObject({
      marketOpen: true,
      spot: { ok: true, price: "369" },
      nextExpiry: 1_791_576_000,
    });
    expect(state.nextStep).toMatch(/Idle and ready/);
  });

  it("risk_check catches a reckless strike and suggests a compliant one", async () => {
    const r = await call("risk_check", { vault: "sTSLA-CC", strike: "370", size: "8" });
    expect(r).toMatchObject({
      ok: false,
      reason: "DeltaOutOfBand",
      suggestion: { ok: true, source: "on-chain pricer" },
    });
    const good = await call("risk_check", { vault: "sTSLA-CC", targetDeltaBps: 2000, size: "8" });
    expect(good).toMatchObject({ ok: true, reason: "None", proposal: { mode: "delta" } });
    expect((good.measured as { delta: number }).delta).toBeCloseTo(0.2, 3);
  });

  it("propose_epoch refuses a failing dry run, then proposes by delta", async () => {
    const refused = await call("propose_epoch", { vault: "sTSLA-CC", strike: "370", size: "8" });
    expect(refused).toMatchObject({ submitted: false, txHash: null });
    expect((await strike.getVault(callVault)).epoch.state).toBe("Idle");

    const res = await call("propose_epoch", { vault: "sTSLA-CC", targetDeltaBps: 2000, size: "8" });
    expect(res).toMatchObject({ submitted: true, accepted: true, reason: "None", slashed: "0" });
    expect(res.openTxHash).toMatch(/^0x/);
    expect(res.seriesId).toMatch(/^\d+$/);
    const quote = await call("quote", { vault: "sTSLA-CC", amount: "2" });
    expect(Number(quote.premium)).toBeGreaterThan(0);
    expect(quote.remaining).toBe("8");

    // A buyer (anvil account 1) takes 2 options through the SDK.
    const chain = { ...strikeLocalChain, rpcUrls: { default: { http: [devnet.rpcUrl] } } };
    const buyerWallet = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS[1]),
      chain,
      transport: http(devnet.rpcUrl),
    });
    const buyer = createStrikeClient({
      publicClient: strike.viem.publicClient,
      walletClient: buyerWallet,
      chainId: 31337,
      addresses: devnet.deployment,
    });
    await strike.viem.publicClient.waitForTransactionReceipt({
      hash: await buyerWallet.writeContract({
        address: devnet.deployment.usdg,
        abi: parseAbi(["function faucet(uint256 amount)"]),
        functionName: "faucet",
        args: [1_000_000_000n],
      }),
    });
    await buyer.buy(BigInt(res.seriesId as string), 2n * WAD);
    expect((await call("quote", { vault: "sTSLA-CC", amount: "1" })).remaining).toBe("6");
  });

  it("a forced reckless proposal is rejected on-chain and slashed", async () => {
    const res = await call("propose_epoch", { vault: "sTSLA-CSP", strike: "368", size: "10", force: true });
    expect(res).toMatchObject({
      submitted: true,
      forced: true,
      accepted: false,
      reason: "DeltaOutOfBand",
      slashed: "10",
      agent: { bond: "40", strikes: 1, rejected: 1, active: false },
    });
    const stats = await call("agent_stats");
    expect(stats).toMatchObject({ accepted: 1, rejected: 1, active: false, rejectionsUntilInactive: 0 });
    const again = (await mcp.callTool({
      name: "propose_epoch",
      arguments: { vault: "sTSLA-CSP", targetDeltaBps: 2000 },
    })) as CallToolResult;
    expect(again.isError).toBe(true);
    expect((again.content[0] as { text: string }).text).toMatch(/cannot propose.*postBond/);
  });

  it("settle_epoch settles after expiry and updates the track record", async () => {
    const chain = { ...strikeLocalChain, rpcUrls: { default: { http: [devnet.rpcUrl] } } };
    const test = createTestClient({ chain, mode: "anvil", transport: http(devnet.rpcUrl) });
    const expiry = 1_791_576_000n;
    await test.setNextBlockTimestamp({ timestamp: expiry + 60n });
    await test.mine({ blocks: 1 });
    const wallet = createWalletClient({ account, chain, transport: http(devnet.rpcUrl) });
    const hash = await wallet.writeContract({
      address: devnet.deployment.stocks.TSLA?.feed as Address,
      abi: mirrorFeedAbi,
      functionName: "push",
      args: [380_00000000n, expiry + 30n],
    });
    await strike.viem.publicClient.waitForTransactionReceipt({ hash });

    const res = await call("settle_epoch", { vault: "sTSLA-CC" });
    expect(res).toMatchObject({
      roundId: "2",
      settlementPrice: "380",
      payout: "0",
      agentTrack: { settledEpochs: 1 },
    });
    expect(res.explanation).toMatch(/Settled at \$380/);
    expect((await call("vault_state", { vault: "sTSLA-CC" })).vault).toMatchObject({ epochState: "Idle" });
  });
});
