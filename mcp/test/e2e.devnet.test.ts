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
  let buyer: StrikeClient; // anvil account 1, with its own MCP server
  let mcp: Client;
  let buyerMcp: Client;
  let callVault: Address;
  let putVault: Address;
  const account = privateKeyToAccount(ANVIL_KEYS[0]);

  const callOn = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
    if (r.isError) throw new Error(`${name} failed: ${(r.content[0] as { text: string }).text}`);
    return r.structuredContent as Record<string, unknown>;
  };
  const call = (name: string, args: Record<string, unknown> = {}) => callOn(mcp, name, args);
  const buyerCall = (name: string, args: Record<string, unknown> = {}) => callOn(buyerMcp, name, args);
  const connect = async (client: StrikeClient) => {
    const server = createStrikeMcpServer({ chainId: 31337, client: () => client });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const c = new Client({ name: "strike-e2e", version: "0.0.0" });
    await c.connect(clientTransport);
    await c.listTools();
    return c;
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

    // The buyer: 1,000 USDG from the public faucet.
    const buyerWallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[1]), chain, transport });
    buyer = createStrikeClient({
      publicClient,
      walletClient: buyerWallet,
      chainId: 31337,
      addresses: devnet.deployment,
    });
    await publicClient.waitForTransactionReceipt({
      hash: await buyerWallet.writeContract({
        address: devnet.deployment.usdg,
        abi: parseAbi(["function faucet(uint256 amount)"]),
        functionName: "faucet",
        args: [1_000_000_000n],
      }),
    });

    mcp = await connect(strike);
    buyerMcp = await connect(buyer);
  }, 180_000);

  afterAll(async () => {
    await mcp?.close();
    await buyerMcp?.close();
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

    // The buyer (anvil account 1) takes 2 options through the SDK.
    await buyer.buy(BigInt(res.seriesId as string), 2n * WAD);
    expect((await call("quote", { vault: "sTSLA-CC", amount: "1" })).remaining).toBe("6");
  });

  it("a forced reckless proposal is rejected on-chain and slashed; the agent then proposes a compliant put", async () => {
    const res = await call("propose_epoch", { vault: "sTSLA-CSP", strike: "368", size: "10", force: true });
    expect(res).toMatchObject({
      submitted: true,
      forced: true,
      accepted: false,
      reason: "DeltaOutOfBand",
      slashed: "10",
      // Seed bonds 100 USDG, so one slash leaves the agent above the 50 USDG minimum.
      agent: { bond: "90", strikes: 1, rejected: 1, active: true },
    });
    const stats = await call("agent_stats");
    expect(stats).toMatchObject({ accepted: 1, rejected: 1, active: true, rejectionsUntilInactive: 2 });
    const again = await call("propose_epoch", { vault: "sTSLA-CSP", targetDeltaBps: 2000, size: "20" });
    expect(again).toMatchObject({ submitted: true, accepted: true, openTxHash: null, size: "20" });
  });

  it("a buyer agent plans a put hedge, buys it and a call, through its own MCP server", async () => {
    expect(await buyerCall("strike_info")).toMatchObject({ mode: "agent" });
    const plan = await buyerCall("hedge_plan", { position: "10 TSLA" });
    expect(plan).toMatchObject({
      underlying: "TSLA",
      side: "long",
      spot: "369",
      hedgeable: true,
      canBuyNow: true,
      hedge: { vaultSymbol: "sTSLA-CSP", optionType: "put", options: "10", coverage: 1 },
    });
    const hedge = plan.hedge as Record<string, string>;
    expect(Number(hedge.protectedPrice)).toBeLessThan(369);
    expect(Number(hedge.premium)).toBeGreaterThan(0);

    const put = await buyerCall("buy_options", { vault: "sTSLA-CSP", amount: hedge.options });
    expect(put).toMatchObject({
      isCall: false,
      amount: "10",
      payoutAsset: "USDG",
      strike: hedge.protectedPrice,
    });
    expect(Number(put.premiumPaid)).toBeLessThanOrEqual(Number(put.maxPremium));
    expect(Number(put.breakeven)).toBeCloseTo(Number(put.strike) - Number(put.premiumPerOption), 3);
    expect(await buyer.optionBalance(BigInt(put.seriesId as string))).toBe(10n * WAD);

    const bought = await buyerCall("buy_options", { vault: "sTSLA-CC", amount: "1", maxSlippageBps: 50 });
    expect(bought).toMatchObject({ isCall: true, amount: "1", payoutAsset: "TSLA" });
    expect(bought.maxLoss).toBe(bought.premiumPaid);
    expect(Number(bought.breakeven)).toBeCloseTo(Number(bought.strike) + Number(bought.premiumPerOption), 3);
    expect((await call("quote", { vault: "sTSLA-CC", amount: "1" })).remaining).toBe("5");

    const early = (await buyerMcp.callTool({
      name: "redeem_options",
      arguments: { vault: "sTSLA-CC" },
    })) as CallToolResult;
    expect(early.isError).toBe(true);
    expect((early.content[0] as { text: string }).text).toMatch(/not settled yet.*settle_epoch/);
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

  it("the buyer redeems settled options from the vault alone and sees the payout", async () => {
    // $380 is between the put and call strikes: both expire worthless.
    const calls = await buyerCall("redeem_options", { vault: "sTSLA-CC" });
    expect(calls).toMatchObject({
      status: "settled",
      settlementPrice: "380",
      amount: "3",
      paid: "0",
      paidAsset: "TSLA",
      remaining: "0",
    });
    expect(calls.explanation).toMatch(/expired worthless/);

    await call("settle_epoch", { vault: "sTSLA-CSP" });
    const puts = await buyerCall("redeem_options", { vault: "sTSLA-CSP", amount: "4" });
    expect(puts).toMatchObject({
      settlementPrice: "380",
      amount: "4",
      paid: "0",
      paidAsset: "USDG",
      remaining: "6",
    });
    const rest = await buyerCall("redeem_options", { seriesId: puts.seriesId });
    expect(rest).toMatchObject({ amount: "6", remaining: "0" });
  });

  it("a new agent joins through its own MCP server: register_agent, then create_vault", async () => {
    const chain = { ...strikeLocalChain, rpcUrls: { default: { http: [devnet.rpcUrl] } } };
    const transport = http(devnet.rpcUrl);
    const newcomerWallet = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS[2]),
      chain,
      transport,
    });
    const newcomer = createStrikeClient({
      publicClient: strike.viem.publicClient,
      walletClient: newcomerWallet,
      chainId: 31337,
      addresses: devnet.deployment,
    });
    const joinMcp = await connect(newcomer);
    const join = (name: string, args: Record<string, unknown> = {}) => callOn(joinMcp, name, args);
    try {
      // No USDG yet: the dry run says the bond cannot be paid and sends nothing.
      const broke = await join("register_agent", { bond: "min" });
      expect(broke).toMatchObject({ submitted: false, agentId: null, minBond: "50", slashAmount: "10" });
      expect(broke.explanation).toMatch(/wallet holds 0 USDG/);

      await strike.viem.publicClient.waitForTransactionReceipt({
        hash: await newcomerWallet.writeContract({
          address: devnet.deployment.usdg,
          abi: parseAbi(["function faucet(uint256 amount)"]),
          functionName: "faucet",
          args: [100_000_000n],
        }),
      });
      const dry = await join("register_agent", { bond: "min", dryRun: true });
      expect(dry).toMatchObject({ dryRun: true, submitted: false });

      const reg = await join("register_agent", { bond: "min" });
      expect(reg).toMatchObject({
        submitted: true,
        agentId: "2",
        signer: newcomerWallet.account.address,
        bond: "50",
        active: true,
      });
      expect(await newcomer.agentOfSigner(newcomerWallet.account.address)).toBe(2n);

      const vault = await join("create_vault", { underlying: "TSLA", kind: "put", depositCap: "100000" });
      expect(vault).toMatchObject({
        submitted: true,
        agentId: "2",
        symbol: "sTSLA-CSP-A2",
        depositCap: "100000",
        curator: newcomerWallet.account.address,
      });
      const listed = (await join("list_vaults")) as { vaults: { symbol: string; agentId: string }[] };
      expect(listed.vaults.find((v) => v.symbol === "sTSLA-CSP-A2")).toMatchObject({ agentId: "2" });
      // The new agent's own vault is the one it can run: vault_state points it at risk_check / propose_epoch.
      const state = await join("vault_state", { vault: "sTSLA-CSP-A2" });
      expect(state).toMatchObject({ agent: { agentId: "2", active: true } });
    } finally {
      await joinMcp.close();
    }
  });
});
