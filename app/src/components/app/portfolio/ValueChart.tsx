"use client";

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import type { ChartMarker, ChartPoint } from "@/lib/portfolioLedger";
import { TableWrap } from "../TableWrap";
import appStyles from "../app.module.css";
import styles from "./portfolio.module.css";

const M = { top: 24, right: 18, bottom: 46, left: 70 };
const HEIGHT = 300;
const DAY = 86_400;

export const RANGES = { "1w": 7 * DAY, "1m": 30 * DAY, all: Infinity } as const;
export type Range = keyof typeof RANGES;

export function money(x: number, frac = 2): string {
  const a = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac });
  return `${x < 0 ? "−" : ""}$${a}`;
}
const signed = (x: number) => `${x > 0 ? "+" : ""}${money(x)}`;
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const utc = (t: number) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The points inside the range, with the last point before it carried to the range's start. */
export function inRange(points: ChartPoint[], range: Range, now: number): ChartPoint[] {
  const from = now - RANGES[range];
  if (!Number.isFinite(from) || points.length === 0 || points[0]!.t >= from) return points;
  const before = points.filter((p) => p.t < from).at(-1);
  const after = points.filter((p) => p.t >= from);
  return before ? [{ ...before, t: from }, ...after] : after;
}

/** Last point at or before `t`. */
function at(points: ChartPoint[], t: number): ChartPoint | null {
  let last: ChartPoint | null = null;
  for (const p of points) {
    if (p.t > t) break;
    last = p;
  }
  return last;
}

