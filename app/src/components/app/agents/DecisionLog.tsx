"use client";

import { ArrowUpRight, Ban, Check, ChevronDown, Minus } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useAgentLog } from "@/hooks/queries";
import {
  AGENT_LOG_FOLDER_URL,
  AGENT_WORKFLOW_URL,
  AgentLogError,
  FIRST_EPOCH_LOG_URL,
  actionLabel,
  fmtDecimal,
  fmtDeltaBps,
  fmtFactor,
  fmtLogDate,
  fmtNyIso,
  fmtPrice,
  fmtRunTime,
  fmtSigma,
  fmtUtcClock,
  kindLabel,
  kindTone,
  nextRun,
  shortHash,
  sourceLabel,
  strategyLabel,
  verdictOf,
  type LogEntry,
  type LogRecord,
} from "@/lib/agentLog";
import { decisionPath, isRecordName } from "@/lib/decision";
import { REASONS } from "@/lib/labels";
import { Skeleton } from "../Skeleton";
import styles from "../app.module.css";

/** Cards shown before "Show older records". */
const FIRST_PAGE = 4;

/** The weekly agent's decision records, newest first, from docs/agent-log on GitHub. */
export function DecisionLog() {
  const q = useAgentLog();
  const [all, setAll] = useState(false);

  if (q.isPending) {
    return (
      <div className={styles.logLoading} aria-busy="true">
        <Skeleton width="60%" />
        <span className="sr-only">Loading the decision log from GitHub</span>
      </div>
    );
  }
  if (q.isError) return <LogFallback error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />;

  const { entries, skipped } = q.data;
  if (entries.length === 0) return <LogEmpty skipped={skipped} />;
  const shown = all ? entries : entries.slice(0, FIRST_PAGE);
  const hidden = entries.length - shown.length;
  return (
    <div className={styles.log}>
      <ol className={styles.logList} aria-label="Decision records, newest first">
        {shown.map((e) => (
          <li key={e.name}>
            <LogCard entry={e} />
          </li>
        ))}
      </ol>
      <div className={styles.logMore}>
        {hidden > 0 ? (
          <button type="button" className="pill pill-small pill-ghost" onClick={() => setAll(true)}>
            Show {hidden} older record{hidden === 1 ? "" : "s"}
          </button>
        ) : null}
        <a href={AGENT_LOG_FOLDER_URL} target="_blank" rel="noreferrer" className="text-link">
          Every record on GitHub <ArrowUpRight size={12} aria-hidden />
        </a>
        {skipped > 0 ? (
          <span className="micro micro-muted">
            {skipped} record{skipped === 1 ? "" : "s"} in a format this page can&apos;t read
          </span>
        ) : null}
      </div>
    </div>
  );
}

function LogEmpty({ skipped }: { skipped: number }) {
  // Read the clock after mount, so the server render and the first client render agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const run = now === null ? null : nextRun(now);
  return (
    <div className={styles.logEmpty}>
      <p className={styles.logEmptyTitle}>
        {run === null
          ? "No decision records yet."
          : run.first
            ? `The weekly agent publishes its first record on ${fmtRunTime(run.at)}.`
            : `No records yet. The weekly agent runs next on ${fmtRunTime(run.at)}.`}
      </p>
      <p className="body">
        Every Monday it proposes the week&apos;s strike for each vault, every Friday it settles, and each run
        commits a record of what it saw, what it chose and why, and what the contract said.
        {skipped > 0
          ? ` ${skipped} record${skipped === 1 ? " is" : "s are"} in a format this page can't read yet.`
          : ""}
      </p>
      <div className={styles.factLinks}>
        <a href={FIRST_EPOCH_LOG_URL} target="_blank" rel="noreferrer" className="text-link">
          First live epoch, 29 Sep <ArrowUpRight size={12} aria-hidden />
        </a>
        <a href={AGENT_WORKFLOW_URL} target="_blank" rel="noreferrer" className="text-link">
          The weekly workflow <ArrowUpRight size={12} aria-hidden />
        </a>
        <a href={AGENT_LOG_FOLDER_URL} target="_blank" rel="noreferrer" className="text-link">
          Agent log folder <ArrowUpRight size={12} aria-hidden />
        </a>
      </div>
    </div>
  );
}

