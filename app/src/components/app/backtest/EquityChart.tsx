"use client";

import type { PointerEvent } from "react";
import { fmtDate, logTicks, times, VAULT_NAME, type EquityPoint, type Vault } from "@/lib/backtest";
import { ChartFrame, Live, Tip, useActive, useWidth } from "./ChartFrame";
import styles from "./backtest.module.css";

const HEIGHT = 340;

interface Props {
  points: EquityPoint[];
  vault: Vault;
  ticker: string;
}

/** Vault vs buy-and-hold, both worth 1.0 at the first open, on one log axis. */
export function EquityChart({ points, vault, ticker }: Props) {
  const [wrap, width] = useWidth();
  const narrow = width < 520;
  const M = { top: 16, right: narrow ? 8 : 16, bottom: 34, left: narrow ? 40 : 48 };
  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const { active, setActive, bind } = useActive(points.length, points.length - 1);

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const all = points.flatMap((p) => [p.vault, p.bh]);
  const lo = Math.min(...all, 1) * 0.92;
  const hi = Math.max(...all, 1) * 1.08;
  const x = (t: number) => M.left + ((t - t0) / (t1 - t0)) * w;
  const y = (v: number) => M.top + (1 - (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * h;
  const path = (k: "vault" | "bh") =>
    points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");

  const yTicks = logTicks(lo, hi, narrow ? 5 : 7);
  // First labelled year: the first 1 January on the axis.
  const firstYear = Number(points[0].date.slice(0, 4)) + (points[0].date.endsWith("-01-01") ? 0 : 1);
  const lastYear = Number(points[points.length - 1].date.slice(0, 4));
  const years: number[] = [];
  for (let yr = firstYear; yr <= lastYear; yr++) if (!narrow || (yr - firstYear) % 2 === 0) years.push(yr);

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    if (px < M.left - 8 || px > M.left + w + 8) return setActive(null);
    const t = t0 + ((px - M.left) / w) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < points.length; i++)
      if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
    setActive(best);
  }

  const last = points[points.length - 1];
  const vaultHigher = last.vault >= last.bh;
  const gap = Math.abs(y(last.vault) - y(last.bh));
  const name = VAULT_NAME[vault];
  const hp = active === null ? null : points[active];
  const tipText = hp ? `${fmtDate(hp.date)}: ${name} ${times(hp.vault)}, buy-and-hold ${times(hp.bh)}` : "";

  const chart = (
    <div ref={wrap} className={styles.plot}>
      <svg
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={`Growth of 1.0 deposited on ${fmtDate(points[0].date)}: ${ticker} ${name.toLowerCase()} vault ends at ${times(last.vault)}, buy-and-hold at ${times(last.bh)} on ${fmtDate(last.date)}. Log scale. Use the arrow keys to read each week.`}
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
              className={t === 1 ? styles.base : styles.grid}
            />
            <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={styles.tick}>
              {t}×
            </text>
          </g>
        ))}
        <line x1={M.left} x2={M.left + w} y1={M.top + h} y2={M.top + h} className={styles.axis} />
        {years.map((yr) => {
          const t = Date.UTC(yr, 0, 1);
          return (
            <g key={yr}>
              <line x1={x(t)} x2={x(t)} y1={M.top + h} y2={M.top + h + 4} className={styles.axis} />
              <text x={x(t)} y={M.top + h + 18} textAnchor="middle" className={styles.tick}>
                {yr}
              </text>
            </g>
          );
        })}

        <path d={path("bh")} className={styles.line} data-series="bh" />
        <path d={path("vault")} className={styles.line} data-series="vault" />

        {/* Direct labels at the line ends, only when they don't collide (the legend always carries identity). */}
        {gap >= 30 ? (
          <>
            <text
              x={M.left + w - 2}
              y={y(last.vault) + (vaultHigher ? -10 : 18)}
              textAnchor="end"
              className={styles.endLabel}
            >
              {narrow ? "Vault" : name} {times(last.vault)}
            </text>
            <text
              x={M.left + w - 2}
              y={y(last.bh) + (vaultHigher ? 18 : -10)}
              textAnchor="end"
              className={styles.endLabel}
            >
              Buy-and-hold {times(last.bh)}
            </text>
          </>
        ) : null}

        {hp ? (
          <g aria-hidden className={styles.hover}>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={M.top} y2={M.top + h} />
            <circle cx={x(hp.t)} cy={y(hp.bh)} r={4} data-series="bh" />
            <circle cx={x(hp.t)} cy={y(hp.vault)} r={4} data-series="vault" />
          </g>
        ) : null}
      </svg>
      {hp ? (
        <Tip
          x={x(hp.t)}
          width={width}
          heading={fmtDate(hp.date)}
          rows={[
            { key: "vault", label: name, value: times(hp.vault) },
            { key: "bh", label: "Buy-and-hold", value: times(hp.bh) },
          ]}
          note={hp.assigned === null ? "Start" : hp.assigned ? "Week finished in the money" : undefined}
        />
      ) : null}
      <Live text={tipText} />
    </div>
  );

  const table = (
    <table className={styles.table}>
      <caption className="sr-only">
        Value of 1.0 deposited, at each weekly settlement close: {ticker} {name.toLowerCase()} vault and
        buy-and-hold
      </caption>
      <thead>
        <tr>
          <th scope="col">Week ending</th>
          <th scope="col" className={styles.num}>
            Vault
          </th>
          <th scope="col" className={styles.num}>
            Buy-and-hold
          </th>
          <th scope="col" className={styles.num}>
            In the money
          </th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.date}>
            <td>{p.assigned === null ? `${fmtDate(p.date)} (open)` : fmtDate(p.date)}</td>
            <td className={styles.num}>{p.vault.toFixed(3)}</td>
            <td className={styles.num}>{p.bh.toFixed(3)}</td>
            <td className={styles.num}>{p.assigned === null ? "" : p.assigned ? "Yes" : "No"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFrame
      id="bt-equity"
      title={`Growth of 1.0 · ${ticker} ${name.toLowerCase()} vs buy-and-hold`}
      legend={[
        { key: "vault", label: `${name} vault`, shape: "line" },
        { key: "bh", label: `Buy-and-hold ${ticker}`, shape: "line" },
      ]}
      chart={chart}
      table={table}
      caption={
        <>
          Value at each weekly settlement close, per 1.0 deposited at the first open (
          {fmtDate(points[0].date)}). Log scale: equal heights are equal percentage moves. Premium is held as
          USDG beside the collateral, not reinvested.
        </>
      }
    />
  );
}
