"use client";

import { ArrowUpRight } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  deltaRows,
  equitySeries,
  fmtDate,
  gridRow,
  META,
  num,
  PERIODS,
  pct,
  pctOf,
  premiumSeries,
  SERIES_DELTA,
  SOURCES,
  stressRow,
  TICKERS,
  times,
  VAULT_NAME,
  VAULTS,
  VRPS,
  type GridRow,
  type Selection,
} from "@/lib/backtest";
import { PageHero } from "../PageHero";
import { Rail } from "../Rail";
import { DeltaChart } from "./DeltaChart";
import { EquityChart } from "./EquityChart";
import { PremiumHistogram } from "./PremiumHistogram";
import { StressChart } from "./StressChart";
import { Term } from "@/components/ui/Term";
import styles from "./backtest.module.css";

const MONTH_YEAR = (iso: string) => fmtDate(iso).split(" ").slice(1).join(" ");

export function BacktestPage() {
  const [sel, setSel] = useState<Selection>({ ticker: "TSLA", vault: "call", vrp: "1.15" });
  const g = gridRow(sel);
  const points = useMemo(() => equitySeries(sel), [sel]);
  const premium = useMemo(() => premiumSeries(sel), [sel]);
  const stress = stressRow(sel);
  const deltas = deltaRows(sel);
  const last = points[points.length - 1];
  const name = VAULT_NAME[sel.vault];

  return (
    <div className={styles.root}>
      <PageHero
        index="03"
        label="Backtest"
        right={`${META.weeks} weeks · ${MONTH_YEAR(META.start)} – ${MONTH_YEAR(META.end)}`}
        title={<span className={styles.title}>Backtest</span>}
        lead={
          <>
            <p className="lead">
              What a depositor would have earned in Strike&apos;s weekly vaults on TSLA, NVDA, AMZN and SPY,
              week by week from January 2019, next to simply holding the stock.
            </p>
            <p className={styles.leadNote}>
              A simulation on daily adjusted closes that follows the contract rules, not a track record. It
              assumes every option sells at the model price; see the <a href="#bt-caveats">caveats</a>.
            </p>
          </>
        }
      />

      <Controls sel={sel} onChange={setSel} />

      <Headline g={g} ticker={sel.ticker} />

      <div className={styles.body}>
        <Rail
          index="01"
          label="Equity curve"
          note={
            <>
              {sel.ticker} {name.toLowerCase()} ended at <strong>{times(last.vault)}</strong> the money
              deposited, against <strong>{times(last.bh)}</strong> for holding {sel.ticker}.
            </>
          }
        >
          <EquityChart points={points} vault={sel.vault} ticker={sel.ticker} />
        </Rail>

        <Rail
          index="02"
          label="Weekly premium"
          note={
            <>
              An average of <strong>{pct(g.avgPremium, 2)}</strong> of collateral a week; {pct(g.assigned, 1)}{" "}
              of weeks finished in the money.
            </>
          }
        >
          <PremiumHistogram
            values={premium}
            average={g.avgPremium * 100}
            ticker={sel.ticker}
            vault={sel.vault}
          />
        </Rail>

        <Rail
          index="03"
          label="Stress periods"
          note={
            <>
              In the 2020 crash the vault returned <strong>{pctOf(stress.crash[0], 1, true)}</strong>; holding{" "}
              {sel.ticker} returned {pctOf(stress.crash[1], 1, true)}.
            </>
          }
        >
          <StressChart row={stress} periods={PERIODS} ticker={sel.ticker} vault={sel.vault} />
        </Rail>

        <Rail
          index="04"
          label="Delta sensitivity"
          note={
            sel.vault === "call"
              ? "Calls: a lower delta did better on every ticker. Over a period in which all four stocks rose strongly, the less upside the vault gave away, the better. A property of this sample, not a rule."
              : "Puts: a higher delta did better. More premium per week outweighed more frequent assignment, especially at VRP 1.15."
          }
        >
          <DeltaChart rows={deltas} ticker={sel.ticker} vault={sel.vault} vrp={sel.vrp} />
        </Rail>

        <Rail
          index="05"
          id="bt-caveats"
          label="Caveats"
          note="From docs/backtest.md, Assumptions and Limitations."
        >
          <Caveats />
        </Rail>
      </div>
    </div>
  );
}