function LogFallback({
  error,
  onRetry,
  retrying,
}: {
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
}) {
  const e = error instanceof AgentLogError ? error : null;
  const why =
    e?.kind === "rate-limit"
      ? `GitHub's limit for unauthenticated requests from your network was reached${
          e.resetAt ? `; it resets at ${fmtUtcClock(e.resetAt)}` : ""
        }.`
      : e?.kind === "http"
        ? `${e.message} The records are still on GitHub.`
        : "GitHub could not be reached from this browser.";
  return (
    <div className={styles.logEmpty} role="status">
      <p className={styles.logEmptyTitle}>The decision log couldn&apos;t load here.</p>
      <p className="body">{why} Every record is a markdown file you can read in the repository.</p>
      <div className={styles.emptyActions}>
        <a href={AGENT_LOG_FOLDER_URL} target="_blank" rel="noreferrer" className="pill pill-small">
          Read the records on GitHub <ArrowUpRight size={12} aria-hidden />
        </a>
        {e?.kind !== "rate-limit" ? (
          <button type="button" className="pill pill-small pill-ghost" onClick={onRetry} disabled={retrying}>
            {retrying ? "Trying…" : "Try again"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function reasonText(name: string | null): string | null {
  if (!name) return null;
  return REASONS.find((r) => r.name === name)?.text ?? null;
}

function LogCard({ entry }: { entry: LogEntry }) {
  const r = entry.record;
  const v = verdictOf(r.result);
  const tone = kindTone(r.vault.kind);
  const titleId = useId();
  const VerdictIcon = v.tone === "good" ? Check : v.tone === "bad" ? Ban : Minus;
  return (
    <article className={styles.logCard} data-tone={tone} aria-labelledby={titleId}>
      <header className={styles.logHead}>
        <h3 id={titleId} className={styles.logTitle}>
          <time dateTime={r.date} className="mono">
            {fmtLogDate(r.date)}
          </time>
          <span className={styles.kind} data-tone={tone}>
            {r.vault.symbol}
            <span className="sr-only">,</span>
            <span className={styles.logKind}> · {kindLabel(r.vault.kind)}</span>
          </span>
        </h3>
        <ul className={styles.logTags} aria-label="Run">
          <li className={styles.logTag} data-action={r.action}>
            {actionLabel(r.action)}
          </li>
          {/* The reckless demo's strategy is the action itself: one tag says it. */}
          {r.decision && r.decision.strategy !== "reckless" ? (
            <li className={styles.logTag} data-strategy={r.decision.strategy}>
              <span className="sr-only">Strategy: </span>
              <span>{strategyLabel(r.decision.strategy)}</span>
            </li>
          ) : null}
        </ul>
        <p className={styles.verdict} data-tone={v.tone}>
          <VerdictIcon size={14} aria-hidden />
          <span className="sr-only">Contract verdict: </span>
          <span>{v.label}</span>
        </p>
      </header>

      <dl className={styles.logFacts}>
        <div>
          <dt className="micro micro-muted">Market inputs</dt>
          <dd>
            {r.market ? (
              <>
                <span className={`mono ${styles.logValue}`}>
                  {fmtPrice(r.market.spot)} <span className={styles.logUnit}>spot</span>
                </span>
                <span className={`mono ${styles.logValue}`}>
                  {fmtSigma(r.market.sigma)} <span className={styles.logUnit}>σ a year</span>
                </span>
                <span className={styles.cellMuted}>
                  {sourceLabel(r.market)} · oracle {r.market.oracleStatus} · market{" "}
                  {r.market.marketOpen ? "open" : "closed"}
                </span>
              </>
            ) : (
              <span className={styles.cellMuted}>Not read</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Target</dt>
          <dd>
            {r.decision && r.decision.targetDeltaBps !== null ? (
              <>
                <span className={`mono ${styles.logValue}`}>
                  {fmtDeltaBps(r.decision.targetDeltaBps)} <span className={styles.logUnit}>delta</span>
                </span>
                <span className={styles.cellMuted}>
                  premium {fmtFactor(r.decision.premiumBps ?? r.dryRun?.premiumBps ?? null)} of fair value
                </span>
              </>
            ) : r.dryRun && r.dryRun.delta !== null ? (
              <>
                <span className={`mono ${styles.logValue}`}>
                  {r.dryRun.delta.toFixed(2)} <span className={styles.logUnit}>delta</span>
                </span>
                <span className={styles.cellMuted}>strike ${fmtDecimal(r.dryRun.strike)} set directly</span>
              </>
            ) : (
              <span className={styles.cellMuted}>
                {r.action === "settle" ? "No decision: settles at the first print after expiry" : "No target"}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Verdict</dt>
          <dd>
            <Outcome record={r} />
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Track record after</dt>
          <dd>
            <Track record={r} />
          </dd>
        </div>
      </dl>

      {r.decision && r.decision.reasoning ? (
        <Reasoning text={r.decision.reasoning} who={strategyLabel(r.decision.strategy)} />
      ) : null}
      {r.decision && r.decision.notes.length > 0 ? (
        <ul className={styles.logNotes} aria-label="Mandate guard notes">
          {r.decision.notes.map((n, i) => (
            <li key={i}>
              <span className="micro micro-muted">Note</span> {n}
            </li>
          ))}
        </ul>
      ) : null}

      <footer className={styles.logFoot}>
        <div className={styles.logTxs}>
          <span className="micro micro-muted">Transactions</span>
          {r.transactions.length === 0 ? (
            <span className={styles.cellMuted}>None sent</span>
          ) : (
            <ul className={styles.factLinks}>
              {r.transactions.map((t) => (
                <li key={t.hash}>
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer" className="text-link">
                      {t.label}
                      <span className="sr-only"> transaction on Blockscout</span>
                      <ArrowUpRight size={11} aria-hidden />
                    </a>
                  ) : (
                    <span className={styles.logTxPlain}>
                      {t.label} <span className="mono">{shortHash(t.hash)}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {r.decision && isRecordName(entry.name) ? (
          <Link
            href={decisionPath(r.chain.id, entry.name)}
            className="text-link"
            data-testid="log-decision-link"
          >
            Open the decision
            <span className="sr-only">
              {" "}
              for {r.vault.symbol} on {r.date}
            </span>
          </Link>
        ) : null}
        <a href={entry.recordUrl} target="_blank" rel="noreferrer" className="text-link">
          Full record
          <span className="sr-only">
            {" "}
            for {r.vault.symbol} on {r.date}
          </span>
          <ArrowUpRight size={12} aria-hidden />
        </a>
      </footer>
    </article>
  );
}

function Outcome({ record: r }: { record: LogRecord }) {
  const res = r.result;
  switch (res.status) {
    case "accepted":
      return (
        <>
          <span className={`mono ${styles.logValue}`}>
            {fmtPrice(res.strike)} <span className={styles.logUnit}>strike</span>
          </span>
          <span className={styles.cellMuted}>
            {res.size ? `${fmtDecimal(res.size)} options · ` : ""}expires {fmtNyIso(res.expiryIso)}
          </span>
        </>
      );
    case "rejected": {
      const why = reasonText(res.reason);
      return (
        <>
          {res.reason ? <span className={styles.reason}>{res.reason}</span> : null}
          {why ? <span className={styles.cellMuted}>{why}</span> : null}
          {res.slashed !== null ? (
            <span className={`mono ${styles.logSlash}`}>−{fmtDecimal(res.slashed)} USDG slashed</span>
          ) : null}
        </>
      );
    }
    case "settled":
      return (
        <>
          <span className={`mono ${styles.logValue}`}>
            {res.settlementPrice === null ? "Nothing sold" : fmtPrice(res.settlementPrice)}{" "}
            {res.settlementPrice === null ? null : <span className={styles.logUnit}>settle</span>}
          </span>
          <span className={styles.cellMuted}>
            {[
              res.payout !== null ? `${res.payout} to holders` : null,
              res.premium !== null ? `${fmtDecimal(res.premium)} USDG premium` : null,
              res.settledBy ? `sent by the ${res.settledBy}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </>
      );
    default:
      return <span className={styles.cellMuted}>{res.summary || verdictOf(res).label}</span>;
  }
}

function Track({ record: r }: { record: LogRecord }) {
  const t = r.trackRecord;
  if (!t) return <span className={styles.cellMuted}>Not read</span>;
  const pnl = Number(t.cumulativePnl);
  const sign = pnl > 0 ? "gain" : pnl < 0 ? "loss" : "flat";
  return (
    <>
      <span className={`mono ${styles.logValue}`}>
        {t.accepted} <span className={styles.logUnit}>accepted</span> · {t.rejected}{" "}
        <span className={styles.logUnit}>rejected</span>
      </span>
      <span className={styles.cellMuted}>
        {t.strikes}/{t.maxStrikes} strikes · bond {fmtDecimal(t.bond)} USDG
      </span>
      {t.settledEpochs > 0 ? (
        <span className={`mono ${styles.pnl} ${styles.logPnl}`} data-sign={sign}>
          {pnl > 0 ? "+" : ""}
          {fmtDecimal(t.cumulativePnl)} USDG{" "}
          <span className={styles.logUnit}>
            depositor PnL, {t.settledEpochs} epoch{t.settledEpochs === 1 ? "" : "s"}
          </span>
        </span>
      ) : null}
    </>
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
    <figure className={styles.logWhy}>
      <figcaption className="micro micro-muted">Why · {who}</figcaption>
      <blockquote>
        <p ref={ref} id={id} className={styles.logWhyText} data-open={open}>
          {text}
        </p>
      </blockquote>
      {overflows ? (
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
