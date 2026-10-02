"use client";

import { ArrowUpRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useMarket } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { explorerUrl, isAppChainId } from "@/lib/chains";
import { fmtUtc, marketLine, type MarketAction } from "@/lib/marketHours";
import type { MarketStatus } from "@/lib/reads";
import { Skeleton } from "../Skeleton";
import styles from "./market.module.css";

/** The viewer's clock in seconds, ticking every 30 s (for the countdown). Null until mounted, so SSR matches. */
function useWallClock(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Is the NYSE session open now, and when does that change: in UTC, in the viewer's time zone and as a countdown,
 * read from the deployment's MarketCalendar. `openEpoch` and `buy` revert with `MarketClosed` outside a session, so
 * every surface that can buy or open says so here instead of failing at the wallet. Reads the selected deployment
 * (the vault's own inside a vault page); `MarketHoursView` takes a status read elsewhere.
 */
export function MarketHours(props: { action: MarketAction; children?: ReactNode; compact?: boolean }) {
  const q = useMarket();
  const { chainId } = useStrike();
  if (!q.data) {
    if (q.isError) return null;
    return (
      <div className={styles.market} data-testid="market-hours" aria-busy="true">
        <Skeleton width="min(22em, 100%)" />
      </div>
    );
  }
  return <MarketHoursView {...props} market={q.data} chainId={chainId} />;
}

export function MarketHoursView({
  action,
  market: m,
  chainId,
  children,
  compact = false,
}: {
  action: MarketAction;
  market: MarketStatus;
  /** The chain the status was read on (for the calendar's explorer link). */
  chainId: number;
  children?: ReactNode;
  compact?: boolean;
}) {
  const wall = useWallClock();
  const line = marketLine(m, action, { wallNow: wall ?? undefined });
  const calendarUrl = isAppChainId(chainId) ? explorerUrl(chainId, "address", m.calendar) : null;
  return (
    <div
      className={styles.market}
      data-testid="market-hours"
      data-open={m.open}
      data-compact={compact || undefined}
      role="status"
    >
      <span className={styles.dot} aria-hidden />
      <div className={styles.body}>
        <p className={styles.head} data-testid="market-hours-headline">
          {line.headline}
        </p>
        <p className={styles.sub}>
          {line.local ? <span data-testid="market-hours-local">Your time: {line.local}</span> : null}
          {line.countdown ? <span>{line.countdown}</span> : null}
          <span>
            From{" "}
            {calendarUrl ? (
              <a href={calendarUrl} target="_blank" rel="noreferrer" className={styles.link}>
                MarketCalendar <ArrowUpRight size={11} aria-hidden />
              </a>
            ) : (
              "MarketCalendar"
            )}{" "}
            <code className="mono">sessionOf</code>
          </span>
        </p>
        {children}
      </div>
    </div>
  );
}

/** The strip cell's second line: "until Fri 2 Oct, 20:00 UTC" or "reopens Mon 5 Oct, 13:30 UTC", then the viewer's time. */
export function MarketSub({ market }: { market: MarketStatus }) {
  const at = market.open ? market.closesAt : market.opensAt;
  const line = marketLine(market, "buy");
  if (!at) return <>{market.open ? "NYSE regular session" : "no session in the next 14 days"}</>;
  return (
    <span className={styles.stripSub} data-testid="market-sub">
      <span>
        {market.open ? "until" : "reopens"} {fmtUtc(at)}
      </span>
      {line.local ? <span>your time {line.local}</span> : null}
    </span>
  );
}
