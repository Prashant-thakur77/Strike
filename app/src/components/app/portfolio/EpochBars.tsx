"use client";

import { useEffect, useId, useRef, useState } from "react";
import { explorerUrl, isAppChainId } from "@/lib/chains";
import type { EpochResult } from "@/lib/portfolioLedger";
import appStyles from "../app.module.css";
import styles from "./portfolio.module.css";
import { money } from "./ValueChart";

const M = { top: 18, right: 12, bottom: 54, left: 64 };
const HEIGHT = 260;
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * One group per closed epoch the wallet was in: the net (premium credited minus its part of the payout), and for a
 * covered call what holding the same tokens over the same week did. Each group links to the settlement transaction.
 */
export function EpochBars({ epochs }: { epochs: EpochResult[] }) {
  const closed = epochs
    .filter((e) => e.net !== null && e.closedAt !== null)
    .sort((a, b) => a.closedAt! - b.closedAt!);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.max(280, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (closed.length === 0) return null;
  const hasHold = closed.some((e) => e.holdUsd !== null);
  const vals = closed.flatMap((e) => [e.net ?? 0, e.holdUsd ?? 0, 0]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  const yLo = lo < 0 ? lo - pad : 0;
  const yHi = hi + pad;
  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const y = (v: number) => M.top + (1 - (v - yLo) / (yHi - yLo)) * h;
  const slot = w / closed.length;
  const barW = Math.max(6, Math.min(28, (slot - 10) / (hasHold ? 2 : 1) - 2));
  const ticks = Array.from({ length: 5 }, (_, i) => yLo + ((yHi - yLo) * i) / 4);
  const bar = (x0: number, v: number, cls: string) => {
    const top = Math.min(y(v), y(0));
    const height = Math.max(Math.abs(y(v) - y(0)), 1);
    return <rect x={x0} y={top} width={barW} height={height} rx={Math.min(4, barW / 2)} className={cls} />;
  };
  return (
    <figure
      className={appStyles.payoff}
      aria-labelledby={titleId}
      data-testid="epoch-bars"
      data-bars={closed.length}
    >
      <div className={appStyles.payoffHead}>
        <h3 id={titleId} className="micro">
          Net per closed epoch, USD
        </h3>
      </div>
      <ul className={appStyles.payoffLegend} aria-label="Legend">
        <li data-series="gain">Net: premium credited − your part of the payout</li>
        <li data-series="loss">Net below zero</li>
        {hasHold ? <li>Covered calls: holding the same tokens that week (stock move only)</li> : null}
      </ul>
      <div ref={wrap} className={appStyles.payoffPlot}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + w} y1={y(t)} y2={y(t)} className={appStyles.pGrid} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={appStyles.pTick}>
                {money(t, yHi - yLo < 20 ? 2 : 0)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={M.left + w} y1={y(0)} y2={y(0)} className={appStyles.pAxis} />
          {closed.map((e, i) => {
            const x0 = M.left + i * slot + (slot - barW * (hasHold ? 2 : 1) - (hasHold ? 2 : 0)) / 2;
            const url =
              e.txClosed && isAppChainId(e.chainId) ? explorerUrl(e.chainId, "tx", e.txClosed) : null;
            const label = `${e.symbol} (${e.version}) epoch ${e.epoch}, ${day(e.closedAt!)}: net ${money(e.net ?? 0)}${
              e.holdUsd !== null ? `, holding ${money(e.holdUsd)}` : ""
            }`;
            const g = (
              <g
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                {bar(x0, e.net ?? 0, (e.net ?? 0) >= 0 ? styles.barGain : styles.barLoss)}
                {e.holdUsd !== null ? bar(x0 + barW + 2, e.holdUsd, styles.barHold) : null}
                <rect x={M.left + i * slot} y={M.top} width={slot} height={h} className={styles.barHit} />
                <text
                  x={M.left + i * slot + slot / 2}
                  y={M.top + h + 16}
                  textAnchor="middle"
                  className={appStyles.pTick}
                >
                  {closed.length > 8 && i % 2 ? "" : day(e.closedAt!)}
                </text>
                <text
                  x={M.left + i * slot + slot / 2}
                  y={M.top + h + 30}
                  textAnchor="middle"
                  className={appStyles.pTick}
                >
                  {closed.length > 8 ? "" : e.underlying}
                </text>
                <title>{label}</title>
              </g>
            );
            return url ? (
              <a
                key={`${e.deployment}-${e.vault}-${e.epoch}`}
                href={url}
                target="_blank"
                rel="noreferrer"
                aria-label={`${label}. Settlement transaction`}
              >
                {g}
              </a>
            ) : (
              <g key={`${e.deployment}-${e.vault}-${e.epoch}`}>{g}</g>
            );
          })}
        </svg>
        {hover !== null && closed[hover] ? (
          <div
            className={appStyles.pTip}
            style={{ left: Math.min(Math.max(M.left + hover * slot + slot / 2, 100), width - 100) }}
            aria-hidden
          >
            <strong>
              {closed[hover]!.symbol} ({closed[hover]!.version}) epoch {closed[hover]!.epoch}
            </strong>
            <span>premium {money(closed[hover]!.premium ?? 0, 4)}</span>
            <span>payout −{money(closed[hover]!.payoutUsd ?? 0, 4)}</span>
            <span>net {money(closed[hover]!.net ?? 0, 4)}</span>
            {closed[hover]!.holdUsd !== null ? (
              <span>holding {money(closed[hover]!.holdUsd!, 4)}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <figcaption className={appStyles.payoffCaption}>
        {closed.length} closed epoch{closed.length === 1 ? "" : "s"}: a small sample on a testnet, so read it
        as a record, not a track record. Each bar links to the transaction that closed the epoch. An aborted
        epoch sold nothing; its premium is the slashed bond of the rejected proposal, paid to depositors.
        {hasHold
          ? " The grey bar is what the same tokens gained or lost from the stock's move between the epoch's open spot and the settlement price; the covered call's result that week is that plus the net."
          : ""}
      </figcaption>
    </figure>
  );
}
