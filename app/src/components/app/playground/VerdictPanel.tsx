"use client";

import { maxProposalSize } from "@strike/sdk";
import { CircleAlert, CircleCheck, CircleX, Gavel } from "lucide-react";
import { formatUnits } from "viem";
import { fmtDollars, fmtWadUsd } from "@/lib/format";
import {
  absDelta,
  explainReason,
  fmtDays,
  fmtTokens,
  nyTime,
  revertMeaning,
  slashConsequence,
  type PlaygroundSnapshot,
  type PreviewOutcome,
  type ProposalMeasures,
  type VaultContext,
} from "@/lib/playground";
import { Skeleton } from "../Skeleton";
import styles from "./playground.module.css";

interface VerdictPanelProps {
  snap: PlaygroundSnapshot | undefined;
  ctx: VaultContext | undefined;
  outcome: PreviewOutcome | undefined;
  /** Inputs changed and the contract is being asked again. */
  busy: boolean;
  /** A local input problem (nothing is sent to the chain). */
  invalid: string | null;
  /** Network failure (not a contract revert). */
  error: string | null;
}

export function measuresOf(outcome: PreviewOutcome, ctx: VaultContext, now: bigint): ProposalMeasures {
  return {
    isCall: ctx.vault.isCall,
    spot: ctx.refSpot,
    strike: outcome.input.strike,
    expiry: outcome.input.expiry,
    now,
    size: outcome.input.size,
    premiumBps: outcome.input.premiumBps,
    preview: outcome.kind === "verdict" ? outcome.preview : null,
    underlyingDecimals: ctx.vault.underlyingDecimals,
    symbol: ctx.vault.underlyingSymbol,
  };
}

export function VerdictPanel({ snap, ctx, outcome, busy, invalid, error }: VerdictPanelProps) {
  const kind =
    outcome?.kind === "verdict" ? (outcome.preview.accepted ? "accepted" : "rejected") : outcome?.kind;
  const reason = outcome?.kind === "verdict" ? outcome.preview.reason : outcome?.revert.name;
  return (
    <section
      className={`theme-ink ${styles.verdict}`}
      aria-labelledby="pg-verdict"
      aria-busy={busy || !outcome}
      data-testid="verdict"
      data-kind={invalid ? "invalid" : (kind ?? "pending")}
      data-reason={invalid ? undefined : reason}
      data-busy={busy || undefined}
    >
      <div className={styles.verdictTop}>
        <h2 id="pg-verdict" className="micro">
          <span className="index">02</span>&nbsp;&nbsp; Verdict · EpochManager.previewProposal
        </h2>
        <span className={`micro micro-muted ${styles.busy}`} data-busy={busy || undefined}>
          {busy ? "Asking the contract…" : outcome ? "Live from chain 46630" : "Waiting"}
        </span>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        {invalid ? (
          <div className={styles.outcome} data-kind="revert">
            <span className={styles.badge}>
              <CircleAlert aria-hidden /> Not sent
            </span>
            <p className={styles.explain}>{invalid}</p>
          </div>
        ) : error && !outcome ? (
          <div className={styles.outcome} data-kind="revert">
            <span className={styles.badge}>
              <CircleAlert aria-hidden /> RPC unreachable
            </span>
            <p className={styles.explain}>Couldn&apos;t reach Robinhood Chain testnet: {error}</p>
          </div>
        ) : outcome && ctx && snap ? (
          <Outcome outcome={outcome} ctx={ctx} snap={snap} />
        ) : (
          <div className={styles.placeholder} aria-hidden>
            <Skeleton width="7em" />
            <Skeleton width="80%" />
            <Skeleton width="60%" />
          </div>
        )}
      </div>
    </section>
  );
}

