"use client";

import { fmtAmount, fmtNy, fmtWadUsd } from "@/lib/format";
import type { EpochEvents, VaultHistory, VaultSummary } from "@/lib/reads";
import { Skeleton } from "../Skeleton";
import styles from "../app.module.css";

interface Step {
  name: string;
  time?: number | bigint;
  note?: string;
  done: boolean;
}

function steps(vault: VaultSummary, cur: EpochEvents | undefined, prev: EpochEvents | undefined): Step[] {
  const settled = cur?.settledAt ?? cur?.abortedAt;
  return [
    { name: "Idle", time: prev?.settledAt ?? prev?.abortedAt, note: "Unlocked", done: true },
    { name: "Open", time: cur?.openedAt, note: "Vault locked", done: !!cur?.openedAt },
    {
      name: "Selling",
      time: cur?.proposedAt,
      note: cur?.rejections
        ? `${cur.rejections} proposal${cur.rejections > 1 ? "s" : ""} rejected first`
        : "Series accepted",
      done: !!cur?.proposedAt,
    },
    {
      name: cur?.abortedAt ? "Aborted" : "Settled",
      time: settled ?? (vault.series ? vault.series.expiry : undefined),
      note: settled ? "Vault unlocked" : vault.series ? "Expiry" : undefined,
      done: !!settled,
    },
  ];
}

export function Timeline({ vault, history }: { vault: VaultSummary; history: VaultHistory | undefined }) {
  if (!history) return <Skeleton width="60%" />;
  if (vault.currentEpoch === 0n) {
    return <p className="body">No epoch has run yet. The first one opens during US market hours.</p>;
  }
  const cur = history.epochs.find((e) => e.epoch === vault.currentEpoch);
  const prev = history.epochs.find((e) => e.epoch === vault.currentEpoch - 1n);
  const list = steps(vault, cur, prev);
  const active = list.findIndex((s) => !s.done);
  const progress = active === -1 ? 1 : Math.max(0, active - 0.5) / (list.length - 1);
  const past = history.epochs.filter((e) => e.settledAt !== undefined).reverse();

  return (
    <div className={styles.panel}>
      <p className="micro micro-muted">Epoch {vault.currentEpoch.toString()}</p>
      <ol className={styles.timeline} style={{ ["--progress" as string]: progress }}>
        {list.map((s, i) => (
          <li key={s.name} data-done={s.done} data-active={i === active}>
            <span className={styles.tlDot} aria-hidden />
            <span className="index">{String(i + 1).padStart(2, "0")}</span>
            <strong className="h3">{s.name}</strong>
            <span className={styles.tlTime}>{s.time ? fmtNy(s.time) : "—"}</span>
            {s.note ? (
              <span className="micro micro-muted">{s.done || i === active ? s.note : "Next"}</span>
            ) : null}
          </li>
        ))}
      </ol>
      {past.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="micro micro-muted">Settled epochs</caption>
            <thead>
              <tr>
                <th scope="col">Epoch</th>
                <th scope="col">Strike</th>
                <th scope="col">Settled at</th>
                <th scope="col">Premium to vault</th>
                <th scope="col">Paid to buyers</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {past.map((e) => {
                const itm =
                  e.strike !== undefined &&
                  !!e.settlementPrice &&
                  (vault.isCall ? e.settlementPrice > e.strike : e.settlementPrice < e.strike);
                return (
                  <tr key={e.epoch.toString()}>
                    <td className="mono">{e.epoch.toString()}</td>
                    <td className="mono">{e.strike ? fmtWadUsd(e.strike, 0) : "—"}</td>
                    <td className="mono">{e.settlementPrice ? fmtWadUsd(e.settlementPrice) : "—"}</td>
                    <td className="mono">
                      {fmtAmount((e.premium ?? 0n) - (e.fee ?? 0n), vault.usdg.decimals)} USDG
                    </td>
                    <td className="mono">
                      {fmtAmount(e.payout ?? 0n, vault.asset.decimals, 4)} {vault.asset.symbol}
                    </td>
                    <td>
                      <span className={styles.result} data-itm={itm}>
                        {itm ? "In the money" : "Expired worthless"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
