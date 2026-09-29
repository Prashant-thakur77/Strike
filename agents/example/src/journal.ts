import {
  type DecisionRecord,
  type MarketInputs,
  RECORD_VERSION,
  type RecordAction,
  type RecordDecision,
  type RecordDryRun,
  type RecordResult,
  type RecordTrack,
  type RecordTx,
  chainName,
  explorerUrl,
  txUrl,
} from "./record.js";
import type { AgentStats, ProposeResult, RiskCheck, VaultState } from "./types.js";

/**
 * Collects a run's facts as the agent narrates it (first vault read, decision, dry run, transactions, result, track
 * record) and turns them into a {@link DecisionRecord}. Every mode fills what applies; the rest stays null.
 */
export class Journal {
  state: VaultState | null = null;
  decision: RecordDecision | null = null;
  dryRun: RecordDryRun | null = null;
  market: MarketInputs | null = null;
  readonly transactions: RecordTx[] = [];
  result: RecordResult | null = null;
  track: RecordTrack | null = null;

  constructor(
    readonly action: RecordAction,
    readonly chainId: number,
    readonly signer: string | null = null,
  ) {}

  /** The first read of the vault is the "before" picture; later reads do not replace it. */
  vaultRead(state: VaultState) {
    this.state ??= state;
  }

  decided(decision: RecordDecision) {
    this.decision = decision;
  }

  /** Add a note to the decision (a mandate-guard correction, a fallback, a suggestion taken). */
  note(line: string) {
    this.decision?.notes.push(line);
  }

  dryRan(check: RiskCheck) {
    this.dryRun = dryRunFromCheck(check);
  }

  tx(label: string, hash: string | null | undefined) {
    if (hash) this.transactions.push({ label, hash, url: txUrl(this.chainId, hash) });
  }

  finish(result: RecordResult) {
    this.result = result;
  }

  /** Record the outcome of a propose_epoch call: its transactions and accepted / rejected / not sent. */
  proposed(res: ProposeResult, method: "proposeByDelta" | "proposeSeries", expiryIso?: string) {
    this.tx("openEpoch", res.openTxHash);
    this.tx(method, res.txHash);
    this.finish(proposeResult(res, expiryIso));
  }

  tracked(stats: AgentStats) {
    this.track = trackFromStats(stats);
  }

  /** The record, or null when the run never read the vault (nothing to say). */
  build(fallbackError?: string): DecisionRecord | null {
    const s = this.state;
    if (!s) return null;
    const chainTimeIso = s.blockTimeIso;
    const result: RecordResult = this.result ?? {
      status: "failed",
      summary: fallbackError ?? "The run stopped without a result.",
    };
    return {
      version: RECORD_VERSION,
      action: this.action,
      date: chainTimeIso.slice(0, 10),
      chainTimeIso,
      chain: { id: this.chainId, name: chainName(this.chainId), explorer: explorerUrl(this.chainId) },
      agent: { agentId: s.agent.agentId ?? null, signer: this.signer },
      vault: {
        address: s.vault.address,
        symbol: s.vault.symbol,
        name: s.vault.name,
        kind: s.vault.kind,
        underlying: s.vault.underlying.symbol,
        collateral: s.vault.totalAssets,
        collateralAsset: s.vault.asset.symbol,
        epochState: s.vault.epochState,
        mandate: s.vault.mandate,
      },
      market: this.market,
      decision: this.decision,
      dryRun: this.dryRun,
      transactions: this.transactions,
      result,
      trackRecord: this.track,
    };
  }
}

export function dryRunFromCheck(check: RiskCheck): RecordDryRun {
  return {
    ok: check.ok,
    reason: check.reason,
    explanation: check.explanation,
    optionType: check.isCall ? "call" : "put",
    strike: check.proposal.strike,
    delta: check.measured.delta,
    targetDeltaBps: check.proposal.targetDeltaBps,
    expiryIso: check.proposal.expiryIso,
    size: check.proposal.size,
    capacity: check.measured.capacity,
    premiumBps: check.proposal.premiumBps,
    fairValue: check.measured.fairValue,
    yieldBps: check.measured.yieldBps,
  };
}

export function proposeResult(res: ProposeResult, expiryIso?: string): RecordResult {
  if (!res.submitted) return { status: "not-sent", summary: res.explanation, reason: res.reason };
  const expiry =
    res.expiry !== undefined ? new Date(res.expiry * 1000).toISOString() : (expiryIso ?? undefined);
  if (res.accepted) {
    return {
      status: "accepted",
      summary: res.explanation,
      seriesId: res.seriesId,
      strike: res.strike,
      ...(expiry ? { expiryIso: expiry } : {}),
      size: res.size,
    };
  }
  return {
    status: "rejected",
    summary: res.explanation,
    strike: res.strike,
    reason: res.reason,
    slashed: res.slashed,
  };
}

export function trackFromStats(a: AgentStats): RecordTrack {
  return {
    agentId: a.agentId,
    status: a.status,
    active: a.active,
    accepted: a.accepted,
    rejected: a.rejected,
    strikes: a.strikes,
    maxStrikes: a.maxStrikes,
    bond: a.bond,
    settledEpochs: a.settledEpochs,
    cumulativePnl: a.cumulativePnl,
    claimableFees: a.claimableFees,
  };
}

/**
 * Market inputs from the epoch's opening snapshot while an epoch runs (Open or Selling: the contract judges
 * proposals against it), else the live oracle spot and sigma from the vault read.
 */
export function marketInputs(
  state: VaultState,
  snapshot: { state: string; openedAt: number; openSpot: string; openSigma: number } | null,
): MarketInputs {
  const common = { oracleStatus: state.spot.status, marketOpen: state.marketOpen };
  if (snapshot && snapshot.state !== "Idle" && snapshot.openedAt > 0) {
    return {
      spot: snapshot.openSpot,
      sigma: snapshot.openSigma,
      source: "epoch-open snapshot",
      openedAtIso: new Date(snapshot.openedAt * 1000).toISOString(),
      ...common,
    };
  }
  return {
    spot: state.spot.price,
    sigma: state.vault.sigma ?? null,
    source: "live",
    openedAtIso: null,
    ...common,
  };
}
