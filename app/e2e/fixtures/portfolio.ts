// Hand-made chain histories for the portfolio's arithmetic (e2e/portfolio.spec.ts): logs as the indexer or the RPC
// path hands them over (integers as decimal strings, addresses lower case) and the vault reads of "today". Every
// number is chosen so the expected result can be worked out by hand; the comments say how.

import type { PLog, VaultInput, VaultLive, OptionInput, AgentInput } from "../../src/lib/portfolioLedger";

export const ACCT = "0x00000000000000000000000000000000000000aa";
export const OTHER = "0x00000000000000000000000000000000000000bb";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const PUT = "0x0000000000000000000000000000000000000001";
export const CALL = "0x0000000000000000000000000000000000000002";
export const QUEUE = "0x0000000000000000000000000000000000000003";
export const EM = "0x00000000000000000000000000000000000000ee";

const E6 = 10n ** 6n;
const E18 = 10n ** 18n;
const ACC = 10n ** 36n;
const s = (x: bigint) => x.toString();

let index = 0;
export function log(
  source: PLog["source"],
  address: string,
  event: string,
  args: Record<string, unknown>,
  block: number,
  time: number,
): PLog {
  index += 1;
  return {
    chainId: 46630,
    deployment: "46630-v3",
    address,
    source,
    event,
    args,
    block,
    logIndex: index,
    tx: `0x${block.toString(16).padStart(8, "0")}${index.toString(16).padStart(56, "0")}`,
    time,
  };
}

const live = (over: Partial<VaultLive>): VaultLive => ({
  totalAssets: 0n,
  totalSupply: 0n,
  balance: 0n,
  pendingPremium: 0n,
  depositRequest: { epoch: 0, amount: 0n },
  redeemRequest: { epoch: 0, amount: 0n },
  claimableDepositShares: 0n,
  claimableRedeemAssets: 0n,
  currentEpoch: 0,
  lastProcessedEpoch: 0,
  locked: false,
  state: 0,
  series: null,
  ...over,
});

const vaultInput = (vault: string, isCall: boolean, over: Partial<VaultInput>): VaultInput => ({
  chainId: 46630,
  deployment: "46630-v3",
  version: "v3",
  vault,
  symbol: isCall ? "sTSLA-CC" : "sTSLA-CSP",
  isCall,
  underlying: "TSLA",
  assetSymbol: isCall ? "TSLA" : "USDG",
  assetDecimals: isCall ? 18 : 6,
  shareDecimals: isCall ? 18 : 6,
  usdgDecimals: 6,
  spot: 300,
  prices: [],
  sigma: 0.6,
  live: live({}),
  ...over,
});

/**
 * A put vault: the wallet deposits 100 USDG next to another depositor's 100, epoch 1 settles with 10 USDG of premium
 * and no payout (5 USDG is the wallet's half), then it withdraws 40 USDG and claims its 5 USDG.
 * Net P&L = 60 value + 40 withdrawn + 5 premium claimed − 100 deposited = +5, all of it realised (the premium).
 */
export function depositsFixture() {
  const acc1 = (10n * E6 * ACC) / (200n * E6);
  const logs = [
    log("vault", PUT, "Transfer", { from: ZERO, to: OTHER, value: s(100n * E6) }, 9, 900),
    log(
      "vault",
      PUT,
      "Deposit",
      { sender: OTHER, owner: OTHER, assets: s(100n * E6), shares: s(100n * E6) },
      9,
      900,
    ),
    log("vault", PUT, "Transfer", { from: ZERO, to: ACCT, value: s(100n * E6) }, 10, 1000),
    log(
      "vault",
      PUT,
      "Deposit",
      { sender: ACCT, owner: ACCT, assets: s(100n * E6), shares: s(100n * E6) },
      10,
      1000,
    ),
    log("epochManager", EM, "EpochOpened", { vault: PUT, epoch: "1", spot: s(300n * E18) }, 20, 2000),
    log("vault", PUT, "EpochLocked", { epoch: "1" }, 20, 2000),
    log(
      "epochManager",
      EM,
      "SeriesProposed",
      { vault: PUT, epoch: "1", seriesId: "7", strike: s(280n * E18), expiry: "5000", delta: s(-(E18 / 5n)) },
      25,
      2500,
    ),
    log(
      "epochManager",
      EM,
      "EpochSettled",
      {
        vault: PUT,
        epoch: "1",
        seriesId: "7",
        settlementPrice: s(290n * E18),
        payout: "0",
        premium: s(10n * E6),
        fee: "0",
      },
      30,
      6000,
    ),
    log(
      "vault",
      PUT,
      "EpochSettled",
      {
        epoch: "1",
        payout: "0",
        premium: s(10n * E6),
        assets: s(200n * E6),
        supply: s(200n * E6),
        accPremium: s(acc1),
      },
      30,
      6000,
    ),
    log("vault", PUT, "Transfer", { from: ACCT, to: ZERO, value: s(40n * E6) }, 40, 7000),
    log(
      "vault",
      PUT,
      "Withdraw",
      { sender: ACCT, receiver: ACCT, owner: ACCT, assets: s(40n * E6), shares: s(40n * E6) },
      40,
      7000,
    ),
    log("vault", PUT, "PremiumClaimed", { account: ACCT, amount: s(5n * E6) }, 41, 7100),
  ];
  const input = vaultInput(PUT, false, {
    live: live({
      totalAssets: 160n * E6,
      totalSupply: 160n * E6,
      balance: 60n * E6,
      currentEpoch: 1,
      lastProcessedEpoch: 1,
    }),
  });
  return { logs, input, now: 8000 };
}

