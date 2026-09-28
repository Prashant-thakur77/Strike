// openEpoch → proposeSeries → buy → settle → claims → redeem, with events in on-chain log order.
import { BigDecimal, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  afterEach,
  assert,
  beforeEach,
  clearStore,
  createMockedFunction,
  describe,
  test,
} from "matchstick-as/assembly/index";
import { handleEpochResultRecorded, handleProposalRecorded } from "../src/agent-registry";
import {
  handleEpochOpened,
  handleEpochSettled,
  handleOptionsBought,
  handleOptionsRedeemed,
  handleSeriesProposed,
} from "../src/epoch-manager";
import { handleFeesCredited } from "../src/fee-manager";
import {
  PROTOCOL_ID,
  dayId,
  epochId,
  eventId,
  requestId,
  settlementPriceId,
  uint256Id,
} from "../src/helpers";
import { handleSettlementPriceRecorded } from "../src/stock-oracle";
import {
  handleDeposit,
  handleDepositClaimed,
  handleDepositRequested,
  handleEpochLocked,
  handleRedeemClaimed,
  handleRedeemRequested,
  handleVaultEpochSettled,
} from "../src/strike-vault";
import {
  AGENT_ID,
  AGENT_PAYOUT,
  ALICE,
  BOB,
  BUYER,
  DAY,
  EPOCH_1,
  FEE_MANAGER,
  T0,
  TREASURY,
  TSLA,
  VAULT,
  depositClaimed,
  depositRequested,
  epochLocked,
  epochOpened,
  epochResultRecorded,
  epochSettled,
  feesCredited,
  optionsBought,
  optionsRedeemed,
  proposalRecorded,
  redeemClaimed,
  redeemRequested,
  seriesProposed,
  settlementPriceRecorded,
  setupAgent,
  setupCallVault,
  usdg,
  vaultDeposit,
  vaultEpochSettled,
  wad,
} from "./utils";

const SERIES_ID = BigInt.fromString("98765432109876543210987654321");
const EXPIRY: i64 = T0 + 4 * DAY;
const SETTLE_TS: i64 = T0 + 7 * DAY;

/// Deposit 100 TSLA, open epoch 1 at $250, accept a 275 call, sell 10 options for 20 USDG.
function openSellAndBuy(): void {
  setupCallVault();
  setupAgent();
  handleDeposit(vaultDeposit(VAULT, ALICE, wad(100), wad(100), T0 - 3600));
  handleEpochLocked(epochLocked(VAULT, EPOCH_1, T0));
  handleEpochOpened(epochOpened(VAULT, EPOCH_1, wad(250), T0));
  handleProposalRecorded(proposalRecorded(AGENT_ID, T0 + 60));
  handleSeriesProposed(
    seriesProposed(
      VAULT,
      EPOCH_1,
      SERIES_ID,
      wad(275),
      EXPIRY,
      wad(50),
      10_000,
      wad(2),
      BigInt.fromString("250000000000000000"),
      T0 + 60,
    ),
  );
  handleOptionsBought(optionsBought(SERIES_ID, BUYER, BUYER, wad(10), usdg(20), T0 + 3600));
}

