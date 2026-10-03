"use client";

import { blackScholes, normCdf, roundStrikeToCent, strikeForDelta } from "@strike/sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Ban, Check, CircleAlert, Minus } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { PublicClient } from "viem";
import { usePublicClient } from "wagmi";
import {
  AGENT_LOG_FOLDER_URL,
  candidateVerdict,
  fmtDeltaBps,
  fmtFactor,
  fmtLogDate,
  fmtNyIso,
  fmtPrice,
  kindLabel,
  plannerLabel,
  strategyLabel,
  verdictOf,
  type LogRecord,
} from "@/lib/agentLog";
import { DELTAS, META, TICKERS, gridRow, type Ticker } from "@/lib/backtest";
import { CHAIN_META } from "@/lib/chains";
import {
  HINDSIGHT_CAVEAT,
  LADDER_TOLERANCE_TEXT,
  buildLadder,
  decisionInputs,
  gradeLadder,
  hindsightTakeaway,
  recordedLadder,
  lossLine,
  recordReasonCode,
  scorecard,
  type DecisionInputs,
  type Ladder,
  type LadderRow,
  type Pricing,
} from "@/lib/decision";
import type { EpochTraceJson } from "@/lib/epochTrace";
import { REASONS } from "@/lib/labels";
import { WHY_STALE_MS, WhyStrikeError, loadRecordByName, type AnchorCheck } from "@/lib/whyStrike";
import { Term } from "@/components/ui/Term";
import { MetaStrip } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import { MandateRules } from "../playground/MandateRules";
import { AnchorLine, Reasoning } from "../vault/WhyStrikePanel";
import { PricePathChart } from "./PricePathChart";
import {
  ConsistencyView,
  Modifications,
  NotProvided,
  SourceLine,
  StressView,
  WhatIfView,
} from "./WhatIfSections";
import appStyles from "../app.module.css";
import styles from "./decision.module.css";

/** The SDK's pricing (sdk/src/pricing.ts): the float port of the on-chain Black-Scholes pricer. */
const SDK_PRICING: Pricing = { blackScholes, strikeForDelta, roundStrikeToCent, normCdf };

const usd = (x: number, frac = 2) =>
  `${x < 0 ? "−" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
const pct = (x: number, frac = 2) => `${x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(frac)}%`;
const opts = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 4 });
const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One decision record on its own page: what the agent chose, why, why not the other strikes, and how it went. */
export function DecisionPage({ chainId, name }: { chainId: number; name: string }) {
  const client = usePublicClient({ chainId: chainId as 46630 | 421614 }) as PublicClient | undefined;
  const q = useQuery({
    queryKey: ["decision", chainId, name],
    enabled: !!client,
    staleTime: WHY_STALE_MS,
    gcTime: WHY_STALE_MS * 3,
    retry: 1,
    queryFn: ({ signal }) => loadRecordByName(client!, chainId, name, fetch, signal),
  });
  const chain = CHAIN_META[chainId as keyof typeof CHAIN_META]?.label ?? `chain ${chainId}`;

  if (q.isPending) {
    return (
      <>
        <PageHero
          label={`Decision record · ${chain}`}
          title="Decision"
          lead={<p className="lead">{name}</p>}
        />
        <div className={`gutter ${styles.state}`} aria-busy="true" data-testid="decision-loading">
          <span className="micro micro-muted">
            Fetching the record from GitHub and checking its hash on-chain…
          </span>
          <Skeleton width="70%" />
          <Skeleton width="45%" />
        </div>
      </>
    );
  }
  if (q.isError || q.data.kind !== "record") {
    const e = q.error instanceof WhyStrikeError ? q.error : null;
    const title = q.isError
      ? "The record couldn't be fetched."
      : q.data.kind === "not-found"
        ? "No such decision record."
        : "This file can't be read as a decision record.";
    const body = q.isError
      ? e?.kind === "http"
        ? e.message
        : "GitHub could not be reached from this browser."
      : q.data.kind === "not-found"
        ? `There is no ${name}.json in the ${chain} records folder.`
        : q.data.kind === "invalid"
          ? q.data.why
          : "";
    return (
      <>
        <PageHero
          label={`Decision record · ${chain}`}
          title="Decision"
          lead={<p className="lead">{name}</p>}
        />
        <div className={`gutter ${styles.state}`} role="status" data-testid="decision-empty">
          <p className="h3">{title}</p>
          <p className="body">{body}</p>
          <div className={appStyles.emptyActions}>
            <a href={AGENT_LOG_FOLDER_URL} target="_blank" rel="noreferrer" className="pill pill-small">
              Records on GitHub <ArrowUpRight size={12} aria-hidden />
            </a>
            <Link href={`/app/agents?chain=${chainId}#decision-log`} className="pill pill-small pill-ghost">
              Decision log
            </Link>
            {q.isError ? (
              <button
                type="button"
                className="pill pill-small pill-ghost"
                onClick={() => q.refetch()}
                disabled={q.isFetching}
              >
                {q.isFetching ? "Trying…" : "Try again"}
              </button>
            ) : null}
          </div>
        </div>
      </>
    );
  }
  const d = q.data;
  return (
    <DecisionBody
      chainId={chainId}
      chain={chain}
      name={d.name}
      record={d.record}
      recordUrl={d.recordUrl}
      jsonUrl={d.jsonUrl}
      anchor={d.anchor}
    />
  );
}