/**
 * A call vault: the wallet deposits 10 TSLA at $100 (the feed's round then) and is the only depositor. Epoch 1 opens
 * at $100, sells a $110 call; TSLA settles at $120, so the vault pays 0.5 TSLA (worth $60) and gets 3 USDG of premium.
 * Net for the epoch = 3 − 60 = −57; holding the 10 tokens over the week = 10 × (120 − 100) = +200.
 * With `pending`, epoch 2 is running: its series (strike $130) expires at `expiry`.
 */
export function callFixture(pending?: { expiry: number; now: number }) {
  const acc1 = (3n * E6 * ACC) / (10n * E18);
  const logs = [
    log("vault", CALL, "Transfer", { from: ZERO, to: ACCT, value: s(10n * E18) }, 10, 1000),
    log(
      "vault",
      CALL,
      "Deposit",
      { sender: ACCT, owner: ACCT, assets: s(10n * E18), shares: s(10n * E18) },
      10,
      1000,
    ),
    log("epochManager", EM, "EpochOpened", { vault: CALL, epoch: "1", spot: s(100n * E18) }, 20, 2000),
    log("vault", CALL, "EpochLocked", { epoch: "1" }, 20, 2000),
    log(
      "epochManager",
      EM,
      "SeriesProposed",
      { vault: CALL, epoch: "1", seriesId: "8", strike: s(110n * E18), expiry: "5000", delta: s(E18 / 5n) },
      25,
      2500,
    ),
    log(
      "epochManager",
      EM,
      "EpochSettled",
      {
        vault: CALL,
        epoch: "1",
        seriesId: "8",
        settlementPrice: s(120n * E18),
        payout: s(E18 / 2n),
        premium: s(3n * E6),
        fee: "0",
      },
      30,
      6000,
    ),
    log(
      "vault",
      CALL,
      "EpochSettled",
      {
        epoch: "1",
        payout: s(E18 / 2n),
        premium: s(3n * E6),
        assets: s((95n * E18) / 10n),
        supply: s(10n * E18),
        accPremium: s(acc1),
      },
      30,
      6000,
    ),
  ];
  if (pending) {
    logs.push(
      log("epochManager", EM, "EpochOpened", { vault: CALL, epoch: "2", spot: s(120n * E18) }, 50, 7000),
      log("vault", CALL, "EpochLocked", { epoch: "2" }, 50, 7000),
      log(
        "epochManager",
        EM,
        "SeriesProposed",
        {
          vault: CALL,
          epoch: "2",
          seriesId: "9",
          strike: s(130n * E18),
          expiry: String(pending.expiry),
          delta: s(E18 / 5n),
        },
        55,
        7100,
      ),
    );
  }
  const input = vaultInput(CALL, true, {
    spot: 120,
    prices: [
      { t: 500, price: 100 },
      { t: 6000, price: 120 },
    ],
    live: live({
      totalAssets: (95n * E18) / 10n,
      totalSupply: 10n * E18,
      balance: 10n * E18,
      pendingPremium: 3n * E6,
      currentEpoch: pending ? 2 : 1,
      lastProcessedEpoch: 1,
      locked: !!pending,
      state: pending ? 2 : 0,
      series: pending
        ? {
            id: "9",
            strike: 130,
            expiry: pending.expiry,
            size: 5,
            sold: 2,
            premium: 4,
            collateral: 2,
            settled: false,
            cancelled: false,
          }
        : null,
    }),
  });
  return { logs, input, now: pending?.now ?? 8000 };
}

