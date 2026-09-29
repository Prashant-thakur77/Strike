import { describe, expect, it } from "vitest";
import { type Alert, formatAlert, splitMessage, usd, utc } from "../src/format.js";
import {
  CC_SERIES,
  CC_VAULT,
  CSP_VAULT,
  DEPLOYER,
  EXPIRY,
  FORMAT,
  SERIES_ID,
  STRIKE_CC,
  TX,
  WAD,
} from "./fixtures.js";

const link = (hash: string) => `Tx: https://explorer.testnet.chain.robinhood.com/tx/${hash}`;

describe("formatAlert (real 46630 logs)", () => {
  it("EpochOpened: vault, epoch, spot at open, tx link", () => {
    const a: Alert = {
      name: "EpochOpened",
      vault: CC_VAULT,
      epoch: 1n,
      spot: 352_453_000_000_000_000_000n,
      txHash: TX.epochOpened,
      blockNumber: 126_302_279n,
      logIndex: 3,
    };
    expect(formatAlert(a, FORMAT)).toBe(
      [
        "sTSLA-CC: epoch 1 opened",
        "TSLA spot at open: $352.453. The vault is locked until the epoch closes.",
        link(TX.epochOpened),
      ].join("\n"),
    );
  });

  it("SeriesProposed: the covered call at $369.86, expiry in UTC, size, fair value and delta", () => {
    const a: Alert = {
      name: "SeriesProposed",
      vault: CC_VAULT,
      epoch: 1n,
      seriesId: SERIES_ID,
      strike: STRIKE_CC,
      expiry: EXPIRY,
      size: 4n * WAD,
      premiumBps: 10_000,
      fairValue: 2_126_678_382_777_417_825n,
      delta: 200_043_397_642_121_272n,
      txHash: TX.seriesProposed,
      blockNumber: 126_302_301n,
      logIndex: 2,
    };
    expect(formatAlert(a, FORMAT)).toBe(
      [
        "sTSLA-CC: new call series on sale (epoch 1)",
        "Strike $369.86, expiry 2026-10-02 20:00 UTC",
        "Size 4 TSLA calls at 100% of fair value ($2.1266 per option), |delta| 0.20",
        link(TX.seriesProposed),
      ].join("\n"),
    );
  });

  it("ProposalRejected: the put with the reason name and the 10 USDG slash", () => {
    const a: Alert = {
      name: "ProposalRejected",
      vault: CSP_VAULT,
      epoch: 1n,
      agentId: 1n,
      reason: 8,
      slashed: 10_000_000n,
      strike: 352_440_000_000_000_000_000n,
      expiry: EXPIRY,
      size: 45_397_798_206_786_970n,
      premiumBps: 10_000,
      txHash: TX.proposalRejected,
      blockNumber: 126_302_448n,
      logIndex: 4,
    };
    expect(formatAlert(a, FORMAT)).toBe(
      [
        "sTSLA-CSP: agent 1 proposal rejected, DeltaOutOfBand (epoch 1)",
        "Slashed 10 USDG from the agent's bond; it goes to the vault's depositors at epoch close.",
        "Proposed 0.045397 TSLA puts, strike $352.44, expiry 2026-10-02 20:00 UTC, 100% of fair value",
        "Why: The option's |delta| is outside the mandate's delta band.",
        link(TX.proposalRejected),
      ].join("\n"),
    );
  });

  it("ProposalRejected without a slash, and an unknown reason code, still format", () => {
    const text = formatAlert(
      {
        name: "ProposalRejected",
        vault: CSP_VAULT,
        epoch: 2n,
        agentId: 3n,
        reason: 42,
        slashed: 0n,
        strike: 300n * WAD,
        expiry: EXPIRY,
        size: WAD,
        premiumBps: 9_500,
        txHash: TX.proposalRejected,
        blockNumber: 1n,
        logIndex: 0,
      },
      FORMAT,
    );
    expect(text).toContain("agent 3 proposal rejected, reason 42 (epoch 2)");
    expect(text).toContain("No bond was slashed.");
    expect(text).toContain("Proposed 1 TSLA put, strike $300.00");
    expect(text).toContain("95% of fair value");
    expect(text).not.toContain("Why:");
  });

  it("OptionsBought: 4 calls for 10.005944 USDG, per-option price, buyer", () => {
    const a: Alert = {
      name: "OptionsBought",
      vault: CC_VAULT,
      seriesId: SERIES_ID,
      series: CC_SERIES,
      buyer: DEPLOYER,
      recipient: DEPLOYER,
      amount: 4n * WAD,
      premium: 10_005_944n,
      txHash: TX.optionsBought,
      blockNumber: 126_302_569n,
      logIndex: 1,
    };
    expect(formatAlert(a, FORMAT)).toBe(
      [
        "sTSLA-CC: 4 TSLA calls bought for 10.005944 USDG",
        "Strike $369.86, expiry 2026-10-02 20:00 UTC, 2.501486 USDG per option",
        "Buyer 0x26b2…13Ff",
        link(TX.optionsBought),
      ].join("\n"),
    );
  });

  it("OptionsBought names a different recipient", () => {
    const text = formatAlert(
      {
        name: "OptionsBought",
        vault: CC_VAULT,
        seriesId: SERIES_ID,
        series: CC_SERIES,
        buyer: DEPLOYER,
        recipient: CSP_VAULT.address,
        amount: WAD,
        premium: 2_501_486n,
        txHash: TX.optionsBought,
        blockNumber: 1n,
        logIndex: 0,
      },
      FORMAT,
    );
    expect(text).toContain("sTSLA-CC: 1 TSLA call bought for 2.501486 USDG");
    expect(text).toContain("Buyer 0x26b2…13Ff, recipient 0xE33E…67d7");
  });
});

