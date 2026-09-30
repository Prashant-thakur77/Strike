"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, RotateCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { explorerUrl } from "@/lib/chains";
import { fmtNy, fmtWadUsd, shortAddr } from "@/lib/format";
import {
  CORPORATE_ACTION_GRACE,
  MAX_PRICE_AGE,
  MONITOR_CHAIN_ID,
  MONITOR_TOKENS,
  corporateAction,
  marketState,
  multiplierChangeScheduled,
  safeStockStatus,
  toWad,
  type Verdict,
} from "@/lib/monitor";
import { UNIT_MULTIPLIER, fmtMultiplier, perSharePrice } from "@/lib/shares";
import { errorMessage } from "@/hooks/useTx";
import { MetaStrip } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { Fold } from "../Fold";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import appStyles from "../app.module.css";
import { readMonitor, type MonitorSnapshot, type TokenRow } from "./reads";
import { CheckList } from "./CheckList";
import styles from "./monitor.module.css";

const REFRESH_MS = 60_000;

const VERDICT_LABEL: Record<Verdict, string> = {
  Ok: "Ok",
  InvalidPrice: "Invalid price",
  StalePrice: "Stale price",
  TokenPaused: "Token paused",
  FeedPaused: "Feed paused",
  CorporateActionPending: "Corporate action",
  FeedUnreadable: "Feed unreadable",
};

/** Wall clock in seconds, ticking once a second (ages and countdowns between refreshes). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** "42 s", "12 min", "3 h 05 min", "2 d 4 h". */
function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400)
    return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

function fmtHours(seconds: number): string {
  return seconds % 86_400 === 0 ? `${seconds / 86_400} day` : `${seconds / 3600} h`;
}

export function MonitorPage() {
  const q = useQuery({
    queryKey: ["monitor", MONITOR_CHAIN_ID],
    queryFn: () => readMonitor(),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: REFRESH_MS / 2,
    retry: 1,
  });
  const nowMs = useNow();
  const snap = q.data;

  return (
    <>
      <PageHero
        index="05"
        label="Monitor"
        right="Robinhood Chain mainnet · 4663"
        title={<span className={styles.title}>Monitor</span>}
        lead={
          <>
            <p className="lead">
              Every Robinhood Chain stock token with a Chainlink feed, read live from mainnet and judged by
              the same rules as <code className="mono">SafeStockFeed.status()</code>.
            </p>
            <p className={styles.leadNote}>
              Read-only. The page uses its own mainnet client, whatever network the app is set to.
            </p>
          </>
        }
      />
      {snap ? (
        <Summary snap={snap} nowMs={nowMs} />
      ) : q.isError ? null : (
        <MetaStrip
          cells={["NYSE", "Verdicts", "Block", "Last read"].map((label) => ({
            label,
            value: <Skeleton width="3.5em" />,
          }))}
        />
      )}

      <div className={styles.body}>
        <section className="gutter" aria-labelledby="monitor-tokens">
          <div className={styles.tableTop}>
            <h2 id="monitor-tokens" className="micro">
              <span className="index">01</span> Stock tokens · {MONITOR_TOKENS.length}
            </h2>
            <RefreshNote q={q} nowMs={nowMs} />
          </div>

          {q.isError && snap ? (
            <p className={styles.stale} role="status">
              The last refresh failed ({errorMessage(q.error)}). Showing the read from{" "}
              {fmtNy(snap.blockTimestamp)}.
            </p>
          ) : null}

          {snap ? (
            <TokenTable snap={snap} nowMs={nowMs} />
          ) : q.isError ? (
            <div className={`${appStyles.empty} ${styles.error}`} role="alert">
              <span className="micro micro-muted">Robinhood Chain mainnet</span>
              <h3 className="h3">Couldn&apos;t read mainnet.</h3>
              <p className="body">{errorMessage(q.error)}</p>
              <div className={appStyles.emptyActions}>
                <button type="button" className="pill pill-small" onClick={() => q.refetch()}>
                  Try again <RotateCw aria-hidden />
                </button>
              </div>
            </div>
          ) : (
            <TableSkeleton />
          )}
        </section>

        <Rail
          index="02"
          label="What each check protects against"
          note={
            <>
              The checks run in this order; the first one that trips is the verdict. Limits on mainnet:{" "}
              <a className="text-link" href={DEPLOY_URL(145)} target="_blank" rel="noreferrer">
                price age {fmtHours(MAX_PRICE_AGE)}
              </a>{" "}
              and{" "}
              <a className="text-link" href={DEPLOY_URL(130)} target="_blank" rel="noreferrer">
                grace {fmtHours(CORPORATE_ACTION_GRACE)}
              </a>
              .
            </>
          }
        >
          <Fold summary="Show the five checks and the multiplier rule" openSummary="Hide the checks">
            <CheckList />
          </Fold>
        </Rail>
      </div>
    </>
  );
}