/* ================================================================ the page */

function DecisionBody({
  chainId,
  chain,
  name,
  record: r,
  recordUrl,
  jsonUrl,
  anchor,
}: {
  chainId: number;
  chain: string;
  name: string;
  record: LogRecord;
  recordUrl: string;
  jsonUrl: string;
  anchor: AnchorCheck;
}) {
  const v = verdictOf(r.result);
  const VerdictIcon = v.tone === "good" ? Check : v.tone === "bad" ? Ban : Minus;
  const code = recordReasonCode(r);
  const derived = useMemo(() => {
    const inp = decisionInputs(r);
    if ("missing" in inp) return { inp: null, missing: inp.missing } as const;
    let ladder: Ladder | null = null;
    let ladderError: string | null = null;
    try {
      ladder = buildLadder(inp, SDK_PRICING, code);
    } catch (e) {
      ladderError = e instanceof Error ? e.message : String(e);
    }
    return {
      inp,
      missing: null,
      rules: scorecard(inp, r.vault.underlying, code),
      ladder,
      ladderError,
      loss: lossLine(inp, SDK_PRICING),
    } as const;
  }, [r, code]);
  const isCall = r.vault.kind === "covered-call";
  // The ladder the agent dry-ran itself, when the record carries one; else the recomputed one stands in.
  const recorded = useMemo(() => recordedLadder(r, r.market?.spot ? Number(r.market.spot) : null), [r]);
  const sentLabel = r.result.status === "accepted" || r.result.status === "rejected" ? "sent" : "chosen";
  const strike = r.result.strike ?? r.dryRun?.strike ?? null;
  const target = r.decision?.targetDeltaBps ?? null;
  const vaultHref = `/app/vault/${r.vault.address}?chain=${chainId}`;

  return (
    <div data-testid="decision-page" data-status={r.result.status} data-anchor={anchor.status}>
      <PageHero
        theme={isCall ? "call" : "put"}
        label={`Decision record · ${r.vault.symbol} · ${chain}`}
        right={
          <Link href={vaultHref} className={appStyles.back}>
            <ArrowLeft size={12} aria-hidden /> The vault
          </Link>
        }
        title={strike ? `${isCall ? "Call" : "Put"} at ${fmtPrice(strike)}` : "Decision"}
        lead={
          <>
            <p className="lead" data-testid="decision-lead">
              {r.agentId ? `Agent #${r.agentId}` : "The agent"}{" "}
              {r.action === "reckless" ? "sent a deliberately out-of-mandate" : "proposed a"}{" "}
              {target !== null ? `${fmtDeltaBps(target)}-delta ` : ""}
              {kindLabel(r.vault.kind).toLowerCase()} on {r.vault.underlying} for the {r.vault.symbol} vault
              on {fmtLogDate(r.date)}.{" "}
              {r.result.status === "accepted"
                ? "The contract accepted it."
                : r.result.status === "rejected"
                  ? `The contract rejected it${r.result.reason ? ` (${r.result.reason})` : ""}${
                      r.result.slashed ? ` and slashed ${r.result.slashed} USDG from the agent's bond` : ""
                    }.`
                  : r.result.summary}
            </p>
            <p className={`micro ${appStyles.heroAddr}`}>
              {name} · <Link href={vaultHref}>{r.vault.name}</Link>
            </p>
          </>
        }
      />
      <MetaStrip
        cells={[
          {
            label: "Contract's verdict",
            value: (
              <span className={styles.verdict} data-tone={v.tone} data-testid="decision-verdict">
                <VerdictIcon size={16} aria-hidden /> {v.label}
              </span>
            ),
            sub:
              r.result.status === "rejected" ? (r.result.reason ?? undefined) : fmtNyIso(r.result.expiryIso),
          },
          {
            label: "Planned by",
            value: r.decision ? strategyLabel(r.decision.strategy) : "No decision",
            sub:
              r.decision?.planner?.label ?? (r.decision?.strategy === "default" ? "rule profile" : undefined),
          },
          {
            label: `${r.vault.underlying} snapshot`,
            value: fmtPrice(r.market?.spot ?? null),
            sub:
              r.market?.sigma != null
                ? `σ ${(r.market.sigma * 100).toFixed(0)}% a year, at the epoch open`
                : undefined,
          },
          {
            label: "Anchored",
            term: "anchored",
            value:
              anchor.status === "match"
                ? "Hash matches"
                : anchor.status === "unreadable"
                  ? "Unchecked"
                  : "No match",
            sub: `epoch ${anchor.epoch} · DecisionLog${anchor.version ? ` ${anchor.version}` : ""}`,
          },
        ]}
      />
      <div className={appStyles.detailBody}>
        <Rail
          index="01"
          id="chosen"
          label="What it chose and why"
          note="From the anchored record: the planner, its target, the contract's own dry run and the reasoning it wrote before proposing."
        >
          <SourceLine kinds={["record"]} />
          <Chosen record={r} />
        </Rail>
        <Rail
          index="02"
          id="mandate"
          label="Mandate check"
          note="The vault's rules in the order MandateGuard.check runs them, measured on the record's dry run. The contract stops at the first rule that fails; the rest are not reached."
        >
          {derived.inp ? (
            <div className={styles.block} data-testid="decision-scorecard">
              <SourceLine kinds={["record", "recomputed"]} />
              <MandateRules rules={derived.rules} />
              <p className={appStyles.hint}>
                Measured on the dry run in the record (<code className="mono">previewProposal</code>, the
                contract&apos;s own check), with the tenor counted from the epoch open. Headroom is the
                distance to the nearest limit.
              </p>
            </div>
          ) : (
            <Missing why={derived.missing} />
          )}
          {derived.inp ? <Modifications record={r} /> : null}
        </Rail>
        <Rail
          index="03"
          id="ladder"
          label="Why not the other strikes"
          note="The same proposal at other target deltas, from just below the mandate's band to just above it, each judged by the mandate's rules."
        >
          <SourceLine kinds={recorded.length > 0 ? ["record"] : ["recomputed"]} />
          <PlannerCalls record={r} />
          {recorded.length > 0 ? (
            <RecordedLadder record={r} rows={recorded} sentLabel={sentLabel} />
          ) : derived.inp ? (
            <LadderView
              inp={derived.inp}
              ladder={derived.ladder}
              error={derived.ladderError}
              underlying={r.vault.underlying}
            />
          ) : (
            <Missing why={derived.missing} />
          )}
        </Rail>
        <Rail
          index="04"
          id="lose"
          label="What would make this week lose"
          note="The settlement price where the option starts costing depositors more than its premium, and the pricing model's odds of getting there."
        >
          {derived.inp ? (
            <>
              <LossView record={r} loss={derived.loss} underlying={r.vault.underlying} />
              <StressView
                inp={derived.inp}
                loss={derived.loss}
                pricing={SDK_PRICING}
                underlying={r.vault.underlying}
                sold={r.result.status === "accepted"}
              />
            </>
          ) : (
            <Missing why={derived.missing} />
          )}
        </Rail>
        <Rail
          index="05"
          id="hindsight"
          label="In hindsight"
          note="The price the contracts read since the epoch opened, against the strike and the break-even; after settlement, each ladder row graded at the settlement price the oracle recorded."
        >
          {derived.inp ? (
            <div className={styles.block}>
              <PricePathChart
                chainId={chainId}
                symbol={r.vault.underlying}
                openedAt={derived.inp.openedAt}
                expiry={derived.inp.expiry}
                spot={derived.inp.spot}
                sigma={derived.inp.sigma}
                strike={derived.loss.strike}
                breakEven={derived.loss.breakEven}
              />
            </div>
          ) : null}
          <Hindsight
            chainId={chainId}
            record={r}
            inp={derived.inp}
            rows={
              recorded.length > 0
                ? recorded
                : derived.ladder && derived.ladder.check.ok
                  ? derived.ladder.rows
                  : null
            }
            source={recorded.length > 0 ? "recorded" : "recomputed"}
          />
        </Rail>
        <Rail
          index="06"
          id="whatif"
          label="What if"
          note="The proposal sent next to keeping cash, half the size and the strikes either side of it, valued for the whole vault: model numbers before settlement, the payout at the settlement price after."
        >
          {derived.inp ? (
            <WhatIfView
              chainId={chainId}
              record={r}
              inp={derived.inp}
              rows={
                recorded.length > 0
                  ? recorded
                  : derived.ladder && derived.ladder.check.ok
                    ? derived.ladder.rows
                    : null
              }
              rowsSource={recorded.length > 0 ? "recorded" : "recomputed"}
            />
          ) : (
            <Missing why={derived.missing} />
          )}
        </Rail>
        <Rail
          index="07"
          id="proof"
          label="Anchor and transactions"
          note="The record's keccak256, rebuilt here from the file on GitHub and checked against its anchoring transaction on-chain, and every transaction the run sent."
        >
          <div className={styles.block} data-testid="decision-proof">
            <SourceLine kinds={["record", "chain"]} />
            <AnchorLine anchor={anchor} chainId={chainId} />
            {r.transactions.length > 0 ? (
              <ul className={appStyles.factLinks} aria-label="Transactions">
                {r.transactions.map((t) =>
                  t.url ? (
                    <li key={t.hash}>
                      <a href={t.url} target="_blank" rel="noreferrer" className="text-link">
                        {t.label} <ArrowUpRight size={11} aria-hidden />
                      </a>
                    </li>
                  ) : null,
                )}
              </ul>
            ) : null}
            <div className={appStyles.factLinks}>
              <a href={recordUrl} target="_blank" rel="noreferrer" className="text-link">
                Full record on GitHub <ArrowUpRight size={12} aria-hidden />
              </a>
              <a href={jsonUrl} target="_blank" rel="noreferrer" className="text-link">
                The JSON the hash covers <ArrowUpRight size={12} aria-hidden />
              </a>
              <Link href={`${vaultHref}#trace`} className="text-link">
                Epoch trace on the vault page
              </Link>
              <Link href={`/app/agents?chain=${chainId}#decision-log`} className="text-link">
                Decision log
              </Link>
            </div>
            <ConsistencyView
              record={r}
              anchor={anchor.status}
              ladderMatches={
                recorded.length > 0
                  ? recordedMatchesDry(r, recorded)
                  : derived.inp && derived.ladder
                    ? derived.ladder.check.ok
                    : null
              }
            />
          </div>
        </Rail>
      </div>
    </div>
  );
}

function Missing({ why }: { why: string | null }) {
  return (
    <p className={appStyles.hint} data-testid="decision-missing">
      Not shown: {why ?? "the record lacks an input this section needs"}.
    </p>
  );
}

/* ================================================================ 01 what it chose */

function Chosen({ record: r }: { record: LogRecord }) {
  const d = r.decision;
  const dry = r.dryRun;
  const notes = (d?.notes ?? []).filter((n) => n.replace(/\.$/, "") !== d?.planner?.label);
  return (
    <div className={styles.block}>
      <dl className={appStyles.whyFacts}>
        <div>
          <dt className="micro micro-muted">Planned by</dt>
          <dd data-testid="decision-planner">
            <span className={appStyles.whyValue}>{d ? plannerLabel(d) : "No decision was made"}</span>
            <span className={appStyles.cellMuted}>
              {fmtLogDate(r.date)} · epoch {r.anchor?.epoch ?? "?"} ·{" "}
              {r.agentId ? `agent #${r.agentId}` : "agent unknown"}
            </span>
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Chosen</dt>
          <dd data-testid="decision-chosen">
            {d?.targetDeltaBps != null ? (
              <span className={appStyles.whyValue}>
                <span className="mono">{fmtDeltaBps(d.targetDeltaBps)}</span> <Term id="delta">delta</Term> ·{" "}
                <span className="mono">{fmtFactor(d.premiumBps ?? dry?.premiumBps ?? null)}</span> of{" "}
                <Term id="fairValue">fair value</Term>
              </span>
            ) : dry?.strike ? (
              <span className={appStyles.whyValue}>
                <Term id="strike">strike</Term> <span className="mono">{fmtPrice(dry.strike)}</span> set
                directly
              </span>
            ) : (
              <span className={appStyles.whyValue}>No target</span>
            )}
            {r.vault.mandateSummary ? (
              <span className={appStyles.cellMuted}>
                <Term id="mandate">mandate</Term> {r.vault.mandateSummary}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="micro micro-muted">Dry run</dt>
          <dd data-testid="decision-dryrun">
            {dry ? (
              <>
                <span className={appStyles.whyValue}>
                  {fmtPrice(dry.strike)} · |Δ| {dry.delta ?? <NotProvided what="not recorded" />} · fair{" "}
                  {fmtPrice(dry.fairValue)}
                </span>
                <span className={appStyles.cellMuted}>
                  {dry.size ? `${opts(Number(dry.size))} of ${opts(Number(dry.capacity ?? 0))} options` : ""}
                  {dry.yieldBps !== null ? ` · yield ${fmtFactor(dry.yieldBps)} of collateral` : ""} ·{" "}
                  {dry.ok ? "inside the mandate" : `outside: ${dry.reason}`}
                </span>
              </>
            ) : (
              <NotProvided what="No dry run in the record" />
            )}
          </dd>
        </div>
      </dl>
      {d?.reasoning ? <Reasoning text={d.reasoning} who={strategyLabel(d.strategy)} /> : null}
      {notes.length > 0 ? (
        <ul className={appStyles.logNotes} aria-label="Mandate guard notes">
          {notes.map((n, i) => (
            <li key={i}>
              <span className="micro micro-muted">Note</span> {n}
            </li>
          ))}
        </ul>
      ) : null}
      {dry && !dry.ok && dry.explanation ? <p className={appStyles.hint}>{dry.explanation}</p> : null}
      <BacktestContext record={r} />
    </div>
  );
}

/** The backtest's by-delta results for the record's ticker and vault kind, kept apart from the agent's reasoning. */
function BacktestContext({ record: r }: { record: LogRecord }) {
  const ticker = TICKERS.find((t) => t === r.vault.underlying) as Ticker | undefined;
  if (!ticker) return null;
  const vault = r.vault.kind === "covered-call" ? "call" : "put";
  const rows = DELTAS.map((delta) => gridRow({ ticker, vault, vrp: "1.00" }, delta));
  return (
    <aside className={styles.context} data-testid="decision-backtest">
      <p className="micro micro-muted">Context, not the agent&apos;s reasoning</p>
      <p>
        Across {META.weeks} backtested weeks of {ticker} {kindLabel(r.vault.kind).toLowerCase()}s (
        {META.start} to {META.end}, premium at fair value):{" "}
        {rows.map((g, i) => (
          <span key={g.delta}>
            {i > 0 ? "; " : ""}
            <span className="mono">{g.delta.toFixed(2)}</span> delta returned{" "}
            <span className="mono">{pct(g.cagr, 1)}</span> a year, Sharpe{" "}
            <span className="mono">
              {g.sharpe < 0 ? "−" : ""}
              {Math.abs(g.sharpe).toFixed(2)}
            </span>
          </span>
        ))}
        .{" "}
        <Link href="/app/backtest#bt-delta" className="text-link">
          By target delta on the backtest page
        </Link>
      </p>
    </aside>
  );
}

/* ================================================================ 03 the ladder */

function reasonText(name: string | null): string {
  return REASONS.find((r) => r.name === name)?.text ?? "";
}

/** Claude's own `risk_check` calls while planning (`decision.candidates` with source "planner"), in call order. */
function PlannerCalls({ record: r }: { record: LogRecord }) {
  const cands = (r.decision?.candidates ?? []).filter((c) => c.source === "planner");
  if (cands.length === 0) return null;
  return (
    <div className={styles.block} data-testid="decision-planner-calls">
      <h3 className="micro micro-muted">
        Claude&apos;s own dry runs while planning · <code className="mono">risk_check</code>, the
        contract&apos;s <code className="mono">previewProposal</code>, in call order, part of the anchored
        record
      </h3>
      <div className={appStyles.tableWrap}>
        <table className={`${appStyles.table} ${styles.ladder}`}>
          <thead>
            <tr>
              <th scope="col">Asked</th>
              <th scope="col">Strike</th>
              <th scope="col">Contract</th>
              <th scope="col">Fair value</th>
              <th scope="col">Yield</th>
            </tr>
          </thead>
          <tbody>
            {cands.map((c, i) => (
              <tr key={i} data-ok={c.ok} data-sent={c.chosen || undefined} data-testid="planner-call">
                <th scope="row" className="mono">
                  {c.targetDeltaBps !== null ? `${fmtDeltaBps(c.targetDeltaBps)} Δ` : "strike"} ·{" "}
                  {fmtFactor(c.premiumBps)}
                </th>
                <td className="mono">{fmtPrice(c.strike)}</td>
                <td className={styles.verdictCell}>
                  <span
                    className={styles.rowVerdict}
                    data-ok={c.ok}
                    data-error={c.error !== null || undefined}
                  >
                    {candidateVerdict(c)}
                  </span>
                  {c.chosen ? <span className={styles.sent}>chosen</span> : null}
                </td>
                <td className="mono">{fmtPrice(c.fairValue)}</td>
                <td className="mono">
                  {c.yieldBps === null ? <NotProvided what="not recorded" /> : fmtFactor(c.yieldBps)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The ladder the agent dry-ran itself (`decision.candidates` with source "ladder"): the contract's own verdicts. */
function RecordedLadder({
  record: r,
  rows,
  sentLabel,
}: {
  record: LogRecord;
  rows: LadderRow[];
  sentLabel: string;
}) {
  const unread = (r.decision?.candidates ?? []).filter(
    (c) => c.source === "ladder" && (c.error !== null || c.strike === null || c.fairValue === null),
  ).length;
  return (
    <div className={styles.block} data-testid="decision-ladder" data-check="recorded">
      <p className={styles.label} data-testid="ladder-label">
        The agent&apos;s own dry runs, part of the anchored record.
      </p>
      <p className={styles.check} data-ok="true" data-testid="ladder-check">
        <Check size={13} aria-hidden />
        Each rung went through <code className="mono">risk_check</code>, the contract&apos;s own{" "}
        <code className="mono">previewProposal</code>, at the chosen premium factor and the largest size the
        mandate allows, before the agent proposed; the verdicts are the contract&apos;s.
        {unread > 0
          ? ` ${unread} rung${unread === 1 ? "" : "s"} could not be read and ${unread === 1 ? "is" : "are"} left out.`
          : ""}
      </p>
      <div className={appStyles.tableWrap}>
        <table className={`${appStyles.table} ${styles.ladder}`} aria-label="Strike ladder the agent dry-ran">
          <thead>
            <tr>
              <th scope="col">Target Δ</th>
              <th scope="col">Strike</th>
              <th scope="col">First rule it breaks</th>
              <th scope="col">From spot</th>
              <th scope="col">Fair value</th>
              <th scope="col">Premium</th>
              <th scope="col">Yield</th>
              <th scope="col">Size</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <LadderTr key={i} row={row} mark={sentLabel} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LadderView({
  inp,
  ladder,
  error,
  underlying,
}: {
  inp: DecisionInputs;
  ladder: Ladder | null;
  error: string | null;
  underlying: string;
}) {
  if (!ladder)
    return <Missing why={`the SDK's solver could not price the ladder (${error ?? "unknown error"})`} />;
  const c = ladder.check;
  const bad = c.items.filter((i) => !i.ok);
  const fmtItem = (label: string, x: number) =>
    label === "|Δ|" ? x.toFixed(4) : label === "Size" ? opts(x) : usd(x, label === "Fair value" ? 4 : 2);
  return (
    <div className={styles.block} data-testid="decision-ladder" data-check={c.ok ? "match" : "mismatch"}>
      <p className={styles.label} data-testid="ladder-label">
        Recomputed from the anchored inputs, not part of the agent&apos;s record.
      </p>
      <p className={styles.check} data-ok={c.ok} data-testid="ladder-check">
        {c.ok ? <Check size={13} aria-hidden /> : <CircleAlert size={13} aria-hidden />}
        {c.ok ? (
          <>
            The recomputed sent row matches the record&apos;s dry run:{" "}
            {c.items.map((i, n) => (
              <span key={i.label}>
                {n > 0 ? ", " : ""}
                {i.label === "|Δ|" ? i.label : i.label.toLowerCase()} {fmtItem(i.label, i.recomputed)} (record{" "}
                {fmtItem(i.label, i.record)})
              </span>
            ))}
            . Tolerance: {LADDER_TOLERANCE_TEXT}.
          </>
        ) : (
          <>
            The recomputed sent row does not match the record&apos;s dry run (
            {bad.map((i, n) => (
              <span key={i.label}>
                {n > 0 ? ", " : ""}
                {i.label === "|Δ|" ? i.label : i.label.toLowerCase()} {fmtItem(i.label, i.recomputed)} against{" "}
                {fmtItem(i.label, i.record)}
              </span>
            ))}
            ; tolerance: {LADDER_TOLERANCE_TEXT}), so the ladder is hidden: the other rows, priced the same
            way, could not be trusted either.
          </>
        )}
      </p>
      {c.ok ? (
        <>
          <div className={appStyles.tableWrap}>
            <table className={`${appStyles.table} ${styles.ladder}`} aria-label="Strike ladder, recomputed">
              <thead>
                <tr>
                  <th scope="col">Target Δ</th>
                  <th scope="col">Strike</th>
                  <th scope="col">First rule it breaks</th>
                  <th scope="col">From spot</th>
                  <th scope="col">Fair value</th>
                  <th scope="col">Premium</th>
                  <th scope="col">Yield</th>
                  <th scope="col">Size</th>
                </tr>
              </thead>
              <tbody>
                {ladder.rows.map((row) => (
                  <LadderTr key={`${row.target ?? "direct"}-${row.strike}`} row={row} />
                ))}
              </tbody>
            </table>
          </div>
          <p className={appStyles.hint}>
            Inputs, all from the anchored record: {underlying} spot {usd(inp.spot)} and σ{" "}
            {(inp.sigma * 100).toFixed(0)}% (the epoch-open snapshot),{" "}
            {(inp.tenorSeconds / 86_400).toFixed(2)} days from the epoch open to expiry, premium{" "}
            {fmtFactor(inp.premiumBps)} of fair value, {opts(inp.collateral)}{" "}
            {inp.isCall ? underlying : "USDG"} of collateral, the same share of capacity as the sent proposal.
            Each strike is solved and rounded to a cent the way <code className="mono">proposeByDelta</code>{" "}
            does, with the SDK&apos;s Black-Scholes (<code className="mono">sdk/src/pricing.ts</code>, which
            matches the on-chain pricer to about 1e-9 of spot). Premium and yield are per option.
          </p>
        </>
      ) : null}
    </div>
  );
}

/** A ladder figure, or "not recorded" when the agent's dry run did not carry it (never a blank or a guess). */
const dash = (x: number, f: (n: number) => string) =>
  Number.isFinite(x) ? f(x) : <NotProvided what="not recorded" />;

/** The agent's own ladder: its chosen rung must be the record's dry run (same strike and fair value). */
function recordedMatchesDry(r: LogRecord, rows: LadderRow[]): boolean | null {
  const chosen = rows.find((x) => x.sent);
  const d = r.dryRun;
  if (!chosen || !d?.strike || !d.fairValue) return null;
  return (
    Math.abs(chosen.strike - Number(d.strike)) <= 0.01 &&
    Math.abs(chosen.fairValue - Number(d.fairValue)) <= 0.005
  );
}

function LadderTr({ row, mark = "sent" }: { row: LadderRow; mark?: string }) {
  const v = row.verdict;
  return (
    <tr data-sent={row.sent || undefined} data-ok={v.ok} data-testid="ladder-row">
      <th scope="row" className="mono">
        {row.target !== null ? row.target.toFixed(2) : dash(row.delta, (x) => x.toFixed(4))}
        {row.target === null ? <span className={styles.direct}> set by strike</span> : null}
      </th>
      <td className="mono">{usd(row.strike)}</td>
      <td className={styles.verdictCell}>
        <span className={styles.rowVerdict} data-ok={v.ok} title={v.ok ? undefined : reasonText(v.reason)}>
          {v.ok
            ? "none: inside the mandate"
            : v.measured
              ? `${v.reason}: ${v.measured} against ${v.bound}`
              : `${v.reason ?? "rejected"}`}
        </span>
        {row.sent ? (
          <span className={styles.sent} data-testid="ladder-sent">
            {mark}
          </span>
        ) : null}
      </td>
      <td className="mono">{dash(row.distance, (x) => pct(x))}</td>
      <td className="mono">{usd(row.fairValue, 4)}</td>
      <td className="mono">{usd(row.premium, 4)}</td>
      <td className="mono">{dash(row.yieldBps, (x) => pct(x / 10_000, 3))}</td>
      <td className="mono">{dash(row.size, opts)}</td>
    </tr>
  );
}

/** Why a record sold nothing, in a few words. */
function notSoldWhy(r: LogRecord): string {
  return r.result.status === "rejected"
    ? "the contract rejected the proposal"
    : r.result.status === "not-sent"
      ? "this run did not send a proposal"
      : "no proposal was accepted";
}

/* ================================================================ 04 what would make it lose */

function LossView({
  record: r,
  loss: l,
  underlying,
}: {
  record: LogRecord;
  loss: ReturnType<typeof lossLine>;
  underlying: string;
}) {
  const sold = r.result.status === "accepted";
  const side = l.isCall ? "above" : "below";
  return (
    <div className={styles.block} data-testid="decision-loss">
      <SourceLine kinds={["record", "model"]} />
      {!sold ? (
        <p className={appStyles.hint} data-testid="loss-hypothetical">
          Nothing was sold: {notSoldWhy(r)}, so no option can lose. Had it been accepted, these are the
          numbers it would have carried.
        </p>
      ) : null}
      <p className={styles.big} data-testid="loss-breakeven">
        {sold ? "Depositors lose money on this series" : "Depositors would have lost money"} if {underlying}{" "}
        settles {side} <strong className="mono">{usd(l.breakEven)}</strong>.
      </p>
      <p className={styles.para}>
        That is the {usd(l.strike)} strike {l.isCall ? "plus" : "minus"} the {usd(l.premium)} premium per
        option ({fmtFactor(l.premiumBps)} of the {usd(l.fairValue, 4)} fair value),{" "}
        {pct(Math.abs(l.distance))} {l.distance < 0 ? "under" : "over"} the {usd(l.spot)} snapshot spot. Past
        it, the payout to option holders is larger than the premium the vault was paid.
      </p>
      <p className={styles.big} data-testid="loss-odds">
        Model odds of exercise: <strong className="mono">{pct(l.probItm, 1)}</strong>
      </p>
      <p className={styles.para}>
        Under the snapshot&apos;s σ of {(l.sigma * 100).toFixed(0)}% a year, Black-Scholes gives a{" "}
        {pct(l.probItm, 1)} chance the {l.isCall ? "call" : "put"} finishes in the money (
        {l.isCall ? "N(d2)" : "N(−d2)"}). <span data-testid="loss-label">Model odds, not a forecast.</span>{" "}
        The option&apos;s |Δ| of {l.delta.toFixed(2)} is close to it but not the same number: delta measures
        how the price moves with spot, and is a little higher than the odds of exercise.
      </p>
    </div>
  );
}

/* ================================================================ 05 in hindsight */

async function getTrace(url: string): Promise<EpochTraceJson> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as (EpochTraceJson & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

function Hindsight({
  chainId,
  record: r,
  inp,
  rows,
  source,
}: {
  chainId: number;
  record: LogRecord;
  inp: DecisionInputs | null;
  rows: LadderRow[] | null;
  source: "recorded" | "recomputed";
}) {
  const sold = r.result.status === "accepted";
  const epoch = r.anchor?.epoch ?? null;
  const trace = useQuery({
    queryKey: ["epoch-trace", chainId, r.vault.address, "decision"],
    queryFn: () => getTrace(`/api/epoch-trace?chain=${chainId}&vault=${r.vault.address}`),
    enabled: sold && epoch !== null,
    staleTime: 60_000,
    retry: 1,
  });
  // The clock is read after mount, so the server render and the first client render agree.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Math.floor(Date.now() / 1000)), []);

  let body: ReactNode;
  let state = "pending";
  if (!sold) {
    state = "not-sold";
    body = (
      <p className={appStyles.hint}>Nothing was sold ({notSoldWhy(r)}), so there is nothing to grade.</p>
    );
  } else if (!inp || !rows || rows.length === 0) {
    state = "no-ladder";
    body = (
      <p className={appStyles.hint}>
        Grading needs a ladder: this record has no dry runs of its own and the recomputed one is not shown.
      </p>
    );
  } else if (trace.isPending) {
    body = <Skeleton width="60%" />;
  } else if (trace.isError) {
    state = "error";
    body = (
      <p className={appStyles.hint}>
        Couldn&apos;t read the settlement from the epoch trace:{" "}
        {trace.error instanceof Error ? trace.error.message : "error"}.
      </p>
    );
  } else {
    const e = trace.data.epochs.find((x) => x.epoch === String(epoch));
    const price = e?.settlementPrice ? Number(e.settlementPrice) : null;
    if (!e) {
      state = "out-of-window";
      body = (
        <p className={appStyles.hint}>
          The epoch trace reads a vault&apos;s current and previous epoch; epoch {epoch} is older, so its
          settlement is not shown here. The vault&apos;s settled epochs are on its page.
        </p>
      );
    } else if (price === null || !(price > 0)) {
      const nowS = now ?? trace.data.now;
      state = "pending";
      body = (
        <p className={appStyles.hint} data-testid="hindsight-pending">
          {nowS < inp.expiry
            ? `Grades after ${utc(inp.expiry)}: the series settles at the first price round at or after expiry, and each row is then scored against that price.`
            : `Expired at ${utc(inp.expiry)}; waiting for the settle transaction, which anyone may send. The rows are graded once it lands.`}
        </p>
      );
    } else {
      state = "graded";
      body = <Graded inp={inp} rows={rows} price={price} source={source} />;
    }
  }
  return (
    <div className={styles.block} data-testid="decision-hindsight" data-state={state}>
      {body}
    </div>
  );
}

function Graded({
  inp,
  rows,
  price,
  source,
}: {
  inp: DecisionInputs;
  rows: LadderRow[];
  price: number;
  source: "recorded" | "recomputed";
}) {
  const graded = gradeLadder(rows, price, inp.isCall, inp.spot);
  const sent = graded.find((g) => g.row.sent) ?? null;
  return (
    <>
      <p className={styles.label} data-testid="hindsight-source">
        {source === "recorded"
          ? "Rows: the agent's own dry runs from the record."
          : "Rows: the ladder recomputed from the anchored inputs, not part of the agent's record."}
      </p>
      <p className={styles.big} data-testid="hindsight-takeaway">
        {hindsightTakeaway(graded, price)}
      </p>
      <p className={appStyles.hint} data-testid="hindsight-caveat">
        {HINDSIGHT_CAVEAT}
      </p>
      <div className={appStyles.tableWrap}>
        <table
          className={`${appStyles.table} ${styles.ladder}`}
          aria-label={`Ladder graded at the ${usd(price)} settlement`}
        >
          <thead>
            <tr>
              <th scope="col">Target Δ</th>
              <th scope="col">Strike</th>
              <th scope="col">Premium</th>
              <th scope="col">Payout at {usd(price)}</th>
              <th scope="col">Net per option</th>
              <th scope="col">Net on collateral</th>
              <th scope="col">Mandate</th>
            </tr>
          </thead>
          <tbody>
            {graded.map((g) => (
              <tr
                key={`${g.row.target ?? "direct"}-${g.row.strike}-${g.row.sent}`}
                data-sent={g.row.sent || undefined}
                data-ok={g.row.verdict.ok}
                data-testid="graded-row"
              >
                <th scope="row" className="mono">
                  {g.row.target !== null ? g.row.target.toFixed(2) : g.row.delta.toFixed(4)}
                </th>
                <td className="mono">{usd(g.row.strike)}</td>
                <td className="mono">{usd(g.row.premium, 4)}</td>
                <td className="mono">{usd(g.payout, 4)}</td>
                <td className="mono" data-sign={g.net >= 0 ? "gain" : "loss"}>
                  {g.net >= 0 ? "+" : ""}
                  {usd(g.net, 4)}
                </td>
                <td className="mono">{pct(g.netPct, 3)}</td>
                <td>
                  <span className={styles.rowVerdict} data-ok={g.row.verdict.ok}>
                    {g.row.verdict.ok ? "inside" : `outside: ${g.row.verdict.reason}`}
                  </span>
                  {g.row.sent ? <span className={styles.sent}>sent</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={appStyles.hint}>
        {sent
          ? `The proposal sent: ${opts(inp.dry.size)} options at ${usd(sent.net, 4)} each is about ${usd(sent.net * inp.dry.size)} for the vault before fees, if every option was bought. `
          : ""}
        The settlement price is the one the vault&apos;s EpochManager settled at, read from its EpochSettled
        event (the epoch trace on the vault page checks its round against mainnet Chainlink).
      </p>
    </>
  );
}