/**
 * A queued deposit: the vault is locked in epoch 1 when the wallet queues 50 USDG. Epoch 1 settles (the deposit
 * becomes 50 shares at 1.0), epoch 2 settles with 25 USDG premium over 250 shares: 5 USDG is the wallet's, but the
 * contract credits it only when the shares are claimed, so pendingPremium still reads 0.
 */
export function queuedFixture() {
  const acc1 = (10n * E6 * ACC) / (200n * E6);
  const acc2 = acc1 + (25n * E6 * ACC) / (250n * E6);
  const logs = [
    log("vault", QUEUE, "EpochLocked", { epoch: "1" }, 20, 2000),
    log("vault", QUEUE, "DepositRequested", { account: ACCT, epoch: "1", assets: s(50n * E6) }, 22, 2200),
    log(
      "vault",
      QUEUE,
      "EpochSettled",
      {
        epoch: "1",
        payout: "0",
        premium: s(10n * E6),
        assets: s(200n * E6),
        supply: s(200n * E6),
        accPremium: s(acc1),
      },
      30,
      6000,
    ),
    log("vault", QUEUE, "EpochLocked", { epoch: "2" }, 40, 7000),
    log(
      "vault",
      QUEUE,
      "EpochSettled",
      {
        epoch: "2",
        payout: "0",
        premium: s(25n * E6),
        assets: s(250n * E6),
        supply: s(250n * E6),
        accPremium: s(acc2),
      },
      50,
      9000,
    ),
  ];
  const input = vaultInput(QUEUE, false, {
    symbol: "sTSLA-CSP-Q",
    live: live({
      totalAssets: 250n * E6,
      totalSupply: 250n * E6,
      depositRequest: { epoch: 1, amount: 50n * E6 },
      claimableDepositShares: 50n * E6,
      currentEpoch: 2,
      lastProcessedEpoch: 2,
    }),
  });
  return { logs, input, now: 9500 };
}

/**
 * An option holder: the wallet bought 4 TSLA $280 puts for 10 USDG; TSLA settled at $275, so each pays $5 and the
 * wallet can redeem 20 USDG. Net = 20 − 10 = +10.
 */
export function optionFixture() {
  const logs = [
    log(
      "epochManager",
      EM,
      "OptionsBought",
      { seriesId: "7", buyer: ACCT, recipient: ACCT, amount: s(4n * E18), premium: s(10n * E6) },
      26,
      2600,
    ),
  ];
  const input: OptionInput = {
    chainId: 46630,
    deployment: "46630-v3",
    version: "v3",
    vault: PUT,
    symbol: "sTSLA-CSP",
    underlying: "TSLA",
    isCall: false,
    underlyingDecimals: 18,
    usdgDecimals: 6,
    spot: 300,
    series: {
      id: "7",
      strike: 280,
      expiry: 5000,
      settled: true,
      cancelled: false,
      payoutPerOption: 5n * E18,
      settlementPrice: 275,
      premium: 10n * E6,
      sold: 4n * E18,
    },
    balance: 4n * E18,
  };
  return { logs, input, raw: { "46630-v3:7": s(4n * E18) }, managers: { "46630-v3": EM } };
}

/** The wallet owns agent #3: bonded 60, slashed once for 10. */
export function agentFixture() {
  const REG = "0x00000000000000000000000000000000000000cc";
  const logs = [
    { ...log("agentRegistry", REG, "BondPosted", { agentId: "3", from: ACCT, amount: s(60n * E6) }, 5, 500) },
    {
      ...log(
        "agentRegistry",
        REG,
        "Slashed",
        { agentId: "3", recipient: PUT, amount: s(10n * E6), strikes: "1" },
        6,
        600,
      ),
    },
  ];
  const input: AgentInput = {
    chainId: 46630,
    deployment: "46630-v3",
    version: "v3",
    registry: REG,
    id: "3",
    owner: ACCT,
    signer: OTHER,
    payout: ACCT,
    status: 1,
    strikes: 1,
    accepted: 2,
    rejected: 1,
    bond: 50,
    unbonding: 0,
    settledEpochs: 2,
    cumulativePnl: 4.5,
    feesClaimable: 0,
    usdgDecimals: 6,
  };
  return { logs, input };
}