const DEPLOY_URL = (line: number) =>
  `https://github.com/Prashant-thakur77/Strike/blob/main/contracts/script/Deploy.s.sol#L${line}`;

function chainNow(snap: MonitorSnapshot, nowMs: number): number {
  return Number(snap.blockTimestamp) + Math.max(0, (nowMs - snap.fetchedAt) / 1000);
}

function Summary({ snap, nowMs }: { snap: MonitorSnapshot; nowMs: number }) {
  const market = marketState(Number(snap.blockTimestamp));
  const verdicts = snap.rows.map((r) => safeStockStatus(r.reads, snap.blockTimestamp).verdict);
  const ok = verdicts.filter((v) => v === "Ok").length;
  const others = Object.entries(
    verdicts
      .filter((v) => v !== "Ok")
      .reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {}),
  )
    .map(([v, n]) => `${n} ${VERDICT_LABEL[v as Verdict].toLowerCase()}`)
    .join(" · ");
  return (
    <MetaStrip
      cells={[
        {
          label: "NYSE",
          value: market.open ? "Open" : "Closed",
          sub: market.nextChange
            ? `${market.open ? "Closes" : "Opens"} ${fmtNy(market.nextChange)}`
            : "Regular hours 09:30–16:00 ET",
        },
        {
          label: "Verdicts",
          value: `${ok}/${verdicts.length} Ok`,
          sub: others || "every token passes every check",
        },
        {
          label: "Block",
          value: <span className={styles.blockNum}>{snap.blockNumber.toLocaleString("en-US")}</span>,
          sub: fmtNy(snap.blockTimestamp),
        },
        {
          label: "Last read",
          value: `${fmtAge((nowMs - snap.fetchedAt) / 1000)} ago`,
          sub: `${snap.mode === "multicall" ? "one Multicall3 call" : "parallel reads"} · every 60 s`,
        },
      ]}
    />
  );
}

function RefreshNote({
  q,
  nowMs,
}: {
  q: { isFetching: boolean; dataUpdatedAt: number; refetch: () => unknown };
  nowMs: number;
}) {
  const next = q.dataUpdatedAt ? Math.max(0, (q.dataUpdatedAt + REFRESH_MS - nowMs) / 1000) : null;
  return (
    <div className={styles.refresh}>
      <span className={styles.live} data-busy={q.isFetching || undefined} aria-hidden />
      <span className="micro micro-muted" aria-live="polite">
        {q.isFetching ? "Reading mainnet…" : next !== null ? `Refresh in ${Math.ceil(next)} s` : "Live"}
      </span>
      <button
        type="button"
        className="pill pill-small pill-ghost"
        onClick={() => q.refetch()}
        disabled={q.isFetching}
      >
        Refresh <RotateCw aria-hidden />
      </button>
    </div>
  );
}

