"use client";

import type { PointerEvent } from "react";
import { histogram, pctOf, ticks, VAULT_NAME, type Vault } from "@/lib/backtest";
import { ChartFrame, Live, Tip, useActive, useWidth } from "./ChartFrame";
import styles from "./backtest.module.css";

const HEIGHT = 280;
const GAP = 2;
const MAX_BAR = 24;

interface Props {
  /** Weekly premium per option, % of collateral. */
  values: number[];
  /** Mean over the weeks, % of collateral (from the grid). */
  average: number;
  ticker: string;
  vault: Vault;
}

const range = (lo: number, hi: number) => `${lo.toFixed(2)}–${hi.toFixed(2)}%`;

/** How many weeks paid how much premium: one column per equal-width band of % of collateral. */
export function PremiumHistogram({ values, average, ticker, vault }: Props) {
  const [wrap, width] = useWidth();
  const narrow = width < 520;
  const bins = histogram(values, narrow ? 12 : 24);
  const M = { top: 28, right: 8, bottom: 40, left: narrow ? 34 : 44 };
  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const peak = bins.reduce((i, b, j) => (b.count > bins[i].count ? j : i), 0);
  const { active, setActive, bind } = useActive(bins.length, peak);

  const xMax = bins[bins.length - 1].hi;
  const slot = w / bins.length;
  const bar = Math.min(MAX_BAR, slot - GAP);
  const x = (v: number) => M.left + (v / xMax) * w;
  const yMax = Math.max(...bins.map((b) => b.count));
  const yTicks = ticks(0, yMax, 4);
  const top = yTicks[yTicks.length - 1] >= yMax ? yTicks[yTicks.length - 1] : yMax;
  const y = (c: number) => M.top + (1 - c / top) * h;
  const xTicks = ticks(0, xMax, narrow ? 4 : 7);
  const xStep = xTicks.length > 1 ? xTicks[1] - xTicks[0] : xMax;
  const xDp = xStep < 0.1 - 1e-9 ? 2 : xStep < 1 - 1e-9 ? 1 : 0;
  const n = values.length;

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.floor((px - M.left) / slot);
    setActive(i >= 0 && i < bins.length ? i : null);
  }

  /** Rounded top (4px), square at the baseline. */
  function column(cx: number, c: number) {
    const x0 = cx - bar / 2;
    const y0 = y(c);
    const base = M.top + h;
    const r = Math.min(4, bar / 2, base - y0);
    return `M${x0},${base}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bar - r}Q${x0 + bar},${y0} ${x0 + bar},${y0 + r}V${base}Z`;
  }

  const hb = active === null ? null : bins[active];
  const share = (c: number) => `${((c / n) * 100).toFixed(1)}% of weeks`;
  const tipText = hb ? `${range(hb.lo, hb.hi)} of collateral: ${hb.count} weeks, ${share(hb.count)}` : "";
  const avgX = x(average);
  const avgRight = avgX < M.left + w * 0.7;

  const chart = (
    <div ref={wrap} className={styles.plot}>
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={`Weekly premium for the ${ticker} ${VAULT_NAME[vault].toLowerCase()} vault over ${n} weeks: most weeks paid ${range(bins[peak].lo, bins[peak].hi)} of collateral; the average was ${pctOf(average, 2)}. Use the arrow keys to read each band.`}
        onPointerMove={onMove}
        onPointerDown={onMove}
        {...bind}
        className={styles.svg}
      >
        {yTicks.map((t) => (
          <g key={t}>
            <line
              x1={M.left}
              x2={M.left + w}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? styles.axis : styles.grid}
            />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={styles.tick}>
              {t}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={M.top + h + 18} textAnchor="middle" className={styles.tick}>
            {t.toFixed(xDp)}%
          </text>
        ))}
        <text x={M.left + w / 2} y={HEIGHT - 4} textAnchor="middle" className={styles.axisTitle}>
          Premium per week, % of collateral
        </text>
        <text x={M.left - (narrow ? 30 : 40)} y={M.top - 14} className={styles.axisTitle}>
          Weeks
        </text>

        {bins.map((b, i) => {
          const cx = M.left + slot * (i + 0.5);
          return (
            <g key={b.lo} data-active={active === i || undefined} className={styles.col}>
              {/* The hit target is the whole slot, not just the painted column. */}
              <rect x={M.left + slot * i} y={M.top} width={slot} height={h} className={styles.hit} />
              {b.count > 0 ? <path d={column(cx, b.count)} data-series="vault" /> : null}
            </g>
          );
        })}

        <line x1={avgX} x2={avgX} y1={M.top - 6} y2={M.top + h} className={styles.marker} />
        <text
          x={avgX + (avgRight ? 6 : -6)}
          y={M.top - 8}
          textAnchor={avgRight ? "start" : "end"}
          className={styles.markLabel}
        >
          Average {pctOf(average, 2)}
        </text>
      </svg>
      {hb && active !== null ? (
        <Tip
          x={M.left + slot * (active + 0.5)}
          width={width}
          top={M.top + 4}
          heading={`${range(hb.lo, hb.hi)} of collateral`}
          rows={[{ key: "vault", label: "weeks", value: String(hb.count) }]}
          note={share(hb.count)}
        />
      ) : null}
      <Live text={tipText} />
    </div>
  );

  const table = (
    <table className={styles.table}>
      <caption className="sr-only">
        Weeks by premium per option, % of collateral, {ticker} {VAULT_NAME[vault].toLowerCase()} vault
      </caption>
      <thead>
        <tr>
          <th scope="col">Premium, % of collateral</th>
          <th scope="col" className={styles.num}>
            Weeks
          </th>
          <th scope="col" className={styles.num}>
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {bins.map((b) => (
          <tr key={b.lo}>
            <td>{range(b.lo, b.hi)}</td>
            <td className={styles.num}>{b.count}</td>
            <td className={styles.num}>{((b.count / n) * 100).toFixed(1)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFrame
      id="bt-premium"
      title={`Weekly premium · ${n} weeks`}
      chart={chart}
      table={table}
      caption={
        <>
          Premium per option ÷ collateral per option (spot for calls, strike for puts), one count per week.
          The vault sells 80% of its capacity, so it earns 80% of this on its capital. Each band includes its
          lower edge.
        </>
      }
    />
  );
}