function Controls({ sel, onChange }: { sel: Selection; onChange: (s: Selection) => void }) {
  return (
    <section className={`gutter ${styles.controls}`} aria-label="Backtest settings">
      <div className={styles.controlRow}>
        <Group label="Stock">
          {TICKERS.map((t) => (
            <button
              key={t}
              type="button"
              className="chip"
              aria-pressed={sel.ticker === t}
              onClick={() => onChange({ ...sel, ticker: t })}
            >
              {t}
            </button>
          ))}
        </Group>
        <Group label="Vault">
          {VAULTS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip"
              aria-pressed={sel.vault === v}
              onClick={() => onChange({ ...sel, vault: v })}
            >
              {VAULT_NAME[v]}
            </button>
          ))}
        </Group>
        <Group label="Implied volatility">
          {VRPS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip"
              aria-pressed={sel.vrp === v}
              aria-label={`Realised volatility × ${v}`}
              onClick={() => onChange({ ...sel, vrp: v })}
            >
              Realised × {v}
            </button>
          ))}
        </Group>
      </div>
      <p className={styles.controlNote}>
        The protocol prices with a keeper-set volatility; the backtest stands in trailing 21-day realised
        volatility × 1.00 (no premium) or × 1.15 (15% above). Neither is market-implied. Target delta{" "}
        {SERIES_DELTA.toFixed(2)}, premium at fair value, premium held.
      </p>
    </section>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = `bt-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className={styles.group} role="group" aria-labelledby={id}>
      <span id={id} className="micro micro-muted">
        {label === "Implied volatility" ? <Term id="impliedVol">{label}</Term> : label}
      </span>
      <div className={styles.chips}>{children}</div>
    </div>
  );
}

function Headline({ g, ticker }: { g: GridRow; ticker: string }) {
  const cells: { key: string; label: string; value: string; sub: string }[] = [
    {
      key: "cagr",
      label: "Annual return (CAGR)",
      value: pct(g.cagr, 1),
      sub: `Buy-and-hold ${pct(g.bhCagr, 1)}`,
    },
    { key: "vol", label: "Volatility", value: pct(g.vol, 1), sub: `Buy-and-hold ${pct(g.bhVol, 1)}` },
    {
      key: "sharpe",
      label: "Sharpe ratio",
      value: num(g.sharpe, 2),
      sub: `Buy-and-hold ${num(g.bhSharpe, 2)}`,
    },
    { key: "maxdd", label: "Max drawdown", value: pct(g.maxDd, 1), sub: `Buy-and-hold ${pct(g.bhMaxDd, 1)}` },
    {
      key: "premium",
      label: "Avg weekly premium",
      value: pct(g.avgPremium, 2),
      sub: "Per option, of collateral",
    },
    {
      key: "assigned",
      label: "Weeks assigned",
      value: pct(g.assigned, 1),
      sub: `Finished in the money, of ${g.weeks}`,
    },
  ];
  return (
    <section className={`gutter ${styles.headline}`} aria-label={`Headline figures, ${ticker}`}>
      <dl className={styles.stats}>
        {cells.map((c) => (
          <div key={c.key} className={styles.stat} data-metric={c.key}>
            <dt className="micro micro-muted">{c.label}</dt>
            <dd className={styles.statValue}>{c.value}</dd>
            <dd className={styles.statSub}>{c.sub}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.statNote}>
        Volatility and Sharpe use weekly returns × √52 at a 0% risk-free rate; drawdown is measured at weekly
        closes.
      </p>
    </section>
  );
}

function Caveats() {
  return (
    <div className={styles.caveats} role="note" aria-label="Backtest caveats">
      <ul>
        <li>
          <strong>The implied volatility is modelled.</strong> Every option is priced with trailing 21-day
          realised volatility × 1.00 or × 1.15, not market-implied volatility, so it misses skew, term
          structure and earnings spikes. For SPY the VIX ran about 30% above trailing realised volatility; the
          data says nothing about the ratio for TSLA, NVDA or AMZN. The two factors bracket a range; they do
          not estimate it.
        </li>
        <li>
          <strong>Full fills are assumed.</strong> The vault sells its full 80% of capacity every week at
          Monday&apos;s closing model price. On-chain, options sell only if buyers want them at the
          oracle-anchored price, and unsold size earns nothing. Demand is the largest gap in this backtest.
        </li>
        <li>
          <strong>Covered calls trail buy-and-hold in return but cut volatility.</strong> At 0.20 delta the
          covered-call vault lagged buy-and-hold on every ticker, with 25–46% less volatility and a smaller
          maximum drawdown. Its Sharpe ratio was below buy-and-hold&apos;s in every base case.
        </li>
        <li>
          <strong>One period, no costs.</strong> 2019–2026 was an unusually strong market for all four stocks,
          the kind in which covered calls look worst. USDG earns no interest here; gas, keeper costs and claim
          delays are ignored. The stock tokens did not exist before 2026, so this is the strategy run on the
          underlying stocks&apos; adjusted closes.
        </li>
      </ul>
      <div className={styles.sources}>
        <a className="text-link" href={SOURCES.doc} target="_blank" rel="noreferrer">
          Method and caveats · docs/backtest.md <ArrowUpRight aria-hidden />
        </a>
        <a className="text-link" href={SOURCES.script} target="_blank" rel="noreferrer">
          Simulation · research/backtest.py <ArrowUpRight aria-hidden />
        </a>
      </div>
    </div>
  );
}