/** The wallet's value over time, or its P&L (value − net deposited), with the time range to show. */
export function ValueChart({
  points,
  markers,
  now,
}: {
  points: ChartPoint[];
  markers: ChartMarker[];
  now: number;
}) {
  const [mode, setMode] = useState<"value" | "pnl">("value");
  const [range, setRange] = useState<Range>("all");
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.max(280, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = inRange(points, range, now);
  const marks = markers.filter((m) => pts.length && m.t >= pts[0]!.t && m.t <= now);
  const tLo = pts[0]?.t ?? now - DAY;
  const tHi = Math.max(now, tLo + 3600);
  const series = pts.map((p) => ({ t: p.t, a: p.value, b: p.invested, pnl: p.value - p.invested }));
  const values = mode === "value" ? series.flatMap((s) => [s.a, s.b]) : [0, ...series.map((s) => s.pnl)];
  const vMin = Math.min(...values, mode === "value" ? Infinity : 0);
  const vMax = Math.max(...values, mode === "value" ? -Infinity : 0);
  const pad = (vMax - vMin) * 0.1 || Math.max(Math.abs(vMax) * 0.1, 1);
  const yLo = mode === "value" ? Math.max(0, vMin - pad) : vMin - pad;
  const yHi = vMax + pad;
  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - tLo) / (tHi - tLo)) * w;
  const y = (v: number) => M.top + (1 - (v - yLo) / (yHi - yLo)) * h;
  // Holdings change at events and hold until the next one: steps, not slopes.
  const step = (get: (s: (typeof series)[number]) => number) =>
    series.map((s, i) => (i === 0 ? `M${x(s.t)},${y(get(s))}` : `H${x(s.t)}V${y(get(s))}`)).join("") +
    (series.length ? `H${x(tHi)}` : "");
  const pnlLine = step((s) => s.pnl);
  const pnlArea = series.length ? `${pnlLine}V${y(0)}H${x(series[0]!.t)}Z` : "";
  const clip = useId().replace(/:/g, "");
  const yTicks = Array.from({ length: 5 }, (_, i) => yLo + ((yHi - yLo) * i) / 4);
  const span = tHi - tLo;
  const stepDays = span > 40 * DAY ? 14 : span > 14 * DAY ? 7 : span > 5 * DAY ? 2 : 1;
  const xTicks: number[] = [];
  for (let t = Math.ceil(tLo / DAY) * DAY; t <= tHi; t += stepDays * DAY) xTicks.push(t);
  const xShown = width < 480 ? xTicks.filter((_, i) => i % 2 === 0) : xTicks;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    if (px < M.left || px > M.left + w) return setHover(null);
    setHover(tLo + ((px - M.left) / w) * (tHi - tLo));
  }
  const hp = hover === null ? null : at(pts, hover);
  const last = pts.at(-1);

  return (
    <figure
      className={appStyles.payoff}
      aria-labelledby={titleId}
      data-testid="value-chart"
      data-points={pts.length}
    >
      <div className={appStyles.payoffHead}>
        <h3 id={titleId} className="micro">
          {mode === "value" ? "Value and net deposited, USD" : "P&L over time (value − net deposited), USD"}
        </h3>
        <div className={styles.chartControls}>
          <div className={styles.chipGroup} role="group" aria-label="What to plot">
            {(
              [
                ["value", "Value"],
                ["pnl", "P&L"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className="chip"
                aria-pressed={mode === k}
                onClick={() => setMode(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={styles.chipGroup} role="group" aria-label="Time range">
            {(
              [
                ["1w", "1W"],
                ["1m", "1M"],
                ["all", "All"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className="chip"
                aria-pressed={range === k}
                onClick={() => setRange(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mode === "value" ? (
        <ul className={appStyles.payoffLegend} aria-label="Legend">
          <li data-series="depositor">Value now (positions + premium to claim)</li>
          <li className={styles.legendDash}>Net deposited (deposits − withdrawals − premium claimed)</li>
        </ul>
      ) : (
        <ul className={appStyles.payoffLegend} aria-label="Legend">
          <li data-series="gain">Above net deposited</li>
          <li data-series="loss">Below</li>
        </ul>
      )}
      <div ref={wrap} className={appStyles.payoffPlot}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          aria-describedby={descId}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id={`${clip}-up`}>
              <rect x={0} y={0} width={width} height={Math.max(0, y(0))} />
            </clipPath>
            <clipPath id={`${clip}-down`}>
              <rect x={0} y={y(0)} width={width} height={Math.max(0, HEIGHT - y(0))} />
            </clipPath>
          </defs>
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={M.left} x2={M.left + w} y1={y(t)} y2={y(t)} className={appStyles.pGrid} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={appStyles.pTick}>
                {money(t, Math.abs(yHi - yLo) < 20 ? 2 : 0)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={M.left + w} y1={M.top + h} y2={M.top + h} className={appStyles.pAxis} />
          {xShown.map((t) => (
            <text key={`x${t}`} x={x(t)} y={M.top + h + 18} textAnchor="middle" className={appStyles.pTick}>
              {day(t)}
            </text>
          ))}
          <text x={M.left + w / 2} y={HEIGHT - 6} textAnchor="middle" className={appStyles.pAxisTitle}>
            Date (UTC)
          </text>
          {mode === "value" ? (
            <>
              <path d={step((s) => s.b)} className={styles.lineInvested} />
              <path d={step((s) => s.a)} className={styles.lineValue} />
            </>
          ) : (
            <>
              <path d={pnlArea} className={styles.areaGain} clipPath={`url(#${clip}-up)`} />
              <path d={pnlArea} className={styles.areaLoss} clipPath={`url(#${clip}-down)`} />
              <line x1={M.left} x2={M.left + w} y1={y(0)} y2={y(0)} className={appStyles.pAxis} />
              <path d={pnlLine} className={styles.linePnl} />
            </>
          )}
          {marks.map((m, i) => (
            <circle
              key={`${m.t}-${i}`}
              cx={x(m.t)}
              cy={M.top + h}
              r={4}
              className={styles.marker}
              data-kind={m.kind}
            >
              <title>{`${utc(m.t)}: ${m.label}`}</title>
            </circle>
          ))}
          {hover !== null && hp ? (
            <g className={appStyles.pHover} aria-hidden>
              <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + h} />
              <circle
                cx={x(hover)}
                cy={y(mode === "value" ? hp.value : hp.value - hp.invested)}
                r={4}
                data-series="depositor"
              />
            </g>
          ) : null}
        </svg>
        {hover !== null && hp ? (
          <div
            className={appStyles.pTip}
            style={{ left: Math.min(Math.max(x(hover), 100), width - 100) }}
            aria-hidden
          >
            <strong>{utc(Math.max(hp.t, tLo))}</strong>
            <span>value {money(hp.value)}</span>
            <span>net deposited {money(hp.invested)}</span>
            <span>P&amp;L {signed(hp.value - hp.invested)}</span>
          </div>
        ) : null}
      </div>
      <figcaption id={descId} className={appStyles.payoffCaption}>
        {last
          ? `Now ${money(last.value)} against ${money(last.invested)} net deposited (${signed(last.value - last.invested)}). `
          : null}
        A point at each of the wallet&apos;s deposits, withdrawals and claims and each open and settlement of
        an epoch it was in (the dots on the axis), one a day in between, and one now from today&apos;s reads.
        Share prices come from the vaults&apos; settlement events; call vaults are valued at the stock&apos;s
        oracle round of the time (testnet prices mirrored from Robinhood Chain mainnet Chainlink). The public
        RPCs keep no historical state, so nothing here is read at an old block.
      </figcaption>
      <details className={appStyles.payoffTable}>
        <summary className="micro">Show as a table</summary>
        <TableWrap stack>
          <table className={appStyles.table}>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col" className={appStyles.num}>
                  Value
                </th>
                <th scope="col" className={appStyles.num}>
                  Net deposited
                </th>
                <th scope="col" className={appStyles.num}>
                  P&amp;L
                </th>
              </tr>
            </thead>
            <tbody>
              {pts.map((p, i) => (
                <tr key={`${p.t}-${i}`} data-testid="value-row">
                  <td className="mono">{utc(p.t)}</td>
                  <td className={`mono ${appStyles.num}`}>{money(p.value)}</td>
                  <td className={`mono ${appStyles.num}`}>{money(p.invested)}</td>
                  <td className={`mono ${appStyles.num}`}>{signed(p.value - p.invested)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </details>
    </figure>
  );
}
