"use client";

import type { PointerEvent } from "react";
import {
  num,
  pct,
  SERIES_DELTA,
  ticks,
  VAULT_NAME,
  type GridRow,
  type Vault,
  type Vrp,
} from "@/lib/backtest";
import { ChartFrame, Live, Tip, useActive, useWidth } from "./ChartFrame";
import styles from "./backtest.module.css";

const HEIGHT = 230;

interface Props {
  rows: GridRow[];
  ticker: string;
  vault: Vault;
  vrp: Vrp;
}

interface Metric {
  key: "cagr" | "sharpe";
  title: string;
  vault: (r: GridRow) => number;
  bh: (r: GridRow) => number;
  fmt: (v: number) => string;
  tick: (v: number) => string;
}

const METRICS: Metric[] = [
  {
    key: "cagr",
    title: "Annual return (CAGR)",
    vault: (r) => r.cagr,
    bh: (r) => r.bhCagr,
    fmt: (v) => pct(v, 1),
    tick: (v) => pct(v, 0),
  },
  {
    key: "sharpe",
    title: "Sharpe ratio",
    vault: (r) => r.sharpe,
    bh: (r) => r.bhSharpe,
    fmt: (v) => num(v, 2),
    tick: (v) => (Number.isInteger(v) ? num(v, 0) : Number.isInteger(v * 10) ? num(v, 1) : num(v, 2)),
  },
];

/** CAGR and Sharpe across the target deltas in the grid, with buy-and-hold as the reference line. */
export function DeltaChart({ rows, ticker, vault, vrp }: Props) {
  const name = VAULT_NAME[vault];
  const chart = (
    <div className={styles.panels} data-cols="2">
      {METRICS.map((m) => (
        <DeltaPanel key={m.key} metric={m} rows={rows} name={name} ticker={ticker} />
      ))}
    </div>
  );

  const table = (
    <table className={styles.table}>
      <caption className="sr-only">
        {ticker} {name.toLowerCase()} vault by target delta, VRP {vrp}, with buy-and-hold
      </caption>
      <thead>
        <tr>
          <th scope="col">Target delta</th>
          <th scope="col" className={styles.num}>
            CAGR
          </th>
          <th scope="col" className={styles.num}>
            Sharpe
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.delta}>
            <td>
              {r.delta.toFixed(2)}
              {r.delta === SERIES_DELTA ? <span className={styles.cellSub}>charts above</span> : null}
            </td>
            <td className={styles.num}>{pct(r.cagr, 1)}</td>
            <td className={styles.num}>{num(r.sharpe, 2)}</td>
          </tr>
        ))}
        <tr>
          <td>Buy-and-hold {ticker}</td>
          <td className={styles.num}>{pct(rows[0].bhCagr, 1)}</td>
          <td className={styles.num}>{num(rows[0].bhSharpe, 2)}</td>
        </tr>
      </tbody>
    </table>
  );

  return (
    <ChartFrame
      id="bt-delta"
      title={`By target delta · VRP ${vrp}`}
      legend={[
        { key: "vault", label: `${name} vault`, shape: "line" },
        { key: "bh", label: `Buy-and-hold ${ticker}`, shape: "line" },
      ]}
      chart={chart}
      table={table}
      caption={
        <>
          From research/results/grid.csv at premiumBps 1.00, premium held. The grid ran 0.10, 0.20 and 0.30
          delta; only 0.20 has a week-by-week series, so the charts above use 0.20.
        </>
      }
    />
  );
}

function DeltaPanel({
  metric,
  rows,
  name,
  ticker,
}: {
  metric: Metric;
  rows: GridRow[];
  name: string;
  ticker: string;
}) {
  const [wrap, width] = useWidth(320);
  const center = rows.findIndex((r) => r.delta === SERIES_DELTA);
  const { active, setActive, bind } = useActive(rows.length, Math.max(0, center));
  const M = { top: 22, right: 18, bottom: 34, left: 44 };
  const w = width - M.left - M.right;
  const h = HEIGHT - M.top - M.bottom;
  const vals = rows.map(metric.vault);
  const bh = metric.bh(rows[0]);
  const span0 = Math.max(0, ...vals, bh) - Math.min(0, ...vals, bh) || 1;
  // Headroom above and below so dot labels never meet the frame.
  const lo0 = Math.min(0, Math.min(...vals, bh) - span0 * 0.12);
  const hi0 = Math.max(0, ...vals, bh) + span0 * 0.14;
  const yt = ticks(lo0, hi0, 4);
  const lo = Math.min(lo0, yt[0]);
  const hi = Math.max(hi0, yt[yt.length - 1]);
  const slot = w / rows.length;
  const x = (i: number) => M.left + slot * (i + 0.5);
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo || 1)) * h;
  const path = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.floor((px - M.left) / slot);
    setActive(i >= 0 && i < rows.length ? i : null);
  }

  const hr = active === null ? null : rows[active];
  const tipText = hr
    ? `${metric.title} at delta ${hr.delta.toFixed(2)}: ${name} vault ${metric.fmt(metric.vault(hr))}, buy-and-hold ${metric.fmt(bh)}`
    : "";
  // A dot's value sits above it, unless the buy-and-hold line (or the frame) is just above: then below.
  const labelBelow = (v: number) => {
    const d = y(v) - y(bh);
    return (d > 0 && d < 24) || y(v) - M.top < 18;
  };

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{metric.title}</span>
        <span className={styles.panelSub}>
          Buy-and-hold {ticker}: {metric.fmt(bh)}
        </span>
      </div>
      <div ref={wrap} className={styles.plot}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-label={`${metric.title} by target delta: ${rows.map((r) => `${r.delta.toFixed(2)} → ${metric.fmt(metric.vault(r))}`).join(", ")}; buy-and-hold ${metric.fmt(bh)}.`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          {...bind}
          className={styles.svg}
        >
          {yt.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={M.left + w}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? styles.base : styles.grid}
              />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={styles.tick}>
                {metric.tick(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => (
            <text
              key={r.delta}
              x={x(i)}
              y={M.top + h + 20}
              textAnchor="middle"
              className={r.delta === SERIES_DELTA ? styles.tickStrong : styles.tick}
            >
              Δ {r.delta.toFixed(2)}
            </text>
          ))}

          <line x1={M.left} x2={M.left + w} y1={y(bh)} y2={y(bh)} className={styles.line} data-series="bh" />

          <path d={path} className={styles.line} data-series="vault" />
          {vals.map((v, i) => (
            <g key={rows[i].delta}>
              <circle
                cx={x(i)}
                cy={y(v)}
                r={active === i ? 6 : 4}
                className={styles.dot}
                data-series="vault"
              />
              <text
                x={x(i)}
                y={y(v) + (labelBelow(v) ? 20 : -12)}
                textAnchor="middle"
                className={styles.valueLabel}
              >
                {metric.fmt(v)}
              </text>
            </g>
          ))}
          {hr && active !== null ? (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={M.top}
              y2={M.top + h}
              className={styles.crosshair}
              aria-hidden
            />
          ) : null}
        </svg>
        {hr && active !== null ? (
          <Tip
            x={x(active)}
            width={width}
            top={M.top + h - 60}
            heading={`Target delta ${hr.delta.toFixed(2)}`}
            rows={[
              { key: "vault", label: "Vault", value: metric.fmt(metric.vault(hr)) },
              { key: "bh", label: "Buy-and-hold", value: metric.fmt(bh) },
            ]}
          />
        ) : null}
        <Live text={tipText} />
      </div>
    </div>
  );
}
