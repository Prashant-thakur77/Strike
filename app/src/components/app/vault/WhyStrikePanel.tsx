"use client";

import { ArrowUpRight, Ban, Check, ChevronDown, CircleAlert, Minus } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useWhyStrike } from "@/hooks/useWhyStrike";
import {
  AGENT_LOG_FOLDER_URL,
  fmtDecimal,
  fmtDeltaBps,
  fmtFactor,
  fmtLogDate,
  fmtNyIso,
  fmtPrice,
  plannerLabel,
  shortHash,
  strategyLabel,
  verdictOf,
  type LogCandidate,
  type LogRecord,
} from "@/lib/agentLog";
import { CHAIN_META } from "@/lib/chains";
import { shortAddr } from "@/lib/format";
import { REASONS } from "@/lib/labels";
import type { VaultSummary } from "@/lib/reads";
import { WhyStrikeError, type AnchorCheck, type HandRunParsed, type HandRunLog } from "@/lib/whyStrike";
import { useStrike } from "@/hooks/useStrike";
import { Skeleton } from "../Skeleton";
import { Term } from "@/components/ui/Term";
import styles from "../app.module.css";

const LEAD =
  "The agent that runs this vault wrote this before it proposed; the hash of the record is on-chain, so it cannot be changed afterwards.";

/** The agent's reasoning for the vault's live (or last) series, from its anchored decision record. */
export function WhyStrikePanel({ vault }: { vault: VaultSummary }) {
  const q = useWhyStrike(vault);
  const { chainId } = useStrike();

  if (q.isPending) {
    return (
      <div className={styles.whyState} aria-busy="true" data-testid="why-loading">
        <span className="micro micro-muted">Looking for the decision record on GitHub…</span>
        <Skeleton width="70%" />
        <Skeleton width="45%" />
      </div>
    );
  }
  if (q.isError) {
    const e = q.error instanceof WhyStrikeError ? q.error : null;
    return (
      <div className={styles.prompt} role="status" data-testid="why-error">
        <p className="h3">The decision record couldn&apos;t be fetched.</p>
        <p className="body">
          {e?.kind === "http" ? `${e.message} ` : "GitHub could not be reached from this browser. "}
          The records are files in the repository; you can read them there.
        </p>
        <div className={styles.emptyActions}>
          <a href={AGENT_LOG_FOLDER_URL} target="_blank" rel="noreferrer" className="pill pill-small">
            Records on GitHub <ArrowUpRight size={12} aria-hidden />
          </a>
          <button
            type="button"
            className="pill pill-small pill-ghost"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            {q.isFetching ? "Trying…" : "Try again"}
          </button>
        </div>
      </div>
    );
  }

  const w = q.data;
  if (w.kind === "none") {
    return (
      <div className={styles.prompt} data-testid="why-empty" data-reason={w.reason}>
        <p className="h3">
          {w.reason === "no-epoch"
            ? "No epoch has run yet."
            : w.reason === "no-folder"
              ? "No decision records are published for this network."
              : "No record for this series yet."}
        </p>
        <p className="body">
          {w.reason === "no-epoch"
            ? "Once the agent opens the first epoch and proposes a strike, its reasoning appears here."
            : w.reason === "no-folder"
              ? "The agent publishes records for Robinhood Chain testnet and Arbitrum Sepolia only."
              : `The agent commits a record of each run to the repository (epoch ${vault.currentEpoch.toString()} of this vault has none yet: it was opened by hand, or its record is not published).`}
        </p>
        <div className={styles.factLinks}>
          <a href={AGENT_LOG_FOLDER_URL} target="_blank" rel="noreferrer" className="text-link">
            Agent log folder <ArrowUpRight size={12} aria-hidden />
          </a>
          <Link href={`/app/agents?chain=${chainId}#decision-log`} className="text-link">
            Decision log
          </Link>
        </div>
      </div>
    );
  }
  if (w.kind === "log") {
    return <HandRunBody vault={vault} log={w.log} source={w.source} url={w.url} anchor={w.anchor} />;
  }
  return (
    <RecordBody
      vault={vault}
      record={w.record}
      recordUrl={w.recordUrl}
      jsonUrl={w.jsonUrl}
      anchor={w.anchor}
      chainId={chainId}
    />
  );
}

/* ================================================================ a JSON decision record */

function reasonText(name: string | null): string | null {
  if (!name) return null;
  return REASONS.find((r) => r.name === name)?.text ?? null;
}