function Mainnet({ address, children }: { address: string; children?: ReactNode }) {
  const url = explorerUrl(MONITOR_CHAIN_ID, "address", address);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className={`mono ${styles.addr}`} title={address}>
      {children ?? shortAddr(address)} <ArrowUpRight size={11} aria-hidden />
    </a>
  ) : (
    <span className="mono" title={address}>
      {shortAddr(address)}
    </span>
  );
}

const HEAD = ["Token", "Verdict", "Chainlink price", "Per share", "ERC-8056 multiplier", "Pause flags"];

function TokenTable({ snap, nowMs }: { snap: MonitorSnapshot; nowMs: number }) {
  return (
    <div className={styles.table} role="table" aria-label="Stock-token safety checks">
      <div className={`${styles.head} micro micro-muted`} role="row">
        {HEAD.map((h) => (
          <span key={h} role="columnheader">
            {h}
          </span>
        ))}
      </div>
      {snap.rows.map((row) => (
        <TokenRowView key={row.token.symbol} row={row} snap={snap} nowMs={nowMs} />
      ))}
    </div>
  );
}

function TokenRowView({ row, snap, nowMs }: { row: TokenRow; snap: MonitorSnapshot; nowMs: number }) {
  const { token, reads } = row;
  const now = snap.blockTimestamp;
  const { verdict } = safeStockStatus(reads, now);
  const ca = corporateAction(reads, now, CORPORATE_ACTION_GRACE);
  const scheduled = multiplierChangeScheduled(reads);
  const round = reads.round;
  const price = round && round.answer > 0n ? toWad(round.answer, reads.feedDecimals) : null;
  const age = round ? chainNow(snap, nowMs) - Number(round.updatedAt) : null;
  const multiplier = reads.uiMultiplier && reads.uiMultiplier > 0n ? reads.uiMultiplier : null;
  const at = reads.effectiveAt ?? 0n;
  const graceEnd = at + BigInt(CORPORATE_ACTION_GRACE);

  const reason = ((): string => {
    switch (verdict) {
      case "Ok":
        return "All five checks pass: the contracts would use this price.";
      case "TokenPaused":
        return "paused() is true: Robinhood has halted the token.";
      case "FeedPaused":
        return "oraclePaused() is true: the feed is holding its last value.";
      case "CorporateActionPending":
        return scheduled
          ? `Multiplier changes to ${fmtMultiplier(reads.newUIMultiplier ?? 0n)} at ${fmtNy(at)}.`
          : `Multiplier changed ${fmtNy(at)}; the grace window ends ${fmtNy(graceEnd)}.`;
      case "InvalidPrice":
        return round && round.updatedAt > now
          ? "The round is timestamped in the future."
          : "The answer is ≤ 0.";
      case "StalePrice":
        return `Last print is older than ${fmtHours(MAX_PRICE_AGE)}.`;
      case "FeedUnreadable":
        return "latestRoundData() failed, so status() would revert.";
    }
  })();

  const caText = (() => {
    if (reads.uiMultiplier === null || reads.newUIMultiplier === null || reads.effectiveAt === null) {
      return "Not ERC-8056: never pending";
    }
    if (scheduled) return `Change pending · effective ${fmtNy(at)}`;
    if (ca.pending) return `In grace until ${fmtNy(graceEnd)}`;
    if (at === 0n) return null;
    return "No change pending";
  })();

  return (
    <div className={styles.row} role="row" data-verdict={verdict}>
      <div className={styles.token} role="cell">
        <span className={styles.ticker}>{token.symbol}</span>
        <span className={styles.name}>{token.name}</span>
        <span className={styles.addrs}>
          <span>
            <span className="micro micro-muted">Token</span> <Mainnet address={token.token} />
          </span>
          <span>
            <span className="micro micro-muted">Feed</span> <Mainnet address={token.feed} />
          </span>
        </span>
      </div>

      <div className={styles.cell} role="cell" data-label="Verdict">
        <span className={styles.verdict} data-tone={verdict === "Ok" ? "ok" : "bad"}>
          <span className={styles.verdictDot} aria-hidden />
          {VERDICT_LABEL[verdict]}
        </span>
        <span className={styles.sub}>{reason}</span>
      </div>

      <div className={styles.cell} role="cell" data-label="Chainlink price">
        <span className={styles.value}>{price !== null ? fmtWadUsd(price) : "—"}</span>
        <span className={styles.sub}>per raw token</span>
        {round ? (
          <>
            <span className={styles.sub} data-stale={age !== null && age > MAX_PRICE_AGE ? true : undefined}>
              updated {fmtAge(age ?? 0)} ago
            </span>
            <details className={styles.round}>
              <summary>Round</summary>
              <dl className={styles.kv}>
                <dt>roundId</dt>
                <dd className="mono">{round.roundId.toString()}</dd>
                <dt>answeredInRound</dt>
                <dd className="mono">{round.answeredInRound.toString()}</dd>
              </dl>
            </details>
          </>
        ) : (
          <span className={styles.sub}>feed unreadable</span>
        )}
      </div>

      <div className={styles.cell} role="cell" data-label="Per share (display only)">
        <span className={styles.value}>
          {price !== null ? fmtWadUsd(perSharePrice(price, multiplier ?? UNIT_MULTIPLIER)) : "—"}
        </span>
        <span className={styles.sub}>
          {multiplier && multiplier !== UNIT_MULTIPLIER
            ? `display only: price ÷ ${fmtMultiplier(multiplier)}`
            : "display only: 1 token = 1 share"}
        </span>
      </div>

      <div className={styles.cell} role="cell" data-label="ERC-8056 multiplier">
        <span className={styles.value}>
          {reads.uiMultiplier !== null ? fmtMultiplier(reads.uiMultiplier) : "—"}
        </span>
        <dl className={styles.kv}>
          <dt>next</dt>
          <dd className="mono" data-changed={scheduled || undefined}>
            {reads.newUIMultiplier !== null ? fmtMultiplier(reads.newUIMultiplier) : "—"}
          </dd>
          <dt>effectiveAt</dt>
          <dd className={at === 0n ? undefined : "mono"} title={at === 0n ? undefined : `effectiveAt ${at}`}>
            {reads.effectiveAt === null ? "—" : at === 0n ? "no change scheduled" : fmtNy(at)}
          </dd>
        </dl>
        {caText ? (
          <span className={styles.sub} data-pending={ca.pending || undefined}>
            {caText}
          </span>
        ) : null}
      </div>

      <div className={styles.cell} role="cell" data-label="Pause flags">
        <dl className={styles.kv}>
          <dt>paused()</dt>
          <dd>
            <Flag value={reads.paused} />
          </dd>
          <dt>oraclePaused()</dt>
          <dd>
            <Flag value={reads.oraclePaused} />
          </dd>
        </dl>
      </div>
    </div>
  );
}

function Flag({ value }: { value: boolean | null }) {
  if (value === null) {
    return (
      <span
        className={styles.flag}
        title="The call failed: SafeStockFeed treats a missing flag as not paused."
      >
        missing · not paused
      </span>
    );
  }
  return (
    <span className={styles.flag} data-on={value || undefined}>
      {value ? "true" : "false"}
    </span>
  );
}

function TableSkeleton() {
  return (
    <div className={styles.table} aria-busy="true" aria-label="Reading mainnet">
      <div className={`${styles.head} micro micro-muted`} aria-hidden>
        {HEAD.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      {MONITOR_TOKENS.map((t) => (
        <div key={t.symbol} className={styles.row} aria-hidden>
          <div className={styles.token}>
            <span className={styles.ticker}>{t.symbol}</span>
            <span className={styles.name}>{t.name}</span>
          </div>
          {HEAD.slice(1).map((h) => (
            <div key={h} className={styles.cell} data-label={h}>
              <Skeleton width="5em" />
              <Skeleton width="7em" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
