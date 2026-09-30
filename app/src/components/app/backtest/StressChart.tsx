"use client";

import {
  fmtDate,
  fmtDayMonth,
  pctOf,
  VAULT_NAME,
  type Period,
  type StressRow,
  type Vault,
} from "@/lib/backtest";
import { ChartFrame, Live, Tip, useActive, useWidth, type SeriesKey } from "./ChartFrame";
import styles from "./backtest.module.css";

const KEYS = ["crash", "rebound", "bear"] as const;
const BAR = 20;
const ROW = 58;
const TOP = 6;

interface Props {
  row: StressRow;
  periods: Period[];
  ticker: string;
  vault: Vault;
}

const periodRange = (p: Period) =>
  p.from.slice(0, 4) === p.to.slice(0, 4)
    ? `${fmtDayMonth(p.from)} – ${fmtDate(p.to)}`
    : `${fmtDate(p.from)} – ${fmtDate(p.to)}`;

/** Vault vs buy-and-hold return over three stress windows; one small panel per window, each on its own scale. */
export function StressChart({ row, periods, ticker, vault }: Props) {
  const name = VAULT_NAME[vault];
  const chart = (
    <div className={styles.panels}>
      {KEYS.map((k, i) => (
        <StressPanel key={k} period={periods[i]} values={row[k]} name={name} ticker={ticker} />
      ))}
    </div>
  );

  const table = (
    <table className={styles.table}>
      <caption className="sr-only">
        Return over each stress window: {ticker} {name.toLowerCase()} vault and buy-and-hold
      </caption>
      <thead>
        <tr>
          <th scope="col">Window</th>
          <th scope="col" className={styles.num}>
            Vault
          </th>
          <th scope="col" className={styles.num}>
            Buy-and-hold
          </th>
        </tr>
      </thead>
      <tbody>
        {KEYS.map((k, i) => (
          <tr key={k}>
            <td>
              {periods[i].label}
              <span className={styles.cellSub}>{periodRange(periods[i])}</span>
            </td>
            <td className={styles.num}>{pctOf(row[k][0], 1, true)}</td>
            <td className={styles.num}>{pctOf(row[k][1], 1, true)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFrame
      id="bt-stress"
      title={`Stress windows · ${ticker} ${name.toLowerCase()}`}
      legend={[
        { key: "vault", label: `${name} vault`, shape: "bar" },
        { key: "bh", label: `Buy-and-hold ${ticker}`, shape: "bar" },
      ]}
      chart={chart}
      table={table}
      caption={
        <>
          Return between weekly settlement closes, as printed in research/results/tables.md. Each window has
          its own scale: the 2020 rebound moves are several times the size of the falls.
        </>
      }
    />
  );
}

function StressPanel({
  period,
  values,
  name,
  ticker,
}: {
  period: Period;
  values: [number, number];
  name: string;
  ticker: string;
}) {
  const [wrap, width] = useWidth(300);
  const { active, setActive, bind } = useActive(2, 0);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const padL = lo < 0 ? 64 : 4;
  const padR = hi > 0 ? 64 : 4;
  const w = width - padL - padR;
  const x = (v: number) => padL + ((v - lo) / (hi - lo || 1)) * w;
  const height = TOP + ROW * 2 + 4;
  const rows: { key: SeriesKey; label: string; v: number }[] = [
    { key: "vault", label: `${name} vault`, v: values[0] },
    { key: "bh", label: `Buy-and-hold ${ticker}`, v: values[1] },
  ];
  const diff = values[0] - values[1];
  const note = `Vault ${diff >= 0 ? "ahead by" : "behind by"} ${Math.abs(diff).toFixed(1)} pts`;
  const tipText =
    active === null
      ? ""
      : `${period.label}: ${name} vault ${pctOf(values[0], 1, true)}, buy-and-hold ${pctOf(values[1], 1, true)}`;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{period.label}</span>
        <span className={styles.panelSub}>{periodRange(period)}</span>
      </div>
      <div ref={wrap} className={styles.plot}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${period.label}, ${periodRange(period)}: ${name} vault ${pctOf(values[0], 1, true)}, buy-and-hold ${pctOf(values[1], 1, true)}.`}
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const py = ((e.clientY - box.top) / box.height) * height;
            const i = Math.floor((py - TOP) / ROW);
            setActive(i >= 0 && i < 2 ? i : null);
          }}
          {...bind}
          className={styles.svg}
        >
          {rows.map((r, i) => {
            const y0 = TOP + ROW * i;
            const by = y0 + 22;
            const x0 = Math.min(x(0), x(r.v));
            const len = Math.max(1, Math.abs(x(r.v) - x(0)));
            const neg = r.v < 0;
            const rad = Math.min(4, len);
            // Rounded at the data end, square at the zero baseline.
            const d = neg
              ? `M${x(0)},${by}V${by + BAR}H${x0 + rad}Q${x0},${by + BAR} ${x0},${by + BAR - rad}V${by + rad}Q${x0},${by} ${x0 + rad},${by}Z`
              : `M${x(0)},${by}H${x0 + len - rad}Q${x0 + len},${by} ${x0 + len},${by + rad}V${by + BAR - rad}Q${x0 + len},${by + BAR} ${x0 + len - rad},${by + BAR}H${x(0)}Z`;
            return (
              <g key={r.key} className={styles.col} data-active={active === i || undefined}>
                <rect x={0} y={y0} width={width} height={ROW} className={styles.hit} />
                <text
                  x={x(0) + (neg ? -2 : 2)}
                  y={y0 + 14}
                  textAnchor={neg ? "end" : "start"}
                  className={styles.rowLabel}
                >
                  {r.key === "vault" ? "Vault" : "Buy-and-hold"}
                </text>
                <path d={d} data-series={r.key} />
                <text
                  x={neg ? x0 - 6 : x0 + len + 6}
                  y={by + BAR / 2}
                  dy="0.34em"
                  textAnchor={neg ? "end" : "start"}
                  className={styles.valueLabel}
                >
                  {pctOf(r.v, 1, true)}
                </text>
              </g>
            );
          })}
          <line x1={x(0)} x2={x(0)} y1={TOP + 16} y2={height} className={styles.axis} />
        </svg>
        {active !== null ? (
          <Tip
            x={width / 2}
            width={width}
            top={active === 0 ? TOP + ROW : TOP}
            heading={period.label}
            rows={rows.map((r) => ({
              key: r.key,
              label: r.key === "vault" ? "Vault" : "Buy-and-hold",
              value: pctOf(r.v, 1, true),
            }))}
            note={note}
          />
        ) : null}
        <Live text={tipText} />
      </div>
    </div>
  );
}
