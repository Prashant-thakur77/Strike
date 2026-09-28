import {
  type Address,
  type PublicClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type StrikeClient,
  StrikeError,
  WAD,
  createStrikeClient,
  mirrorFeedAbi,
  strikeLocalChain,
  testStockTokenAbi,
} from "../src/index.js";
import { ANVIL_KEYS, type Devnet, devnetUnavailableReason, startDevnet } from "./devnet.mjs";

// End-to-end against a real local deployment (anvil + the Foundry Deploy/Seed scripts). Skipped when Foundry is
// not installed (for example the JS-only CI job) or with STRIKE_DEVNET=0.
const unavailable = devnetUnavailableReason();
const usdgFaucetAbi = parseAbi(["function faucet(uint256 amount)"]);

describe.skipIf(unavailable !== null)("SDK against a local devnet", () => {
  let devnet: Devnet;
  let pub: PublicClient;
  let agent: StrikeClient; // account 0: deployer, curator, agent signer, depositor
  let buyer: StrikeClient; // account 1
  let callVault: Address;
  let putVault: Address;
  let tsla: Address;
  let seriesId: bigint;
  let expiry: bigint;

  const [agentAccount, buyerAccount] = [
    privateKeyToAccount(ANVIL_KEYS[0]),
    privateKeyToAccount(ANVIL_KEYS[1]),
  ];
  const chainFor = (url: string) => ({ ...strikeLocalChain, rpcUrls: { default: { http: [url] } } });

  beforeAll(async () => {
    devnet = await startDevnet();
    const chain = chainFor(devnet.rpcUrl);
    pub = createPublicClient({ chain, transport: http(devnet.rpcUrl), pollingInterval: 50 });
    const wallet = (account: typeof agentAccount) =>
      createWalletClient({ account, chain, transport: http(devnet.rpcUrl) });
    const addresses = devnet.deployment;
    agent = createStrikeClient({
      publicClient: pub,
      walletClient: wallet(agentAccount),
      chainId: 31337,
      addresses,
    });
    buyer = createStrikeClient({
      publicClient: pub,
      walletClient: wallet(buyerAccount),
      chainId: 31337,
      addresses,
    });
    callVault = devnet.vaults.TSLA_covered_call;
    putVault = devnet.vaults.TSLA_cash_secured_put;
    tsla = devnet.deployment.stocks.TSLA?.token as Address;

    // Fund: 100 TSLA for the depositor (admin mint), 10,000 USDG for the buyer (public faucet).
    const w0 = wallet(agentAccount);
    const w1 = wallet(buyerAccount);
    await pub.waitForTransactionReceipt({
      hash: await w0.writeContract({
        address: tsla,
        abi: testStockTokenAbi,
        functionName: "mint",
        args: [agentAccount.address, 100n * WAD],
      }),
    });
    await pub.waitForTransactionReceipt({
      hash: await w1.writeContract({
        address: devnet.deployment.usdg,
        abi: usdgFaucetAbi,
        functionName: "faucet",
        args: [10_000_000_000n],
      }),
    });
  }, 180_000);

  afterAll(() => devnet?.stop());

  it("lists the seeded vaults with their mandates", async () => {
    const vaults = await agent.listVaults();
    expect(vaults.map((v) => v.address)).toEqual([callVault, putVault]);
    const [call, put] = vaults;
    expect(call).toMatchObject({ kind: "covered-call", underlyingSymbol: "TSLA", epoch: { state: "Idle" } });
    expect(put).toMatchObject({ kind: "cash-secured-put", assetSymbol: "USDG", epoch: { state: "Idle" } });
    expect(call?.mandate).toEqual({
      minDeltaBps: 1000,
      maxDeltaBps: 3500,
      minPremiumBps: 9500,
      minYieldBps: 5,
      maxShareSoldBps: 8000,
      minTenor: 86_400,
      maxTenor: 691_200,
    });
    expect(await agent.oracleStatus(tsla)).toMatchObject({ status: "Ok", price: 369n * WAD });
    expect(await agent.marketOpen()).toBe(true);
  });

  it("deposits instantly while the vault is idle", async () => {
    const res = await agent.deposit(callVault, 10n * WAD);
    expect(res.queued).toBe(false);
    await agent.deposit(putVault, 50_000_000_000n);
    expect((await agent.getVault(callVault)).totalAssets).toBe(10n * WAD);
    expect((await agent.claimables(callVault)).shares).toBe(10n * WAD);
  });

  it("previews proposals: a reckless strike fails, a 0.20-delta strike passes", async () => {
    const vault = await agent.getVault(callVault);
    const next = await agent.nextExpiry(vault.mandate);
    expect(next).toBe(1_791_576_000n); // Fri 2026-10-09 20:00 UTC
    expiry = next as bigint;
    const reckless = await agent.previewProposal(callVault, {
      strike: 370n * WAD,
      expiry,
      size: 8n * WAD,
      premiumBps: 10_000,
    });
    expect(reckless.reason).toBe("DeltaOutOfBand");
    const good = await agent.previewProposeByDelta(callVault, {
      targetDeltaBps: 2000,
      expiry,
      size: 8n * WAD,
      premiumBps: 10_000,
    });
    expect(good.reason).toBe("None");
    expect(Number(good.delta) / 1e18).toBeCloseTo(0.2, 3);
    expect(good.strike).toBeGreaterThan(369n * WAD);
  });

  it("opens the epoch and proposes by delta", async () => {
    await agent.openEpoch(callVault);
    expect((await agent.getVault(callVault)).epoch.state).toBe("Open");
    const res = await agent.proposeByDelta(callVault, {
      targetDeltaBps: 2000,
      expiry,
      size: 8n * WAD,
      premiumBps: 10_000,
    });
    expect(res).toMatchObject({ accepted: true, reason: "None", slashed: 0n, expiry, size: 8n * WAD });
    expect(res.seriesId).not.toBeNull();
    seriesId = res.seriesId as bigint;
    const v = await agent.getVault(callVault);
    expect(v.epoch.state).toBe("Selling");
    expect(v.series?.strike).toBe(res.strike);
    expect((await agent.agentStats(1n)).accepted).toBe(1);
    expect(await agent.vaultSeriesIds(callVault)).toEqual([seriesId]);
    expect(await agent.vaultSeriesIds(putVault)).toEqual([]);
  });

  it("sells options with auto-approval and a slippage bound", async () => {
    const quote = await buyer.quoteBuy(seriesId, 2n * WAD);
    expect(quote.collateral).toBe(2n * WAD);
    const res = await buyer.buy(seriesId, 2n * WAD, { slippageBps: 50 });
    expect(res.premium).toBeGreaterThan(0n);
    expect(res.premium).toBeLessThanOrEqual(quote.premium + quote.premium / 200n + 1n);
    expect(await buyer.optionBalance(seriesId)).toBe(2n * WAD);
  });

  it("queues deposits while the epoch runs", async () => {
    const res = await agent.deposit(callVault, WAD);
    expect(res.queued).toBe(true);
    expect((await agent.claimables(callVault)).depositRequest.amount).toBe(WAD);
  });

  it("records a rejected proposal with its reason and slash", async () => {
    await agent.openEpoch(putVault);
    const res = await agent.proposeSeries(putVault, {
      strike: 368n * WAD, // just below spot: |delta| ≈ 0.45
      expiry,
      size: 10n * WAD,
      premiumBps: 10_000,
    });
    expect(res).toMatchObject({
      accepted: false,
      reason: "DeltaOutOfBand",
      seriesId: null,
      slashed: 10_000_000n,
    });
    const stats = await agent.agentStats(1n);
    // Seed bonds 100 USDG, so one slash leaves the agent above the 50 USDG minimum.
    expect(stats).toMatchObject({ rejected: 1, strikes: 1, bond: 90_000_000n, active: true });
    expect((await agent.getVault(putVault)).compensation).toBe(10_000_000n);
  });

  it("refuses to settle before expiry", async () => {
    await expect(agent.settle(callVault)).rejects.toBeInstanceOf(StrikeError);
  });

  it("settles after expiry with the auto-discovered round", async () => {
    const test = createTestClient({
      chain: chainFor(devnet.rpcUrl),
      mode: "anvil",
      transport: http(devnet.rpcUrl),
    });
    await test.setNextBlockTimestamp({ timestamp: expiry + 60n });
    await test.mine({ blocks: 1 });
    const feed = devnet.deployment.stocks.TSLA?.feed as Address;
    const w0 = createWalletClient({
      account: agentAccount,
      chain: chainFor(devnet.rpcUrl),
      transport: http(devnet.rpcUrl),
    });
    await pub.waitForTransactionReceipt({
      hash: await w0.writeContract({
        address: feed,
        abi: mirrorFeedAbi,
        functionName: "push",
        args: [380_00000000n, expiry + 30n],
      }),
    });
    expect(await agent.findSettlementRound(tsla, expiry)).toBe(2n);

    const res = await agent.settle(callVault);
    expect(res).toMatchObject({ seriesId, roundId: 2n, settlementPrice: 380n * WAD, payout: 0n });
    expect(res.premium).toBeGreaterThan(0n);
    expect(res.fee).toBeGreaterThan(0n);
    const track = await agent.getAgent(1n);
    expect(track.settledEpochs).toBe(1);
    expect(track.cumulativePnl).toBe(res.premium); // nothing paid out
    const v = await agent.getVault(callVault);
    expect(v.locked).toBe(false);
    expect(v.series).toBeNull();
    expect(v.totalAssets).toBe(11n * WAD); // collateral intact (OTM) + the processed queued deposit
  });

  it("pays premium to depositors and lets buyers redeem", async () => {
    const before = await agent.claimables(callVault);
    expect(before.depositShares).toBeGreaterThan(0n);
    expect(before.premium).toBeGreaterThan(0n);
    await agent.claimDeposit(callVault);
    const usdgBefore = await agent.tokenBalance(devnet.deployment.usdg);
    await agent.claimPremium(callVault);
    expect(await agent.tokenBalance(devnet.deployment.usdg)).toBeGreaterThan(usdgBefore);

    const redeemed = await buyer.redeemOptions(seriesId);
    expect(redeemed).toMatchObject({ amount: 2n * WAD, paid: 0n });
    expect(await buyer.optionBalance(seriesId)).toBe(0n);
  });

  it("pays a slashed bond to the put vault's depositors when the curator aborts", async () => {
    await agent.abortEpoch(putVault);
    const premium = await agent.pendingPremium(putVault, agentAccount.address);
    expect(premium).toBeGreaterThan(9_999_990n);
    expect(premium).toBeLessThanOrEqual(10_000_000n);
  });
});
