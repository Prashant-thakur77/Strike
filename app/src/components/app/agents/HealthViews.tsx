"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { useAgentLog, useAllVaults, useMarket, useRegistries } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { fmtLogDate } from "@/lib/agentLog";
import {
  HEALTH_LABEL,
  NO_TRADE_LABEL,
  healthAlerts,
  noTradeCounts,
  noTrades,
  rankStanding,
  sampleVerdict,
  seriesHealth,
  type AgentStanding,
  type NoTradeKind,
  type SeriesHealth,
} from "@/lib/agentHealth";
import { decisionPath, isRecordName } from "@/lib/decision";
import { fmtDuration, toNumber } from "@/lib/format";
import type { VaultSummary } from "@/lib/reads";
import { Skeleton } from "../Skeleton";
import styles from "../app.module.css";
import h from "./health.module.css";

const TELEGRAM_BOT = "https://t.me/strike_options_bot";

const usd = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedPct = (x: number) => `${x < 0 ? "−" : "+"}${Math.abs(x * 100).toFixed(1)}%`;

/** The chain's clock when the market read has it, else the browser's (both in seconds). */
function useNow(): number | null {
  const market = useMarket().data;
  return market?.now ?? null;
}

function healthOf(v: VaultSummary, now: number): SeriesHealth | null {
  const s = v.series;
  if (!s || s.settled || s.cancelled || v.spot.price <= 0n) return null;
  const dec = v.underlying.decimals;
  return seriesHealth({
    vault: v.address,
    symbol: v.version ? `${v.symbol} (${v.version})` : v.symbol,
    underlying: v.underlying.symbol,
    isCall: s.isCall,
    agentId: Number(s.agentId),
    strike: toNumber(s.strike, 18),
    spot: toNumber(v.spot.price, 18),
    spotUpdatedAt: Number(v.spot.updatedAt),
    feedStatus: v.spot.status,
    expiry: Number(s.expiry),
    now,
    sold: toNumber(s.sold, dec),
    premium: toNumber(s.premium, v.usdg.decimals),
    sigma: v.pricing ? toNumber(v.pricing.sigma, 18) : null,
    settled: s.settled,
    cancelled: s.cancelled,
  });
}

/* ================================================================ live series health and alerts */