function Outcome({
  outcome,
  ctx,
  snap,
}: {
  outcome: PreviewOutcome;
  ctx: VaultContext;
  snap: PlaygroundSnapshot;
}) {
  const m = measuresOf(outcome, ctx, snap.blockTimestamp);
  const mandate = ctx.vault.mandate;
  const dec = ctx.vault.underlyingDecimals;
  const sym = ctx.vault.underlyingSymbol;

  if (outcome.kind === "revert") {
    const meaning = revertMeaning(outcome.revert);
    return (
      <div className={styles.outcome} data-kind="revert">
        <span className={styles.badge}>
          <CircleAlert aria-hidden /> Reverts
        </span>
        <p className={styles.headline}>
          <span>Reverts:</span> <span className={styles.reasonName}>{outcome.revert.name}</span>
        </p>
        <p className={styles.explain}>
          <strong>{meaning.title}.</strong> {meaning.text}
        </p>
        <p className={styles.sig}>
          {outcome.stage === "solve" ? "solving the strike · " : "previewProposal · "}
          {outcome.revert.signature}
        </p>
        <p className={styles.onchain}>
          A revert undoes the whole call: the contract gives no verdict, lists nothing and slashes nobody.
        </p>
      </div>
    );
  }

  const pv = outcome.preview;
  const x = explainReason(pv.reason, mandate, m);
  const perOption = (pv.fairValue * BigInt(outcome.input.premiumBps)) / 10_000n;
  const total = (perOption * outcome.input.size) / 10n ** BigInt(dec);
  const figures = (
    <dl className={styles.figures}>
      <div>
        <dt className="micro micro-muted">Strike</dt>
        <dd>
          {fmtWadUsd(outcome.strike)}
          <small>{outcome.input.mode === "delta" ? "solved on-chain" : "as proposed"}</small>
        </dd>
      </div>
      <div>
        <dt className="micro micro-muted">Fair value</dt>
        <dd>
          {fmtWadUsd(pv.fairValue, pv.fairValue < 10n ** 16n ? 4 : 2)}
          <small>Black-Scholes, per option</small>
        </dd>
      </div>
      <div>
        <dt className="micro micro-muted">|Delta|</dt>
        <dd>
          {absDelta(pv.delta).toFixed(4)}
          <small>
            band {(mandate.minDeltaBps / 1e4).toFixed(2)}–{(mandate.maxDeltaBps / 1e4).toFixed(2)}
          </small>
        </dd>
      </div>
      <div>
        <dt className="micro micro-muted">Capacity</dt>
        <dd>
          {fmtTokens(pv.capacity, dec)}
          <small>
            max {fmtTokens(maxProposalSize(pv.capacity, mandate), dec)} {sym} to sell
          </small>
        </dd>
      </div>
      <div>
        <dt className="micro micro-muted">Premium</dt>
        <dd>
          {fmtDollars(total, 18)}
          <small>
            {fmtWadUsd(perOption, perOption < 10n ** 16n ? 4 : 2)} × {fmtTokens(outcome.input.size, dec)}
          </small>
        </dd>
      </div>
      <div>
        <dt className="micro micro-muted">Expiry</dt>
        <dd>
          {nyTime(outcome.input.expiry).split(", ").slice(0, 2).join(" ")}
          <small>
            {nyTime(outcome.input.expiry).split(", ")[2]} ·{" "}
            {fmtDays(Number(outcome.input.expiry - snap.blockTimestamp))} away
          </small>
        </dd>
      </div>
    </dl>
  );

  if (pv.accepted) {
    return (
      <div className={styles.outcome} data-kind="accepted">
        <span className={styles.badge}>
          <CircleCheck aria-hidden /> Accepted
        </span>
        <p className={styles.headline}>
          <span>Accepted:</span> <span>the contract would list this series.</span>
        </p>
        <p className={styles.explain}>
          {x.text} The agent&apos;s acceptance is recorded on-chain; no bond is touched.
        </p>
        {figures}
      </div>
    );
  }

  const agent = snap.agents[ctx.vault.agentId.toString()];
  const usdg = (v: bigint) => `${Number(formatUnits(v, snap.usdgDecimals)).toLocaleString("en-US")} USDG`;
  const c = agent ? slashConsequence(snap.registry, agent) : null;
  const open = ctx.epoch.state === "Open";
  return (
    <div className={styles.outcome} data-kind="rejected">
      <span className={styles.badge}>
        <CircleX aria-hidden /> Rejected
      </span>
      <p className={styles.headline}>
        <span>Rejected:</span> <span className={styles.reasonName}>{pv.reason}</span>
      </p>
      <p className={styles.explain}>
        <strong>{x.headline}.</strong> {x.text}
      </p>
      {agent && c ? (
        <div className={styles.consequence}>
          <strong>
            <Gavel aria-hidden />
            <span>
              {open ? "The" : "If proposed during an Open epoch, the"} agent&apos;s bond would be slashed by{" "}
              {usdg(c.slashed)}, paid to this vault&apos;s depositors; {c.strikesAfter}/
              {snap.registry.maxStrikes} strikes.
            </span>
          </strong>
          <p>
            <span className={styles.pips} aria-hidden>
              {Array.from({ length: snap.registry.maxStrikes }, (_, i) => (
                <i key={i} data-on={i < agent.strikes ? "before" : i < c.strikesAfter ? "now" : undefined} />
              ))}
            </span>{" "}
            Agent #{agent.agentId.toString()} has {agent.strikes} strike{agent.strikes === 1 ? "" : "s"} and a{" "}
            {usdg(agent.bond)} bond.{" "}
            {c.suspended
              ? `Strike ${c.strikesAfter} suspends it: it can never propose again.`
              : c.underBond
                ? `The bond would drop to ${usdg(c.bondAfter)}, under the ${usdg(snap.registry.minBond)} minimum, so it could not propose again until it tops up.`
                : `The bond would drop to ${usdg(c.bondAfter)}.`}{" "}
            The rejection is final: the transaction succeeds and emits <code>ProposalRejected</code>, so the
            slash cannot be rolled back.
          </p>
          {!agent.active ? (
            <p>
              Agent #{agent.agentId.toString()} is not active right now, so a real proposal would revert with{" "}
              <code>AgentNotActive</code> before being judged.
            </p>
          ) : null}
        </div>
      ) : null}
      {figures}
    </div>
  );
}