describe("epoch lifecycle", () => {
  beforeEach(() => {
    createMockedFunction(FEE_MANAGER, "treasury", "treasury():(address)").returns([
      ethereum.Value.fromAddress(TREASURY),
    ]);
  });

  afterEach(() => {
    clearStore();
  });

  test("open → propose → buy", () => {
    openSellAndBuy();
    const vault = VAULT.toHexString();
    const epoch = epochId(VAULT, EPOCH_1).toHexString();
    const series = uint256Id(SERIES_ID).toHexString();

    assert.fieldEquals("Vault", vault, "locked", "true");
    assert.fieldEquals("Vault", vault, "currentEpoch", epoch);
    assert.fieldEquals("Vault", vault, "totalAssets", wad(100).toString());
    assert.fieldEquals("Vault", vault, "tvlUsd", "25000");
    assert.fieldEquals("Underlying", TSLA.toHexString(), "lastPrice", wad(250).toString());

    assert.fieldEquals("Epoch", epoch, "state", "Selling");
    assert.fieldEquals("Epoch", epoch, "number", "1");
    assert.fieldEquals("Epoch", epoch, "spotAtOpen", wad(250).toString());
    assert.fieldEquals("Epoch", epoch, "assetsAtOpen", wad(100).toString());
    assert.fieldEquals("Epoch", epoch, "openedAt", BigInt.fromI64(T0).toString());
    assert.fieldEquals("Epoch", epoch, "series", series);
    assert.fieldEquals("Epoch", epoch, "agent", uint256Id(AGENT_ID).toHexString());

    assert.fieldEquals("Series", series, "seriesId", SERIES_ID.toString());
    assert.fieldEquals("Series", series, "vault", vault);
    assert.fieldEquals("Series", series, "isCall", "true");
    assert.fieldEquals("Series", series, "strike", wad(275).toString());
    assert.fieldEquals("Series", series, "expiry", BigInt.fromI64(EXPIRY).toString());
    assert.fieldEquals("Series", series, "premiumBps", "10000");
    assert.fieldEquals("Series", series, "delta", "250000000000000000");
    assert.fieldEquals("Series", series, "sold", wad(10).toString());
    assert.fieldEquals("Series", series, "premium", usdg(20).toString());
    assert.fieldEquals("Series", series, "purchaseCount", "1");

    assert.entityCount("Purchase", 1);
    assert.fieldEquals("Agent", uint256Id(AGENT_ID).toHexString(), "accepted", "1");
    assert.fieldEquals("Agent", uint256Id(AGENT_ID).toHexString(), "acceptanceRate", "1");

    const day = VAULT.concatI32(dayId(BigInt.fromI64(T0 + 3600))).toHexString();
    assert.fieldEquals("VaultDayData", day, "premiumSold", usdg(20).toString());
    assert.fieldEquals("VaultDayData", day, "optionsSold", wad(10).toString());

    const protocol = PROTOCOL_ID.toHexString();
    assert.fieldEquals("ProtocolStats", protocol, "epochCount", "1");
    assert.fieldEquals("ProtocolStats", protocol, "proposalCount", "1");
    assert.fieldEquals("ProtocolStats", protocol, "purchaseCount", "1");
    assert.fieldEquals("ProtocolStats", protocol, "tvlUsd", "25000");
  });

  test("settle out of the money: fee, net premium, queue and APR", () => {
    openSellAndBuy();
    // Queued while locked: Bob deposits 10 TSLA, Alice redeems 20 shares.
    handleDepositRequested(depositRequested(VAULT, BOB, EPOCH_1, wad(10), T0 + 120));
    handleRedeemRequested(redeemRequested(VAULT, ALICE, EPOCH_1, wad(20), T0 + 130));
    assert.fieldEquals("Vault", VAULT.toHexString(), "pendingDepositAssets", wad(10).toString());
    assert.fieldEquals("Vault", VAULT.toHexString(), "pendingRedeemShares", wad(20).toString());

    // settle(): oracle price, fee credit (10% of 20 USDG, half to the agent), vault hook, track record, event.
    handleSettlementPriceRecorded(
      settlementPriceRecorded(TSLA, EXPIRY, BigInt.fromI32(42), wad(260), SETTLE_TS),
    );
    handleFeesCredited(feesCredited(AGENT_PAYOUT, usdg(1), usdg(1), SETTLE_TS));
    const accPremium = BigInt.fromString("180000000000000000000000"); // 18 USDG × 1e36 / 100 shares
    handleVaultEpochSettled(
      vaultEpochSettled(VAULT, EPOCH_1, BigInt.zero(), usdg(18), wad(100), wad(100), accPremium, SETTLE_TS),
    );
    handleEpochResultRecorded(epochResultRecorded(AGENT_ID, usdg(20), 1, usdg(20), SETTLE_TS));
    handleEpochSettled(
      epochSettled(VAULT, EPOCH_1, SERIES_ID, wad(260), BigInt.zero(), usdg(20), usdg(2), SETTLE_TS),
    );

    const vault = VAULT.toHexString();
    const epoch = epochId(VAULT, EPOCH_1).toHexString();
    const series = uint256Id(SERIES_ID).toHexString();
    const agent = uint256Id(AGENT_ID).toHexString();

    assert.fieldEquals("Epoch", epoch, "state", "Settled");
    assert.fieldEquals("Epoch", epoch, "settlementPrice", wad(260).toString());
    assert.fieldEquals("Epoch", epoch, "premium", usdg(20).toString());
    assert.fieldEquals("Epoch", epoch, "fee", usdg(2).toString());
    assert.fieldEquals("Epoch", epoch, "agentFee", usdg(1).toString());
    assert.fieldEquals("Epoch", epoch, "payout", "0");
    assert.fieldEquals("Epoch", epoch, "payoutValue", "0");
    assert.fieldEquals("Epoch", epoch, "pnl", usdg(20).toString());
    assert.fieldEquals("Epoch", epoch, "premiumToDepositors", usdg(18).toString());
    assert.fieldEquals("Epoch", epoch, "closedAt", BigInt.fromI64(SETTLE_TS).toString());
    assert.fieldEquals("Epoch", epoch, "pricePerShare", "1");
    // (20 − 2) USDG on 100 TSLA × $250 locked, annualised over the 7-day epoch.
    assert.fieldEquals("Epoch", epoch, "premiumYield", "0.00072");
    const apr = BigDecimal.fromString("0.00072")
      .times(BigDecimal.fromString("31536000"))
      .div(BigDecimal.fromString("604800"));
    assert.fieldEquals("Epoch", epoch, "premiumApr", apr.toString());

    assert.fieldEquals("Series", series, "settled", "true");
    assert.fieldEquals("Series", series, "payoutPerOption", "0");
    assert.fieldEquals(
      "Series",
      series,
      "settlement",
      settlementPriceId(TSLA, BigInt.fromI64(EXPIRY)).toHexString(),
    );
    assert.fieldEquals(
      "SettlementPrice",
      settlementPriceId(TSLA, BigInt.fromI64(EXPIRY)).toHexString(),
      "price",
      wad(260).toString(),
    );

    // Queue at the snapshot price (1:1): 100 − 20 redeemed + 10 deposited.
    assert.fieldEquals("Vault", vault, "locked", "false");
    assert.fieldEquals("Vault", vault, "totalAssets", wad(90).toString());
    assert.fieldEquals("Vault", vault, "totalSupply", wad(90).toString());
    assert.fieldEquals("Vault", vault, "reservedRedeemAssets", wad(20).toString());
    assert.fieldEquals("Vault", vault, "pendingDepositAssets", "0");
    assert.fieldEquals("Vault", vault, "pendingRedeemShares", "0");
    assert.fieldEquals("Vault", vault, "accPremiumPerShare", accPremium.toString());
    assert.fieldEquals("Vault", vault, "cumulativePremium", usdg(20).toString());
    assert.fieldEquals("Vault", vault, "cumulativePremiumToDepositors", usdg(18).toString());
    assert.fieldEquals("Vault", vault, "cumulativeFees", usdg(2).toString());
    assert.fieldEquals("Vault", vault, "settledEpochCount", "1");
    assert.fieldEquals("Vault", vault, "lastPremiumApr", apr.toString());
    assert.fieldEquals("Vault", vault, "tvlUsd", "23400"); // 90 TSLA × $260

    assert.fieldEquals("SharePriceSnapshot", epoch, "pricePerShare", "1");
    assert.fieldEquals("SharePriceSnapshot", epoch, "premiumPerShare", accPremium.toString());

    assert.fieldEquals("Agent", agent, "totalPremiumGenerated", usdg(20).toString());
    assert.fieldEquals("Agent", agent, "totalFeesEarned", usdg(1).toString());
    assert.fieldEquals("Agent", agent, "cumulativePnl", usdg(20).toString());
    assert.fieldEquals("Agent", agent, "lastEpochPnl", usdg(20).toString());
    assert.fieldEquals("Agent", agent, "settledEpochs", "1");

    assert.fieldEquals("FeeAccount", AGENT_PAYOUT.toHexString(), "claimable", usdg(1).toString());
    assert.fieldEquals("FeeAccount", TREASURY.toHexString(), "claimable", usdg(1).toString());

    const day = VAULT.concatI32(dayId(BigInt.fromI64(SETTLE_TS))).toHexString();
    assert.fieldEquals("VaultDayData", day, "premiumSettled", usdg(20).toString());
    assert.fieldEquals("VaultDayData", day, "premiumToDepositors", usdg(18).toString());
    assert.fieldEquals("VaultDayData", day, "fees", usdg(2).toString());
    assert.fieldEquals("VaultDayData", day, "depositedAssets", wad(10).toString());
    assert.fieldEquals("VaultDayData", day, "withdrawnAssets", wad(20).toString());
    assert.fieldEquals("VaultDayData", day, "epochsSettled", "1");
    assert.fieldEquals("VaultDayData", day, "premiumApr", apr.toString());

    const protocol = PROTOCOL_ID.toHexString();
    assert.fieldEquals("ProtocolStats", protocol, "settledEpochCount", "1");
    assert.fieldEquals("ProtocolStats", protocol, "totalPremium", usdg(20).toString());
    assert.fieldEquals("ProtocolStats", protocol, "totalPremiumToDepositors", usdg(18).toString());
    assert.fieldEquals("ProtocolStats", protocol, "totalFees", usdg(2).toString());
    assert.fieldEquals("ProtocolStats", protocol, "totalAgentFees", usdg(1).toString());
    assert.fieldEquals("ProtocolStats", protocol, "treasury", TREASURY.toHexString());
    assert.fieldEquals("ProtocolStats", protocol, "tvlUsd", "23400");

    // Lazy claims after settlement, then the buyer burns worthless options.
    handleDepositClaimed(depositClaimed(VAULT, BOB, EPOCH_1, wad(10), wad(10), SETTLE_TS + 60));
    handleRedeemClaimed(redeemClaimed(VAULT, ALICE, EPOCH_1, wad(20), wad(20), SETTLE_TS + 60));
    const bobRequest = requestId(VAULT, BOB, EPOCH_1).toHexString();
    const aliceRequest = requestId(VAULT, ALICE, EPOCH_1).toHexString();
    assert.fieldEquals("DepositRequest", bobRequest, "status", "Claimed");
    assert.fieldEquals("DepositRequest", bobRequest, "shares", wad(10).toString());
    assert.fieldEquals("RedeemRequest", aliceRequest, "status", "Claimed");
    assert.fieldEquals("RedeemRequest", aliceRequest, "assets", wad(20).toString());
    assert.fieldEquals("Vault", vault, "reservedRedeemAssets", "0");
    assert.entityCount("DepositClaim", 1);
    assert.entityCount("RedeemClaim", 1);

    const redeem = optionsRedeemed(SERIES_ID, BUYER, BUYER, wad(10), BigInt.zero(), SETTLE_TS + 120);
    handleOptionsRedeemed(redeem);
    assert.fieldEquals("Redemption", eventId(redeem).toHexString(), "refund", "false");
    assert.fieldEquals("Series", series, "redeemed", wad(10).toString());
  });

  test("settle in the money: call payout per option and payout value", () => {
    openSellAndBuy();
    const payout = BigInt.fromString("833333333333333330"); // 10 options × (300 − 275) / 300 tokens
    const assetsAfter = wad(100).minus(payout);
    handleSettlementPriceRecorded(
      settlementPriceRecorded(TSLA, EXPIRY, BigInt.fromI32(43), wad(300), SETTLE_TS),
    );
    handleVaultEpochSettled(
      vaultEpochSettled(
        VAULT,
        EPOCH_1,
        payout,
        usdg(20),
        assetsAfter,
        wad(100),
        BigInt.fromString("200000000000000000000000"),
        SETTLE_TS,
      ),
    );
    handleEpochSettled(
      epochSettled(VAULT, EPOCH_1, SERIES_ID, wad(300), payout, usdg(20), BigInt.zero(), SETTLE_TS),
    );

    const epoch = epochId(VAULT, EPOCH_1).toHexString();
    assert.fieldEquals("Series", uint256Id(SERIES_ID).toHexString(), "payoutPerOption", "83333333333333333");
    assert.fieldEquals("Series", uint256Id(SERIES_ID).toHexString(), "payout", payout.toString());
    // 0.8333… TSLA × $300 = $249.999999 (rounded down, as Decimals.valueInUsd)
    assert.fieldEquals("Epoch", epoch, "payoutValue", "249999999");
    assert.fieldEquals("Epoch", epoch, "pnl", "-229999999");
    assert.fieldEquals("Epoch", epoch, "fee", "0");
    assert.fieldEquals("Epoch", epoch, "pricePerShare", "0.9916666666666666667");
    assert.fieldEquals("Vault", VAULT.toHexString(), "cumulativePayout", payout.toString());
    assert.fieldEquals("Vault", VAULT.toHexString(), "cumulativePayoutValue", "249999999");
    assert.fieldEquals("Vault", VAULT.toHexString(), "totalAssets", assetsAfter.toString());
    assert.fieldEquals("Agent", uint256Id(AGENT_ID).toHexString(), "totalPayoutValue", "249999999");
  });
});
