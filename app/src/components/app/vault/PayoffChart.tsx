"use client";

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";
import { breakeven, payoffAt } from "@/lib/payoff";
import styles from "../app.module.css";

interface PayoffChartProps {
  isCall: boolean;
  symbol: string;
  /** USD per token. */
  strike: number;
  spot: number;
  /** USD per option the buyer paid. */
  premium: number;
  /** Where `premium` comes from, for the caption. */
  premiumNote: string;
}

const M = { top: 44, right: 18, bottom: 46, left: 60 };
const HEIGHT = 300;

const usd = (n: number, frac = 2) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: frac, maximumFractionDigits: frac })}`;
const signed = (n: number, frac = 2) =>
  Math.abs(n) < 0.005 ? usd(0, frac) : `${n > 0 ? "+" : "−"}${usd(n, frac)}`;

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) ?? 10;
  return unit * pow;
}

function ticks(lo: number, hi: number, target: number): number[] {
  const step = niceStep(hi - lo, target);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

/** Buyer's and depositor's result at expiry, per option, against the settlement price. SVG, no dependency. */
export function PayoffChart({ isCall, symbol, strike, spot, premium, premiumNote }: PayoffChartProps) {
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

  const be = breakeven(isCall, strike, premium);
  const marks = [strike, spot, be].filter((v) => v > 0);
  const span = Math.max(...marks) - Math.min(...marks);
  const pad = Math.max(span * 0.6, strike * 0.07);
  const xLo = Math.max(0, Math.min(...marks) - pad);
  const xHi = Math.max(...marks) + pad;
  const xs = [xLo, strike, xHi];
  const vals = xs.flatMap((s) => {
    const p = payoffAt(isCall, strike, s, premium);
    return [p.buyer, p.depositor];
  });
  const yAbs = Math.max(...vals.map(Math.abs), premium * 2, 1) * 1.25;
  const yLo = -yAbs;
  const yHi = yAbs;

  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const x = (v: number) => M.left + ((v - xLo) / (xHi - xLo)) * w;
  const y = (v: number) => M.top + (1 - (v - yLo) / (yHi - yLo)) * h;
  const path = (side: "buyer" | "depositor") =>
    xs
      .map(
        (s, i) =>
          `${i ? "L" : "M"}${x(s).toFixed(1)},${y(payoffAt(isCall, strike, s, premium)[side]).toFixed(1)}`,
      )
      .join("");

  const xTicks = ticks(xLo, xHi, width < 480 ? 4 : 6);
  const yTicks = ticks(yLo, yHi, 6);
  const narrow = width < 480;

  // Labels at the top: the strike's anchored away from the breakeven, the spot's away from the strike.
  const beRight = be >= strike;
  const spotRight = spot >= strike;

  const last = payoffAt(isCall, strike, isCall ? xHi : xLo, premium);
  const endX = isCall ? xHi : xLo;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    if (px < M.left || px > M.left + w) return setHover(null);
    setHover(xLo + ((px - M.left) / w) * (xHi - xLo));
  }
  const hv = hover === null ? null : payoffAt(isCall, strike, hover, premium);

  const summary = isCall
    ? `The buyer paid about ${usd(premium)} per option. If ${symbol} settles above ${usd(be)} (the breakeven), the buyer gains $1 for every $1 above it; at or below the ${usd(strike)} strike the option expires worthless and the buyer loses the premium. The depositor keeps the ${usd(premium)} while ${symbol} settles at or below the strike and gives up the difference above it. ${symbol} is at ${usd(spot)} now.`
    : `The buyer paid about ${usd(premium)} per option. If ${symbol} settles below ${usd(be)} (the breakeven), the buyer gains $1 for every $1 below it; at or above the ${usd(strike)} strike the option expires worthless and the buyer loses the premium. The depositor keeps the ${usd(premium)} while ${symbol} settles at or above the strike and pays the difference below it. ${symbol} is at ${usd(spot)} now.`;

  const rows = [...new Set([xLo, spot, strike, be, xHi].map((v) => Math.round(v * 100) / 100))].sort(
    (a, b) => a - b,
  );

  return (
    <figure className={styles.payoff} aria-labelledby={titleId}>
      <div className={styles.payoffHead}>
        <h3 id={titleId} className="micro">
          Result at expiry, per option
        </h3>
        <ul className={styles.payoffLegend} aria-label="Legend">
          <li data-series="buyer">Buyer</li>
          <li data-series="depositor">Depositor</li>
        </ul>
      </div>
      <div ref={wrap} className={styles.payoffPlot}>
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
          {/* grid + y axis */}
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={M.left}
                x2={M.left + w}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? styles.pZero : styles.pGrid}
              />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={styles.pTick}>
                {signed(t, 0)}
              </text>
            </g>
          ))}
          {/* x axis */}
          <line x1={M.left} x2={M.left + w} y1={M.top + h} y2={M.top + h} className={styles.pAxis} />
          {xTicks.map((t) => (
            <text key={`x${t}`} x={x(t)} y={M.top + h + 18} textAnchor="middle" className={styles.pTick}>
              ${t.toLocaleString("en-US")}
            </text>
          ))}
          <text x={M.left + w / 2} y={HEIGHT - 6} textAnchor="middle" className={styles.pAxisTitle}>
            {symbol} price at expiry (USD)
          </text>
          <text
            transform={`translate(12 ${M.top + h / 2}) rotate(-90)`}
            textAnchor="middle"
            className={styles.pAxisTitle}
          >
            Result per option (USD)
          </text>

          {/* markers */}
          <line x1={x(strike)} x2={x(strike)} y1={M.top - 8} y2={M.top + h} className={styles.pStrike} />
          <text
            x={x(strike) + (beRight ? -6 : 6)}
            y={M.top - 26}
            textAnchor={beRight ? "end" : "start"}
            className={styles.pMark}
          >
            Strike {usd(strike)}
          </text>
          <line x1={x(be)} x2={x(be)} y1={M.top - 8} y2={M.top + h} className={styles.pBreakeven} />
          <text
            x={x(be) + (beRight ? 6 : -6)}
            y={M.top - 26}
            textAnchor={beRight ? "start" : "end"}
            className={styles.pMark}
          >
            {narrow ? "B/E" : "Breakeven"} {usd(be)}
          </text>
          <line x1={x(spot)} x2={x(spot)} y1={M.top + 4} y2={M.top + h} className={styles.pSpot} />
          <text
            x={x(spot) + (spotRight ? 6 : -6)}
            y={M.top - 10}
            textAnchor={spotRight ? "start" : "end"}
            className={styles.pMarkMuted}
          >
            Spot now {usd(spot)}
          </text>

          {/* series */}
          <path d={path("depositor")} className={styles.pDepositor} />
          <path d={path("buyer")} className={styles.pBuyer} />
          <text
            x={x(endX) + (isCall ? -4 : 4)}
            y={y(last.buyer) + (last.buyer >= last.depositor ? -10 : 18)}
            textAnchor={isCall ? "end" : "start"}
            className={styles.pSeriesLabel}
          >
            Buyer
          </text>
          <text
            x={x(endX) + (isCall ? -4 : 4)}
            y={y(last.depositor) + (last.depositor > last.buyer ? -10 : 18)}
            textAnchor={isCall ? "end" : "start"}
            className={styles.pSeriesLabel}
            data-series="depositor"
          >
            Depositor
          </text>

          {/* hover */}
          {hover !== null && hv ? (
            <g className={styles.pHover} aria-hidden>
              <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + h} />
              <circle cx={x(hover)} cy={y(hv.buyer)} r={4} data-series="buyer" />
              <circle cx={x(hover)} cy={y(hv.depositor)} r={4} data-series="depositor" />
            </g>
          ) : null}
        </svg>
        {hover !== null && hv ? (
          <div
            className={styles.pTip}
            style={{ left: Math.min(Math.max(x(hover), 90), width - 90) }}
            aria-hidden
          >
            <strong>
              {symbol} at {usd(hover)}
            </strong>
            <span data-series="buyer">Buyer {signed(hv.buyer)}</span>
            <span data-series="depositor">Depositor {signed(hv.depositor)}</span>
          </div>
        ) : null}
      </div>
      <figcaption id={descId} className={styles.payoffCaption}>
        {summary}{" "}
        <span className={styles.payoffNote}>
          {isCall
            ? `Calls pay (S − K) / S ${symbol} per option, worth S − K dollars at settlement price S.`
            : "Puts pay K − S USDG per option."}{" "}
          Premium: {premiumNote}. The depositor line leaves out the stock&apos;s own move.
        </span>
      </figcaption>
      <details className={styles.payoffTable}>
        <summary className="micro">Show as a table</summary>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{symbol} at expiry</th>
                <th scope="col" className={styles.num}>
                  Payout
                </th>
                <th scope="col" className={styles.num}>
                  Buyer
                </th>
                <th scope="col" className={styles.num}>
                  Depositor
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const p = payoffAt(isCall, strike, s, premium);
                const tag =
                  s === Math.round(strike * 100) / 100
                    ? " · strike"
                    : s === Math.round(be * 100) / 100
                      ? " · breakeven"
                      : s === Math.round(spot * 100) / 100
                        ? " · spot now"
                        : "";
                return (
                  <tr key={s}>
                    <td className="mono">
                      {usd(s)}
                      <span className={styles.cellMuted}>{tag.replace(" · ", "")}</span>
                    </td>
                    <td className={`mono ${styles.num}`}>{usd(p.payout)}</td>
                    <td className={`mono ${styles.num}`}>{signed(p.buyer)}</td>
                    <td className={`mono ${styles.num}`}>{signed(p.depositor)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