export function LiveHealth() {
  const vaults = useAllVaults();
  const regs = useRegistries();
  const now = useNow();
  const { chainId } = useStrike();
  if (vaults.isPending || now === null) {
    return (
      <div aria-busy="true" data-testid="health-loading">
        <Skeleton width="70%" />
        <span className="sr-only">Reading the live series from the chain</span>
      </div>
    );
  }
  if (vaults.isError) {
    return (
      <p className={styles.hint} data-testid="health-error">
        The vaults could not be read from the chain right now. Each vault&apos;s page shows its series once
        the RPC answers.
      </p>
    );
  }
  const list = (vaults.data ?? []).flatMap((v) => {
    const x = healthOf(v.summary, now);
    return x ? [x] : [];
  });
  const agents: AgentStanding[] = (regs.data ?? []).flatMap((r) =>
    r.registry.agents.map((a) => ({
      id: Number(a.id),
      label: `Agent ${a.id}${r.version ? ` (${r.version})` : ""}`,
      status: a.status,
      strikes: a.strikes,
      maxStrikes: r.registry.maxStrikes,
      accepted: a.accepted,
      rejected: a.rejected,
      settledEpochs: a.settledEpochs,
      pnl: toNumber(a.cumulativePnl, r.registry.usdg.decimals),
    })),
  );
  const alerts = healthAlerts(list, agents);
  return (
    <div className={h.stack} data-testid="health">
      {list.length === 0 ? (
        <p className={styles.hint} data-testid="health-empty">
          No live series right now: no vault has an option on sale or waiting to settle. The next epochs open
          during US market hours.
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table} aria-label="Live series health">
            <thead>
              <tr>
                <th scope="col">Series</th>
                <th scope="col">State</th>
                <th scope="col" className={styles.num}>
                  Strike
                </th>
                <th scope="col" className={styles.num}>
                  Spot
                </th>
                <th scope="col" className={styles.num}>
                  Cushion to strike
                </th>
                <th scope="col" className={styles.num}>
                  Break-even
                </th>
                <th scope="col" className={styles.num}>
                  Time left
                </th>
                <th scope="col" className={styles.num}>
                  Model odds
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((x) => (
                <HealthRow key={x.input.vault} x={x} chainId={chainId} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.hint}>
        Spot is the price feed the contracts read (the mirrored mainnet Chainlink round); cushion is how far
        it can move against the series before the strike; break-even is the strike less the premium buyers
        paid per option. The odds are the Black-Scholes model&apos;s at the volatility the EpochManager prices
        with, not a forecast. Read from the chain every time the page refreshes.
      </p>
      <div className={h.alerts} data-testid="alerts" data-count={alerts.length}>
        <h3 className="micro micro-muted">Alerts</h3>
        {alerts.length === 0 ? (
          <p className={styles.hint} data-testid="alerts-empty">
            None: {list.length > 0 ? "every live series is out of the money and its feed is fresh, and " : ""}
            no agent is one strike from suspension.
          </p>
        ) : (
          <ul className={h.alertList}>
            {alerts.map((a, i) => (
              <li key={i} className={h.alert} data-level={a.level} data-testid="alert">
                <span className={h.level}>{a.level}</span>
                <strong>
                  {a.vault ? (
                    <Link href={`/app/vault/${a.vault}?chain=${chainId}`} className="text-link">
                      {a.symbol}
                    </Link>
                  ) : (
                    a.symbol
                  )}
                </strong>{" "}
                {a.text}
              </li>
            ))}
          </ul>
        )}
        <p className={styles.hint}>
          The contract&apos;s own events (a series proposed, a proposal rejected, options bought, an epoch
          settled) are pushed to Telegram by{" "}
          <a href={TELEGRAM_BOT} target="_blank" rel="noreferrer" className="text-link">
            @strike_options_bot <ArrowUpRight size={11} aria-hidden />
          </a>{" "}
          (send <code className="mono">/subscribe</code>). The alerts above are the states between those
          events, worked out here from the same reads.
        </p>
      </div>
    </div>
  );
}

function HealthRow({ x, chainId }: { x: SeriesHealth; chainId: number }) {
  const s = x.input;
  return (
    <tr data-testid="health-row" data-state={x.state}>
      <th scope="row">
        <Link href={`/app/vault/${s.vault}?chain=${chainId}`} className="text-link">
          {s.symbol}
        </Link>
        <span className={styles.cellMuted}>
          {s.isCall ? "call" : "put"} · agent #{s.agentId}
        </span>
      </th>
      <td>
        <span className={h.state} data-state={x.state}>
          {HEALTH_LABEL[x.state]}
        </span>
      </td>
      <td className={`mono ${styles.num}`}>{usd(s.strike)}</td>
      <td className={`mono ${styles.num}`}>
        {usd(s.spot)}
        <span className={styles.cellMuted}>
          {x.feedStale ? "stale · " : ""}
          {fmtDuration(Math.max(0, x.feedAge))} old
        </span>
      </td>
      <td className={`mono ${styles.num}`} data-sign={x.cushion >= 0 ? "gain" : "loss"}>
        {signedPct(x.cushion)}
      </td>
      <td className={`mono ${styles.num}`}>
        {x.breakEven === null ? (
          <span className={styles.cellMuted}>none sold</span>
        ) : (
          <>
            {usd(x.breakEven)}
            <span className={styles.cellMuted}>{signedPct(x.breakEvenCushion!)} away</span>
          </>
        )}
      </td>
      <td className={`mono ${styles.num}`}>{x.left > 0 ? fmtDuration(x.left) : "expired"}</td>
      <td className={`mono ${styles.num}`}>
        {x.oddsItm === null ? (
          <span className={styles.cellMuted}>{x.left > 0 ? "no volatility read" : "past expiry"}</span>
        ) : (
          `${(x.oddsItm * 100).toFixed(1)}%`
        )}
      </td>
    </tr>
  );
}

/* ================================================================ performance */

export function Performance() {
  const regs = useRegistries();
  if (regs.isPending) return <Skeleton width="60%" />;
  if (regs.isError || !regs.data) {
    return <p className={styles.hint}>The agent registries could not be read from the chain right now.</p>;
  }
  const rows: AgentStanding[] = regs.data
    .flatMap((r) =>
      r.registry.agents.map((a) => ({
        id: Number(a.id),
        label: `Agent ${a.id}${regs.data.length > 1 && r.version ? ` (${r.version})` : ""}`,
        status: a.status,
        strikes: a.strikes,
        maxStrikes: r.registry.maxStrikes,
        accepted: a.accepted,
        rejected: a.rejected,
        settledEpochs: a.settledEpochs,
        pnl: toNumber(a.cumulativePnl, r.registry.usdg.decimals),
      })),
    )
    .sort(rankStanding);
  const settled = rows.reduce((n, a) => n + a.settledEpochs, 0);
  const overall = sampleVerdict(settled);
  return (
    <div className={h.stack} data-testid="performance" data-settled={settled}>
      <p className={h.verdict} data-level={overall.level} data-testid="performance-verdict">
        {overall.text}
        {settled === 0
          ? " The first settlements land at the first mainnet price print after each series' expiry; until then every figure below is the on-chain zero, not a placeholder."
          : ""}
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label="Agent performance">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col" className={styles.num}>
                Settled epochs
              </th>
              <th scope="col" className={styles.num}>
                Depositor PnL
              </th>
              <th scope="col" className={styles.num}>
                Accepted / sent
              </th>
              <th scope="col">What the sample says</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const sent = a.accepted + a.rejected;
              return (
                <tr key={a.label} data-testid="performance-row">
                  <th scope="row">{a.label}</th>
                  <td className={`mono ${styles.num}`}>{a.settledEpochs}</td>
                  <td
                    className={`mono ${styles.num}`}
                    data-sign={a.pnl > 0 ? "gain" : a.pnl < 0 ? "loss" : undefined}
                  >
                    {a.pnl > 0 ? "+" : a.pnl < 0 ? "−" : ""}
                    {Math.abs(a.pnl).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDG
                  </td>
                  <td className={`mono ${styles.num}`}>
                    {sent === 0 ? (
                      <span className={styles.cellMuted}>none sent</span>
                    ) : (
                      `${a.accepted} / ${sent}`
                    )}
                  </td>
                  <td>{sampleVerdict(a.settledEpochs).text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.hint}>
        Settled epochs and PnL are <code className="mono">AgentRegistry.track(agentId)</code>: the contract
        adds each epoch&apos;s premium minus payout for depositors, before fees, when the series settles.
        Nobody can type these numbers in. Each epoch&apos;s own result is in its vault&apos;s settled-epochs
        table.
      </p>
    </div>
  );
}

/* ================================================================ decisions that sold nothing */

const KINDS: NoTradeKind[] = ["rejected", "not-sent", "skipped", "failed"];

export function NoTradeHistory() {
  const q = useAgentLog();
  const [showSettle, setShowSettle] = useState(false);
  if (q.isPending) return <Skeleton width="60%" />;
  if (q.isError) {
    return (
      <p className={styles.hint} data-testid="notrade-error">
        The decision records could not be read from GitHub right now; the decision log above says why.
      </p>
    );
  }
  const list = noTrades(q.data.entries);
  const counts = noTradeCounts(list);
  // Proposal-time runs are the decisions; settle runs that waited or had nothing to do sit behind a toggle.
  const proposals = list.filter((n) => n.entry.record.action !== "settle");
  const settles = list.filter((n) => n.entry.record.action === "settle");
  const shown = showSettle ? list : proposals;
  return (
    <div className={h.stack} data-testid="notrade" data-count={list.length} data-shown={shown.length}>
      <dl className={h.counts}>
        {KINDS.map((k) => (
          <div key={k} data-testid={`notrade-count-${k}`}>
            <dt className="micro micro-muted">{NO_TRADE_LABEL[k]}</dt>
            <dd className="mono">{counts[k]}</dd>
          </div>
        ))}
      </dl>
      {list.length === 0 ? (
        <p className={styles.hint}>Every record in the log sold something.</p>
      ) : (
        <ol className={h.noTradeList} aria-label="Runs that sold nothing, newest first">
          {shown.map((n) => {
            const r = n.entry.record;
            return (
              <li key={n.entry.name} data-testid="notrade-row" data-kind={n.kind}>
                <span className={h.kind} data-kind={n.kind}>
                  {NO_TRADE_LABEL[n.kind]}
                </span>
                <span className="micro micro-muted">
                  {fmtLogDate(r.date)} · {r.vault.symbol} · {r.action}
                </span>
                <span>{n.why}</span>
                <span className={h.links}>
                  {r.decision && isRecordName(n.entry.name) ? (
                    <Link href={decisionPath(r.chain.id, n.entry.name)} className="text-link">
                      Open the decision
                    </Link>
                  ) : null}
                  <a href={n.entry.recordUrl} target="_blank" rel="noreferrer" className="text-link">
                    Record <ArrowUpRight size={11} aria-hidden />
                  </a>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {settles.length > 0 ? (
        <button
          type="button"
          className={`text-link ${h.toggle}`}
          aria-expanded={showSettle}
          onClick={() => setShowSettle((x) => !x)}
          data-testid="notrade-settle-toggle"
        >
          {showSettle
            ? "Show proposal runs only"
            : `Also show ${settles.length} settle run${settles.length === 1 ? "" : "s"} that waited or had nothing to settle`}
        </button>
      ) : null}
      <p className={styles.hint}>
        A run that sells nothing is a decision too: the contract rejected the proposal, the agent found no
        compliant strike and did not send, there was nothing to settle, or the run stopped and said why. Each
        is a committed record, most of them anchored on-chain. Robinhood Chain testnet records, the newest{" "}
        {q.data.entries.length}.
      </p>
    </div>
  );
}