function RecordBody({
  vault,
  record: r,
  recordUrl,
  jsonUrl,
  anchor,
  chainId,
}: {
  vault: VaultSummary;
  record: LogRecord;
  recordUrl: string;
  jsonUrl: string;
  anchor: AnchorCheck;
  chainId: number;
}) {
  const d = r.decision;
  const v = verdictOf(r.result);
  const VerdictIcon = v.tone === "good" ? Check : v.tone === "bad" ? Ban : Minus;
  const dry = r.dryRun;
  const chosenDelta =
    d?.targetDeltaBps ?? (dry?.delta !== null && dry?.delta !== undefined ? dry.delta * 10_000 : null);
  const chosenPremium = d?.premiumBps ?? dry?.premiumBps ?? null;
  // The planner is named above; a note that only repeats it is dropped.
  const notes = (d?.notes ?? []).filter((n) => n.replace(/\.$/, "") !== d?.planner?.label);
  // The candidates the planner dry-ran, with the final dry run (the exact proposal) last and marked as sent.
  const candidates: (LogCandidate & { final: boolean; delta: number | null })[] = [
    ...(d?.candidates ?? []).map((c) => ({ ...c, final: false, delta: null })),
    ...(dry
      ? [
          {
            targetDeltaBps: chosenDelta,
            premiumBps: dry.premiumBps,
            ok: dry.ok,
            reason: dry.ok ? null : dry.reason,
            strike: dry.strike,
            fairValue: dry.fairValue,
            yieldBps: dry.yieldBps,
            final: true,
            delta: dry.delta,
          },
        ]
      : []),
  ];

  return (
    <div
      className={styles.why}
      data-testid="why-panel"
      data-kind="record"
      data-anchor={anchor.status}
      data-anchor-via={anchor.via ?? undefined}
    >
      <p className={styles.whyLead}>{LEAD}</p>

      <dl className={styles.whyFacts}>
        <div>
          <dt className="micro micro-muted">Planned by</dt>
          <dd data-testid="why-planner">
            <span className={styles.whyValue}>{d ? plannerLabel(d) : "No decision was made"}</span>
            <span className={styles.cellMuted}>
              {fmtLogDate(r.date)} · epoch {(r.anchor?.epoch ?? vault.currentEpoch).toString()} ·{" "}
              {r.agentId ? `agent #${r.agentId}` : "agent unknown"}
              {d?.strategy === "claude" ? " · read-only tools, then the agent's mandate guard" : ""}
            </span>
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Chosen</dt>
          <dd data-testid="why-chosen">
            {chosenDelta !== null ? (
              <span className={styles.whyValue}>
                <span className="mono">{fmtDeltaBps(chosenDelta)}</span> <Term id="delta">delta</Term>
                {chosenPremium !== null ? (
                  <>
                    {" "}
                    · <Term id="premium">premium</Term>{" "}
                    <span className="mono">{fmtFactor(chosenPremium)}</span> of{" "}
                    <Term id="fairValue">fair value</Term>
                  </>
                ) : null}
              </span>
            ) : dry?.strike ? (
              <span className={styles.whyValue}>
                <Term id="strike">strike</Term> <span className="mono">{fmtPrice(dry.strike)}</span> set
                directly
              </span>
            ) : (
              <span className={styles.whyValue}>No target</span>
            )}
            {r.market ? (
              <span className={styles.cellMuted}>
                against {fmtPrice(r.market.spot)} spot, σ{" "}
                {r.market.sigma === null ? "—" : `${(r.market.sigma * 100).toFixed(0)}%`}
                {r.vault.mandateSummary ? (
                  <>
                    {" "}
                    · <Term id="mandate">mandate</Term> {r.vault.mandateSummary}
                  </>
                ) : null}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Contract&apos;s verdict</dt>
          <dd data-testid="why-result">
            <span className={styles.whyVerdict} data-tone={v.tone}>
              <VerdictIcon size={13} aria-hidden />
              {v.label}
            </span>
            <span className={styles.cellMuted}>
              {r.result.status === "accepted" ? (
                <>
                  <Term id="strike">strike</Term> {fmtPrice(r.result.strike)}
                  {r.result.size ? ` · ${fmtDecimal(r.result.size)} options` : ""} · expires{" "}
                  {fmtNyIso(r.result.expiryIso)}
                </>
              ) : r.result.status === "rejected" ? (
                <>
                  {r.result.reason ? <span className="mono">{r.result.reason}</span> : null}
                  {reasonText(r.result.reason) ? `: ${reasonText(r.result.reason)!.toLowerCase()}` : ""}
                  {r.result.slashed !== null
                    ? ` · ${fmtDecimal(r.result.slashed)} USDG slashed from the bond`
                    : ""}
                </>
              ) : (
                r.result.summary || v.label
              )}
            </span>
          </dd>
        </div>
      </dl>

      {candidates.length > 0 ? (
        <div className={styles.whyBlock}>
          <h3 className="micro micro-muted">
            {candidates.length === 1 ? "Dry run before sending" : "Candidates it dry-ran"}
            <span className={styles.whyNote}>
              {" "}
              · <code className="mono">risk_check</code>, the contract&apos;s own{" "}
              <code className="mono">previewProposal</code>
            </span>
          </h3>
          <ul className={styles.whyCands} data-testid="why-candidates">
            {candidates.map((c, i) => (
              <li key={i} className={styles.whyCand} data-ok={c.ok} data-final={c.final || undefined}>
                <span className={styles.whyCandTarget}>
                  <span className="mono">
                    {c.targetDeltaBps !== null
                      ? fmtDeltaBps(c.targetDeltaBps)
                      : c.delta !== null
                        ? c.delta.toFixed(2)
                        : "—"}
                  </span>{" "}
                  delta
                  {c.premiumBps !== null ? (
                    <>
                      {" "}
                      · <span className="mono">{fmtFactor(c.premiumBps)}</span>
                    </>
                  ) : null}
                </span>
                <span className={styles.whyCandSolved}>
                  {c.strike ? (
                    <>
                      strike <span className="mono">{fmtPrice(c.strike)}</span>
                      {c.final && c.delta !== null ? ` (|delta| ${c.delta})` : ""}
                    </>
                  ) : null}
                  {c.fairValue ? (
                    <>
                      {c.strike ? " · " : ""}fair <span className="mono">{fmtPrice(c.fairValue)}</span>
                    </>
                  ) : null}
                  {c.yieldBps !== null ? ` · yield ${fmtFactor(c.yieldBps)} of collateral` : ""}
                  {c.final && dry?.size
                    ? ` · ${fmtDecimal(dry.size)}${dry.capacity ? ` of ${fmtDecimal(dry.capacity)}` : ""} options`
                    : ""}
                </span>
                <span className={styles.whyCandVerdict} data-ok={c.ok}>
                  {c.ok ? <Check size={12} aria-hidden /> : <Ban size={12} aria-hidden />}
                  {c.ok ? "inside the mandate" : `outside: ${c.reason ?? "rejected"}`}
                  {c.final ? <span className={styles.whyCandSent}> · sent</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {dry && !dry.ok && dry.explanation ? <p className={styles.hint}>{dry.explanation}</p> : null}
        </div>
      ) : null}

      {d?.reasoning ? <Reasoning text={d.reasoning} who={strategyLabel(d.strategy)} /> : null}
      {notes.length > 0 ? (
        <ul className={styles.logNotes} aria-label="Mandate guard notes">
          {notes.map((n, i) => (
            <li key={i}>
              <span className="micro micro-muted">Note</span> {n}
            </li>
          ))}
        </ul>
      ) : null}

      <AnchorLine anchor={anchor} chainId={chainId} />

      <div className={styles.whyLinks}>
        <a href={recordUrl} target="_blank" rel="noreferrer" className="text-link">
          Full record on GitHub <ArrowUpRight size={12} aria-hidden />
        </a>
        <a href={jsonUrl} target="_blank" rel="noreferrer" className="text-link">
          The JSON the hash covers <ArrowUpRight size={12} aria-hidden />
        </a>
        <Link href={`/app/agents?chain=${chainId}#decision-log`} className="text-link">
          Decision log on the agents page
        </Link>
      </div>
    </div>
  );
}

/* ================================================================ a hand-run epoch log */

function HandRunBody({
  vault,
  log,
  source,
  url,
  anchor,
}: {
  vault: VaultSummary;
  log: HandRunParsed;
  source: HandRunLog;
  url: string;
  anchor: AnchorCheck;
}) {
  const { chainId } = useStrike();
  const tone = log.accepted === true ? "good" : log.accepted === false ? "bad" : "neutral";
  const VerdictIcon = tone === "good" ? Check : tone === "bad" ? Ban : Minus;
  return (
    <div
      className={styles.why}
      data-testid="why-panel"
      data-kind="log"
      data-anchor={anchor.status}
      data-anchor-via={anchor.via ?? undefined}
    >
      <p className={styles.whyLead}>{LEAD}</p>
      <dl className={styles.whyFacts}>
        <div>
          <dt className="micro micro-muted">Planned by</dt>
          <dd data-testid="why-planner">
            <span className={styles.whyValue}>
              Rule-based: the example agent&apos;s default strategy, run by hand on {source.ran}
            </span>
            <span className={styles.cellMuted}>
              epoch {source.epoch} · agent #{vault.agentId.toString()} · before the agent wrote structured
              records; this is its epoch log
            </span>
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Chosen</dt>
          <dd data-testid="why-chosen">
            {log.targetDelta ? (
              <span className={styles.whyValue}>
                <span className="mono">{log.targetDelta}</span> <Term id="delta">delta</Term>
                {log.premiumPct ? (
                  <>
                    {" "}
                    · <Term id="premium">premium</Term> <span className="mono">{log.premiumPct}%</span> of{" "}
                    <Term id="fairValue">fair value</Term>
                  </>
                ) : null}
              </span>
            ) : (
              <span className={styles.whyValue}>See the log</span>
            )}
            {log.strikeLines.length > 0 ? (
              <span className={styles.cellMuted}>{log.strikeLines.join(" ")}</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Contract&apos;s verdict</dt>
          <dd data-testid="why-result">
            <span className={styles.whyVerdict} data-tone={tone}>
              <VerdictIcon size={13} aria-hidden />
              {log.accepted === true ? "Accepted" : log.accepted === false ? "Rejected" : "Unknown"}
            </span>
            <span className={styles.cellMuted}>
              {log.accepted && log.strike ? (
                <>
                  <Term id="strike">strike</Term> {fmtPrice(log.strike)}
                </>
              ) : log.reason ? (
                <span className="mono">{log.reason}</span>
              ) : null}
              {log.verdict ? ` · dry run: ${log.verdict}` : ""}
            </span>
          </dd>
        </div>
      </dl>
      {log.reasoning ? <Reasoning text={log.reasoning} who="Rule-based" /> : null}
      <AnchorLine anchor={anchor} chainId={chainId} />
      <div className={styles.whyLinks}>
        <a href={url} target="_blank" rel="noreferrer" className="text-link">
          The epoch log on GitHub <ArrowUpRight size={12} aria-hidden />
        </a>
        <Link href={`/app/agents?chain=${chainId}#decision-log`} className="text-link">
          Decision log on the agents page
        </Link>
      </div>
    </div>
  );
}

/* ================================================================ shared pieces */

const STATUS_TEXT: Record<AnchorCheck["status"], string> = {
  match: "hash matches",
  mismatch: "hash does not match",
  "bad-tx": "the anchor transaction does not check out",
  "no-anchor": "no anchor",
  "unknown-contract": "anchored in a contract this app does not know",
  unreadable: "the chain could not be read",
};

const TX_PROBLEM: Record<string, string> = {
  "wrong-emitter": "its DecisionRecorded event was emitted by a contract that is not a deployed DecisionLog",
  "wrong-target": "it anchored a record for another agent, vault or epoch",
  "no-event": "it emitted no DecisionRecorded event",
  reverted: "it reverted",
};

/**
 * keccak256 of the record against its own anchoring transaction on the vault's chain (the DecisionRecorded event of a
 * deployed DecisionLog for this agent, vault and epoch), with DecisionLog.latestHash as secondary information.
 */
function AnchorLine({ anchor: a, chainId }: { anchor: AnchorCheck; chainId: number }) {
  const chain = CHAIN_META[chainId as keyof typeof CHAIN_META]?.label ?? `chain ${chainId}`;
  const Icon =
    a.status === "match" ? Check : a.status === "mismatch" || a.status === "bad-tx" ? Ban : CircleAlert;
  const log = `${a.version ? `${a.version} ` : ""}DecisionLog on ${chain}`;
  const explain: ReactNode =
    a.status === "match" ? (
      <>
        {a.via === "tx" ? (
          <>
            keccak256 of the record, rebuilt here from the file on GitHub, equals the hash agent #{a.agentId}{" "}
            anchored in its own transaction: the DecisionRecorded event of the {log} for this vault and epoch{" "}
            {a.epoch}
          </>
        ) : (
          <>
            keccak256 of the record, rebuilt here from the file on GitHub, equals the hash agent #{a.agentId}{" "}
            committed to the {log} for epoch {a.epoch} (latestHash)
          </>
        )}
        {a.claimed && a.claimed.toLowerCase() !== a.computed.toLowerCase()
          ? "; the record's own anchor field disagrees with it"
          : ""}
        .
        {a.superseded && a.latest ? (
          <span className={styles.whyLater} data-testid="why-anchor-later">
            {" "}
            A later record for this epoch exists: latestHash now holds{" "}
            <span className="mono" title={a.latest}>
              {shortHash(a.latest)}
            </span>{" "}
            (for example the settlement record), which does not change this one&apos;s anchor.
          </span>
        ) : null}
      </>
    ) : a.status === "mismatch" ? (
      <>
        keccak256 of the file on GitHub is not the hash{" "}
        {a.via === "tx" ? "its anchor transaction committed to the" : "committed to the"} {log} for epoch{" "}
        {a.epoch}: the record changed after it was anchored, or this is not the file that was anchored.
      </>
    ) : a.status === "bad-tx" ? (
      <>
        the transaction the record names as its anchor is not one:{" "}
        {TX_PROBLEM[a.txProblem ?? ""] ?? "it does not anchor this record"}.
      </>
    ) : a.status === "no-anchor" ? (
      <>
        the DecisionLog on {chain} holds no hash for agent #{a.agentId}, this vault and epoch {a.epoch}.
      </>
    ) : a.status === "unknown-contract" ? (
      <>
        the record names {a.contract ? shortAddr(a.contract) : "a contract"} as its DecisionLog; this app only
        reads the deployed ones.
      </>
    ) : (
      <>{a.error ?? "The RPC did not answer."}</>
    );
  return (
    <p className={styles.whyAnchor} data-testid="why-anchor" data-status={a.status}>
      <span className={styles.whyAnchorState} data-status={a.status}>
        <Icon size={13} aria-hidden />
        <Term id="anchored">Anchored on-chain</Term>:{" "}
        <span data-testid="why-anchor-status">{STATUS_TEXT[a.status]}</span>
        {a.status === "match" && a.via === "tx" && a.txHash ? (
          <span className={styles.whyAnchorVia} data-testid="why-anchor-via">
            {" "}
            (anchored in tx <span className="mono">{shortHash(a.txHash)}</span>)
          </span>
        ) : null}
      </span>
      <span className={styles.whyAnchorText}>
        {explain}{" "}
        <span className={styles.whyHash}>
          hash{" "}
          <span className="mono" title={a.computed} aria-hidden>
            {shortHash(a.computed)}
          </span>
          <span className="sr-only">{a.computed}</span>
        </span>
        {a.contract ? (
          <>
            {" "}
            · DecisionLog{" "}
            <span className="mono" title={a.contract}>
              {shortAddr(a.contract)}
            </span>
          </>
        ) : null}
        {a.txHash ? (
          <>
            {" "}
            ·{" "}
            {a.txUrl ? (
              <a href={a.txUrl} target="_blank" rel="noreferrer" className="text-link" title={a.txHash}>
                anchor tx <span className="mono">{shortHash(a.txHash)}</span>
                <ArrowUpRight size={11} aria-hidden />
              </a>
            ) : (
              <span title={a.txHash}>
                anchor tx <span className="mono">{shortHash(a.txHash)}</span>
              </span>
            )}
          </>
        ) : null}
      </span>
    </p>
  );
}

/** The agent's reasoning, quoted and clamped to about four lines, with a toggle when it overflows. */
function Reasoning({ text, who }: { text: string; who: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const id = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.dataset.open === "true") return;
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <figure className={styles.logWhy} data-testid="why-reasoning">
      <figcaption className="micro micro-muted">Why · {who}</figcaption>
      <blockquote>
        <p ref={ref} id={id} className={styles.logWhyText} data-open={open}>
          {text}
        </p>
      </blockquote>
      {overflows || open ? (
        <button
          type="button"
          className={styles.logWhyToggle}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Less" : "More"}
          <ChevronDown size={13} aria-hidden />
        </button>
      ) : null}
    </figure>
  );
}