describe("formatAlert (settlement paths, made-up outcomes on the same vaults)", () => {
  const settled = (over: Partial<Extract<Alert, { name: "EpochSettled" }>>): Alert => ({
    name: "EpochSettled",
    vault: CC_VAULT,
    epoch: 1n,
    seriesId: SERIES_ID,
    series: CC_SERIES,
    settlementPrice: 380n * WAD,
    payout: 106_736_842_105_263_156n,
    premium: 10_005_944n,
    fee: 1_000_594n,
    txHash: TX.settled,
    blockNumber: 126_900_000n,
    logIndex: 0,
    ...over,
  });

  it("EpochSettled in the money: price, payout in the vault asset, premium and fee", () => {
    expect(formatAlert(settled({}), FORMAT)).toBe(
      [
        "sTSLA-CC: epoch 1 settled at $380.00",
        "Series: call strike $369.86, expiry 2026-10-02 20:00 UTC. In the money: holders receive 0.106736 TSLA.",
        "Premium 10.005944 USDG, fee 1.000594 USDG",
        link(TX.settled),
      ].join("\n"),
    );
  });

  it("EpochSettled out of the money", () => {
    const text = formatAlert(settled({ settlementPrice: 360n * WAD, payout: 0n, fee: 0n }), FORMAT);
    expect(text).toContain("settled at $360.00");
    expect(text).toContain("Out of the money: the options expired worthless.");
    expect(text).toContain("fee 0 USDG");
  });

  it("EpochSettled with nothing sold (no settlement price)", () => {
    const text = formatAlert(settled({ settlementPrice: 0n, payout: 0n, premium: 0n, fee: 0n }), FORMAT);
    expect(text.split("\n")[0]).toBe("sTSLA-CC: epoch 1 settled, no options were sold");
    expect(text).not.toContain("Premium");
  });

  it("EpochAborted", () => {
    const a: Alert = {
      name: "EpochAborted",
      vault: CSP_VAULT,
      epoch: 1n,
      txHash: TX.aborted,
      blockNumber: 126_400_000n,
      logIndex: 0,
    };
    expect(formatAlert(a, FORMAT)).toBe(
      [
        "sTSLA-CSP: epoch 1 aborted",
        "No series was accepted. The epoch closed without a sale and the vault is unlocked.",
        link(TX.aborted),
      ].join("\n"),
    );
  });

  it("SeriesCancelled", () => {
    const a: Alert = {
      name: "SeriesCancelled",
      vault: CC_VAULT,
      epoch: 1n,
      seriesId: SERIES_ID,
      series: CC_SERIES,
      txHash: TX.cancelled,
      blockNumber: 127_000_000n,
      logIndex: 0,
    };
    expect(formatAlert(a, FORMAT)).toBe(
      [
        "sTSLA-CC: series cancelled (epoch 1)",
        "Call strike $369.86, expiry 2026-10-02 20:00 UTC. No settlement price was recorded in time; holders can redeem their options for a premium refund.",
        link(TX.cancelled),
      ].join("\n"),
    );
  });

  it("without an explorer the link is the bare hash", () => {
    const a: Alert = { ...settled({}) };
    expect(formatAlert(a, { explorerUrl: "", usdgDecimals: 6 })).toContain(`Tx: ${TX.settled}`);
  });
});

describe("helpers", () => {
  it("usd keeps cents, up to 4 decimals, and groups thousands", () => {
    expect(usd(STRIKE_CC)).toBe("$369.86");
    expect(usd(352_453_000_000_000_000_000n)).toBe("$352.453");
    expect(usd(1204n * WAD + WAD / 2n)).toBe("$1,204.50");
    expect(usd(0n)).toBe("$0.00");
  });

  it("utc prints minutes in UTC", () => {
    expect(utc(EXPIRY)).toBe("2026-10-02 20:00 UTC");
  });

  it("splitMessage keeps short text and splits long text at line breaks", () => {
    expect(splitMessage("hi")).toEqual(["hi"]);
    const parts = splitMessage(["aaaa", "bbbb", "cccc"].join("\n"), 9);
    expect(parts).toEqual(["aaaa\nbbbb", "cccc"]);
    expect(splitMessage("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"]);
  });
});
