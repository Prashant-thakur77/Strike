// The settlement check for the vault page's epoch trace: the SDK's `auditSettlement` (sdk/src/mirror.ts) as JSON for
// /api/settlement-audit, and the line the trace shows. Pure, with only type imports from the SDK, so the Playwright
// specs load it as it is.

import type { SettlementAudit, SettlementCheckStatus } from "@strike/sdk";

export interface SeriesSettlementJson {
  seriesId: string;
  epoch: string | null;
  symbol: string;
  expiry: number;
  settled: boolean;
  status: SettlementCheckStatus;
  /** The testnet round settlement used or will use, and the mainnet Chainlink round it equals. */
  roundId: string | null;
  roundSource: "recorded" | "candidate" | null;
  recordTx: string | null;
  mainnetRoundId: string | null;
  mainnetPhase: number | null;
  mainnetAggregatorRound: string | null;
  /** The testnet round is the first mainnet print at or after expiry (what a mainnet settlement would use). */
  sameAsMainnetSettlement: boolean | null;
  skippedMainnetRounds: number;
  message: string;
}

export interface SettlementAuditJson {
  chainId: number;
  vault: string;
  version: string | null;
  ok: boolean;
  /** When the testnet was read, unix seconds. */
  testnetTime: number;
  series: SeriesSettlementJson[];
}

export function toSettlementAuditJson(a: SettlementAudit): SettlementAuditJson {
  return {
    chainId: a.chainId,
    vault: a.vault,
    version: a.version,
    ok: a.ok,
    testnetTime: Number(a.testnetTime),
    series: a.series.map((s) => ({
      seriesId: s.seriesId.toString(),
      epoch: s.epoch === null ? null : s.epoch.toString(),
      symbol: s.symbol,
      expiry: Number(s.expiry),
      settled: s.settled,
      status: s.status,
      roundId: s.round ? s.round.roundId.toString() : null,
      roundSource: s.roundSource,
      recordTx: s.recordTx,
      mainnetRoundId: s.round?.mainnet ? s.round.mainnet.roundId.toString() : null,
      mainnetPhase: s.round?.mainnet ? s.round.mainnet.phase : null,
      mainnetAggregatorRound: s.round?.mainnet ? s.round.mainnet.aggregatorRound.toString() : null,
      sameAsMainnetSettlement: s.sameAsMainnetSettlement,
      skippedMainnetRounds: s.skippedMainnetRounds,
      message: s.message,
    })),
  };
}

/** The trace's verdict on one series' settlement round. */
export function settlementLine(s: SeriesSettlementJson): { tone: "good" | "bad" | "neutral"; text: string } {
  const mainnet =
    s.mainnetRoundId !== null
      ? `mainnet Chainlink round ${s.mainnetRoundId} (phase ${s.mainnetPhase}, aggregator round ${s.mainnetAggregatorRound})`
      : null;
  switch (s.status) {
    case "verified":
      return {
        tone: "good",
        text: `Round ${s.roundId} matches ${mainnet}: same time, same answer.${
          s.sameAsMainnetSettlement
            ? " It is the first mainnet print at or after expiry, the round a mainnet settlement would use."
            : s.sameAsMainnetSettlement === false
              ? ` Not the first mainnet print after expiry: the keeper skipped ${s.skippedMainnetRounds} earlier round(s).`
              : ""
        }`,
      };
    case "candidate-verified":
      return {
        tone: "good",
        text: `Expired, not settled yet: it will settle at round ${s.roundId}, which matches ${mainnet}.`,
      };
    case "mismatch":
      return { tone: "bad", text: s.message };
    case "no-price":
      return { tone: "neutral", text: "Settled without a price: no options were sold." };
    case "cancelled":
      return { tone: "neutral", text: "Cancelled: the series never settles." };
    default:
      return { tone: "neutral", text: s.message };
  }
}
