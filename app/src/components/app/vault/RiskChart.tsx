"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "../app.module.css";

/** One point of the stress grid, in plain numbers. */
export interface RiskPoint {
  /** Relative spot move, 0.1 = +10%. */
  shock: number;
  /** Spot at expiry, USD per token. */
  spot: number;
  /** USD the vault pays option holders (the risk engine's scenarioLoss). */
  payout: number;
  /** Premium collected minus the payout, USD. */
  net: number;
}

interface RiskChartProps {
  symbol: string;
  points: RiskPoint[];
  /** Index of the worst point (the engine's first largest payout). */
  worst: number;
  premium: number;
  titleId: string;
}

const M = { top: 34, right: 12, bottom: 50, left: 62 };
const HEIGHT = 300;

const money = (n: number, frac = 2) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
const signed = (n: number, frac = 2) =>
  Math.abs(n) < 0.005 ? money(0, frac) : `${n > 0 ? "+" : "−"}${money(n, frac)}`;
export const shockLabel = (s: number) =>
  Math.abs(s) < 1e-9 ? "0%" : `${s > 0 ? "+" : "−"}${Math.round(Math.abs(s) * 100)}%`;

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) ?? 10;
  return unit * pow;
}

/** A column with a 4px rounded data end and a square end on the zero baseline. */
function column(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return "";
  const r = Math.min(4, h, w / 2);
  if (y1 < y0) {
    // grows up
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

/**
 * The vault's result at expiry (premium kept minus what it pays holders) across the stress grid: one column per
 * spot move, one USD axis with its zero baseline, the worst case marked. SVG, no dependency.
 */
export function RiskChart({ symbol, points, worst, premium, titleId }: RiskChartProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
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

  const narrow = width < 480;
  const nets = points.map((p) => p.net);
  const hi = Math.max(0, ...nets);
  const lo = Math.min(0, ...nets);
  const span = hi - lo || 1;
  const step = niceStep(span, narrow ? 4 : 5);
  const yHi = Math.ceil((hi + span * 0.08) / step) * step;
  const yLo = Math.floor((lo - span * 0.22) / step) * step;
  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const y = (v: number) => M.top + (1 - (v - yLo) / (yHi - yLo)) * h;
  const slot = w / points.length;
  const barW = Math.min(24, Math.max(6, slot - 6));
  const cx = (i: number) => M.left + slot * i + slot / 2;
  const yTicks: number[] = [];
  for (let v = yLo; v <= yHi + 1e-9; v += step) yTicks.push(Number(v.toFixed(6)));
  const zero = y(0);
  const today = points.findIndex((p) => Math.abs(p.shock) < 1e-9);
  const wp = points[worst];
  const hv = hover === null ? null : points[hover];

  // Worst-case label: under a loss bar, above a gain bar; anchored away from the plot edge.
  const worstAnchor =
    worst > points.length * 0.66 ? "end" : worst < points.length * 0.33 ? "start" : "middle";
  const worstDx = worstAnchor === "end" ? barW / 2 : worstAnchor === "start" ? -barW / 2 : 0;

  return (
    <div className={styles.riskFigure}>
      <div ref={wrap} className={styles.payoffPlot}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-labelledby={titleId}
          aria-describedby={descId}
          onPointerLeave={() => setHover(null)}
        >
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={M.left}
                x2={M.left + w}
                y1={y(t)}
                y2={y(t)}
                className={Math.abs(t) < 1e-9 ? styles.pZero : styles.pGrid}
              />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={styles.pTick}>
                {signed(t, 0)}
              </text>
            </g>
          ))}
          <text
            transform={`translate(12 ${M.top + h / 2}) rotate(-90)`}
            textAnchor="middle"
            className={styles.pAxisTitle}
          >
            Vault result (USD)
          </text>

          {points.map((p, i) => {
            const show = !narrow || i % 2 === 0;
            return show ? (
              <text
                key={`x${p.shock}`}
                x={cx(i)}
                y={M.top + h + 18}
                textAnchor="middle"
                className={i === today ? styles.pMark : styles.pTick}
              >
                {shockLabel(p.shock)}
              </text>
            ) : null;
          })}
          <text x={M.left + w / 2} y={HEIGHT - 8} textAnchor="middle" className={styles.pAxisTitle}>
            {symbol} move by expiry
          </text>

          {points.map((p, i) => (
            <path
              key={`b${p.shock}`}
              d={column(cx(i) - barW / 2, barW, zero, y(p.net))}
              className={p.net < 0 ? styles.riskLoss : styles.riskGain}
              data-worst={i === worst || undefined}
              opacity={hover === null || hover === i ? 1 : 0.55}
            />
          ))}
          <line x1={M.left} x2={M.left + w} y1={zero} y2={zero} className={styles.pZero} />

          {/* today's spot: the 0% column's value */}
          {today >= 0 && today !== worst ? (
            <text
              x={cx(today)}
              y={Math.min(y(points[today]!.net), zero) - 8}
              textAnchor="middle"
              className={styles.pMarkMuted}
            >
              {signed(points[today]!.net)}
            </text>
          ) : null}

          {/* worst case */}
          {wp && wp.net < 0 ? (
            <g>
              <text
                x={cx(worst) + worstDx}
                y={y(wp.net) + 18}
                textAnchor={worstAnchor}
                className={styles.pMark}
              >
                Worst {signed(wp.net)}
              </text>
              <text
                x={cx(worst) + worstDx}
                y={y(wp.net) + 33}
                textAnchor={worstAnchor}
                className={styles.pMarkMuted}
              >
                at {shockLabel(wp.shock)}
              </text>
            </g>
          ) : null}

          {/* hit targets: the whole slot, keyboard-focusable */}
          {points.map((p, i) => (
            <rect
              key={`h${p.shock}`}
              x={M.left + slot * i}
              y={M.top}
              width={slot}
              height={h}
              fill="transparent"
              tabIndex={0}
              aria-label={`${symbol} ${shockLabel(p.shock)}: holders paid ${money(p.payout)}, vault ${signed(p.net)}`}
              onPointerEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className={styles.riskHit}
            />
          ))}
        </svg>
        {hv && hover !== null ? (
          <div
            className={styles.pTip}
            style={{ left: Math.min(Math.max(cx(hover), 96), width - 96) }}
            aria-hidden
          >
            <strong>
              {symbol} {shockLabel(hv.shock)} → {money(hv.spot)}
            </strong>
            <span>Holders paid {money(hv.payout)}</span>
            <span>Premium kept {money(premium)}</span>
            <span>Vault {signed(hv.net)}</span>
          </div>
        ) : null}
      </div>
      <p id={descId} className="sr-only">
        Columns show the vault&apos;s result at expiry for {symbol} moves of{" "}
        {shockLabel(points[0]?.shock ?? 0)} to {shockLabel(points.at(-1)?.shock ?? 0)}. The worst case is{" "}
        {wp ? signed(wp.net) : "none"} at {wp ? shockLabel(wp.shock) : "no move"}. The table view lists every
        value.
      </p>
    </div>
  );
}
