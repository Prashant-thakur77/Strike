"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, RotateCw } from "lucide-react";
import { errorMessage } from "@/hooks/useTx";
import {
  ACTIVITY_CHAIN_ID,
  ACTIVITY_EPOCH_MANAGER,
  ACTIVITY_FROM_BLOCK,
  EVENT_LABEL,
  addressUrl,
  txUrl,
  type ActivityRow,
  type ActivitySnapshot,
} from "@/lib/activity";
import { shortAddr } from "@/lib/format";
import { Skeleton } from "../Skeleton";
import { activityReader } from "./client";
import styles from "./activity.module.css";

export const ACTIVITY_REFRESH_MS = 30_000;

export interface ActivityFeedProps {
  /** Newest events to show; omit for the full history since the deploy block. */
  limit?: number;
  /** Hide the status line (live dot, counts, refresh button) when the host section has its own. */
  bare?: boolean;
  className?: string;
}

const localFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** "2026-09-29 17:09:45 UTC". */
function utcFull(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * Live EpochManager events on Robinhood Chain testnet (v2), newest first, read from contract logs without a
 * wallet. Refreshes every 30 s; each refresh only scans the blocks since the last one.
 */
export function ActivityFeed({ limit, bare = false, className }: ActivityFeedProps) {
  const q = useQuery({
    queryKey: ["activity", ACTIVITY_CHAIN_ID, ACTIVITY_EPOCH_MANAGER, limit ?? "all"],
    queryFn: () => activityReader().read(limit),
    refetchInterval: ACTIVITY_REFRESH_MS,
    refetchIntervalInBackground: false,
    staleTime: ACTIVITY_REFRESH_MS / 2,
    retry: 1,
  });
  const snap = q.data;

  return (
    <div className={`${styles.feed} ${className ?? ""}`}>
      {bare ? null : <StatusLine q={q} snap={snap} limit={limit} />}

      {q.isError && snap ? (
        <p className={styles.stale} role="status">
          The last refresh failed ({errorMessage(q.error)}). Showing the events read up to block{" "}
          {snap.toBlock.toLocaleString("en-US")}.
        </p>
      ) : null}

      {snap ? (
        snap.rows.length ? (
          <ol className={styles.list} aria-label="EpochManager events, newest first">
            {snap.rows.map((row) => (
              <Row key={row.id} row={row} />
            ))}
          </ol>
        ) : (
          <div className={styles.state}>
            <p className={styles.stateTitle}>No events yet.</p>
            <p className={styles.stateText}>
              The EpochManager has emitted no epoch, proposal, sale or settlement events since its deploy
              block {ACTIVITY_FROM_BLOCK.toLocaleString("en-US")}.
            </p>
          </div>
        )
      ) : q.isError ? (
        <div className={styles.state} role="alert">
          <p className={styles.stateTitle}>Couldn&apos;t read Robinhood Chain testnet.</p>
          <p className={styles.stateText}>{errorMessage(q.error)}</p>
          <button type="button" className="pill pill-small" onClick={() => q.refetch()}>
            Try again <RotateCw aria-hidden />
          </button>
        </div>
      ) : (
        <FeedSkeleton rows={Math.min(limit ?? 4, 5)} />
      )}
    </div>
  );
}

function StatusLine({
  q,
  snap,
  limit,
}: {
  q: { isFetching: boolean; isError: boolean; refetch: () => unknown };
  snap: ActivitySnapshot | undefined;
  limit?: number;
}) {
  const count = snap
    ? limit !== undefined && snap.total > snap.rows.length
      ? `Latest ${snap.rows.length} of ${snap.total} events`
      : `${snap.total} event${snap.total === 1 ? "" : "s"}`
    : "Reading events";
  return (
    <div className={styles.status}>
      <span className={styles.statusText}>
        <span className={styles.live} data-busy={q.isFetching || undefined} aria-hidden />
        <span className="micro micro-muted" aria-live="polite">
          {count}
          {snap ? ` · to block ${snap.toBlock.toLocaleString("en-US")}` : ""} · refreshes every 30 s
        </span>
      </span>
      <a
        className={`micro ${styles.contract}`}
        href={addressUrl(ACTIVITY_EPOCH_MANAGER)}
        target="_blank"
        rel="noreferrer"
        title={`EpochManager ${ACTIVITY_EPOCH_MANAGER}`}
      >
        v2 EpochManager {shortAddr(ACTIVITY_EPOCH_MANAGER)} <ArrowUpRight size={11} aria-hidden />
      </a>
      <button
        type="button"
        className={`pill pill-small pill-ghost ${styles.refresh}`}
        onClick={() => q.refetch()}
        disabled={q.isFetching}
      >
        Refresh <RotateCw aria-hidden />
      </button>
    </div>
  );
}

function Row({ row }: { row: ActivityRow }) {
  const date = new Date(row.timestamp * 1000);
  return (
    <li className={styles.row} data-tone={row.tone} data-tx={row.txHash} data-event={row.event}>
      <time className={styles.time} dateTime={date.toISOString()} title={utcFull(row.timestamp)}>
        {localFmt.format(date)}
        <span className="sr-only"> ({utcFull(row.timestamp)})</span>
      </time>
      <span className={styles.vault} title={row.vault}>
        {row.vaultSymbol}
      </span>
      <div className={styles.what}>
        <span className={styles.tag} data-tone={row.tone}>
          {EVENT_LABEL[row.event]}
        </span>
        <p className={styles.text}>{row.text}</p>
      </div>
      <a
        className={`mono ${styles.tx}`}
        href={txUrl(row.txHash)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Transaction ${row.txHash} on Blockscout`}
        title={row.txHash}
      >
        {shortAddr(row.txHash)} <ArrowUpRight size={11} aria-hidden />
      </a>
    </li>
  );
}

function FeedSkeleton({ rows }: { rows: number }) {
  return (
    <ol className={styles.list} aria-busy="true" aria-label="Reading EpochManager events">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className={styles.row} aria-hidden>
          <span className={styles.time}>
            <Skeleton width="6.5em" />
          </span>
          <span className={styles.vault}>
            <Skeleton width="5em" />
          </span>
          <div className={styles.what}>
            <Skeleton width="4.5em" />
            <Skeleton width="min(26em, 90%)" />
          </div>
          <span className={styles.tx}>
            <Skeleton width="6em" />
          </span>
        </li>
      ))}
    </ol>
  );
}
