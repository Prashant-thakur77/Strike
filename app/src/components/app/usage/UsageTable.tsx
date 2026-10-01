"use client";

import Link from "next/link";
import { ArrowUpRight, RotateCw } from "lucide-react";
import { errorMessage } from "@/hooks/useTx";
import { shortAddr } from "@/lib/format";
import {
  agoText,
  fmtCount,
  fmtOptions,
  fmtUsd,
  fmtUsdg,
  type DeploymentUsage,
  type UsageContracts,
  type UsageCounts,
} from "@/lib/usage/aggregate";
import { TEAM_WALLETS } from "@/lib/usage/team";
import { Skeleton } from "../Skeleton";
import { useMinuteClock, useUsage } from "./useUsage";
import styles from "./usage.module.css";

type Source = keyof UsageContracts | null;

interface Row {
  key: keyof UsageCounts;
  label: string;
  /** The contract whose logs the figure is counted from (each cell links to it on the explorer). */
  source: Source;
  sourceLabel: string;
  fmt: (n: number | null) => string;
}

const count = (n: number | null) => (n === null ? "–" : fmtCount(n));
const usdg = (n: number | null) => (n === null ? "–" : fmtUsdg(n));

const ROWS: Row[] = [
  {
    key: "wallets",
    label: "Wallets",
    source: null,
    sourceLabel: "depositors, buyers, agent owners and signers, bond posters, curators",
    fmt: count,
  },
  {
    key: "outsideWallets",
    label: "Wallets outside the team",
    source: null,
    sourceLabel: "the same, minus the team wallets listed below",
    fmt: count,
  },
  { key: "vaults", label: "Vaults", source: "vaultFactory", sourceLabel: "VaultFactory", fmt: count },
  {
    key: "epochsOpened",
    label: "Vault epochs opened",
    source: "epochManager",
    sourceLabel: "EpochManager",
    fmt: count,
  },
  {
    key: "epochsSettled",
    label: "Epochs settled",
    source: "epochManager",
    sourceLabel: "EpochManager",
    fmt: count,
  },
  {
    key: "epochsAborted",
    label: "Epochs aborted",
    source: "epochManager",
    sourceLabel: "EpochManager",
    fmt: count,
  },
  {
    key: "proposalsAccepted",
    label: "Proposals accepted",
    source: "epochManager",
    sourceLabel: "EpochManager",
    fmt: count,
  },
  {
    key: "proposalsRejected",
    label: "Proposals rejected",
    source: "epochManager",
    sourceLabel: "EpochManager",
    fmt: count,
  },
  { key: "buys", label: "Option purchases", source: "epochManager", sourceLabel: "EpochManager", fmt: count },
  {
    key: "optionsBought",
    label: "Options bought",
    source: "epochManager",
    sourceLabel: "EpochManager",
    fmt: (n) => (n === null ? "–" : fmtOptions(n)),
  },
  {
    key: "premiumUsdg",
    label: "Premium paid, USDG",
    source: "epochManager",
    sourceLabel: "EpochManager",
    fmt: usdg,
  },
  {
    key: "slashedUsdg",
    label: "USDG slashed to depositors",
    source: "epochManager",
    sourceLabel: "EpochManager",
    fmt: usdg,
  },
  {
    key: "deposits",
    label: "Deposits",
    source: "vaultFactory",
    sourceLabel: "the vaults (listed by VaultFactory)",
    fmt: count,
  },
  {
    key: "queuedDeposits",
    label: "Queued deposits",
    source: "vaultFactory",
    sourceLabel: "the vaults (listed by VaultFactory)",
    fmt: count,
  },
  {
    key: "withdrawals",
    label: "Withdrawals",
    source: "vaultFactory",
    sourceLabel: "the vaults (listed by VaultFactory)",
    fmt: count,
  },
  {
    key: "agentsRegistered",
    label: "Agents registered",
    source: "agentRegistry",
    sourceLabel: "AgentRegistry",
    fmt: count,
  },
  {
    key: "bondedUsdg",
    label: "Bond posted, USDG",
    source: "agentRegistry",
    sourceLabel: "AgentRegistry",
    fmt: usdg,
  },
  {
    key: "decisionRecords",
    label: "Decision records anchored",
    source: "decisionLog",
    sourceLabel: "DecisionLog",
    fmt: count,
  },
  {
    key: "tvlUsd",
    label: "Value locked now, USD",
    source: "vaultFactory",
    sourceLabel: "the vaults' totalAssets, stock at the oracle price",
    fmt: fmtUsd,
  },
];

const colLabel = (d: DeploymentUsage) => `${d.chainShort} ${d.version}`;

function Cell({ row, d }: { row: Row; d: DeploymentUsage }) {
  const value = row.fmt(d[row.key]);
  const address = row.source ? d.contracts[row.source] : undefined;
  return (
    <td className={styles.num} data-label={colLabel(d)}>
      {address && d.explorer ? (
        <a
          href={`${d.explorer}/address/${address}`}
          target="_blank"
          rel="noreferrer"
          className={styles.cellLink}
          title={`${row.sourceLabel} ${address} on ${d.chainName}`}
          aria-label={`${value}: ${row.label} on ${d.chainName} ${d.version}, from ${row.sourceLabel} ${address}`}
        >
          {value}
        </a>
      ) : (
        value
      )}
    </td>
  );
}

const ROLE_LABEL: Record<string, string> = {
  depositor: "deposited",
  buyer: "bought options",
  agent: "runs an agent",
  bond: "posted a bond",
  curator: "created a vault",
};

/** The full usage table for /app/proof: every deployment, every count, each linked to its source contract. */
export function UsageTable({ teamFileHref }: { teamFileHref: string }) {
  const q = useUsage();
  const now = useMinuteClock();
  const s = q.data;

  if (!s) {
    return q.isError ? (
      <div className={styles.state} role="alert" data-testid="usage-table" data-state="error">
        <p className={styles.stateTitle}>Couldn&apos;t count the testnet activity.</p>
        <p className={styles.stateText}>{errorMessage(q.error)}</p>
        <button type="button" className="pill pill-small" onClick={() => q.refetch()}>
          Try again <RotateCw aria-hidden />
        </button>
      </div>
    ) : (
      <div className={styles.loading} data-testid="usage-table" data-state="loading" aria-busy="true">
        <p className="micro micro-muted">Reading every deployment&apos;s logs</p>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} width={i % 2 ? "70%" : "92%"} />
        ))}
      </div>
    );
  }

  const blocks = s.deployments
    .filter((d, i, all) => all.findIndex((x) => x.chainId === d.chainId) === i)
    .map((d) => `${d.toBlock.toLocaleString("en-US")} on ${d.chainShort}`)
    .join(", ");

  return (
    <div className={styles.table} data-testid="usage-table" data-state="ready">
      <p className={`micro micro-muted ${styles.status}`} aria-live="polite">
        Updated {agoText(s.generatedAt, now)} · logs read to block {blocks} · refreshed every 10 min
      </p>
      {s.errors.length ? (
        <p className={styles.warn} role="status">
          Not counted this time (the chain did not answer):{" "}
          {s.errors.map((e) => `${e.key} (${e.message})`).join("; ")}.
        </p>
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.grid}>
          <caption className="sr-only">
            Testnet usage per deployment, counted from contract logs. Each figure links to the contract it is
            read from.
          </caption>
          <thead>
            <tr>
              <th scope="col">Counted</th>
              {s.deployments.map((d) => (
                <th key={d.key} scope="col" className={styles.num} title={`${d.chainName} ${d.version}`}>
                  {colLabel(d)}
                </th>
              ))}
              <th scope="col" className={styles.num}>
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.key} data-row={row.key}>
                <th scope="row">
                  <span className={styles.rowLabel}>{row.label}</span>
                  <span className={styles.rowSource}>{row.sourceLabel}</span>
                </th>
                {s.deployments.map((d) => (
                  <Cell key={d.key} row={row} d={d} />
                ))}
                <td className={`${styles.num} ${styles.total}`} data-label="Total">
                  {row.fmt(s.total[row.key])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.small}>
        Wallets in the total count once even when active on both chains; every other total is a sum. Agents
        are counted per deployment (agent #1 is registered on all three). v1 on Robinhood Chain testnet,
        superseded on 29 September, is not counted.
      </p>

      <div className={styles.outside}>
        <h3 className={styles.outsideTitle}>Wallets outside the team ({s.outside.length})</h3>
        {s.outside.length ? (
          <ul className={styles.outsideList}>
            {s.outside.map((w) => {
              const d = s.deployments.find((x) => x.chainId === w.chains[0]);
              return (
                <li key={w.address}>
                  {d?.explorer ? (
                    <a
                      href={`${d.explorer}/address/${w.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className={`mono ${styles.cellLink}`}
                      title={w.address}
                    >
                      {shortAddr(w.address)} <ArrowUpRight size={11} aria-hidden />
                    </a>
                  ) : (
                    <span className="mono">{shortAddr(w.address)}</span>
                  )}{" "}
                  <span className={styles.rowSource}>
                    {w.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")} ·{" "}
                    {w.chains
                      .map((c) => s.deployments.find((x) => x.chainId === c)?.chainShort ?? c)
                      .join(", ")}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.small}>
            None yet: every wallet so far is one of ours. Take test USDG from the{" "}
            <Link href="/app/faucet" className="text-link">
              faucet
            </Link>{" "}
            and deposit or buy, and your address shows up here within ten minutes.
          </p>
        )}
        <p className={styles.small}>
          Team wallets ({TEAM_WALLETS.length}), not counted as outside:{" "}
          {TEAM_WALLETS.map((w, i) => (
            <span key={w.address}>
              {i ? "; " : ""}
              <span className="mono" title={w.address}>
                {shortAddr(w.address)}
              </span>{" "}
              {w.short}
            </span>
          ))}
          . The list and why each is there:{" "}
          <a href={teamFileHref} target="_blank" rel="noreferrer" className="text-link">
            src/lib/usage/team.ts <ArrowUpRight size={11} aria-hidden />
          </a>
          .
        </p>
      </div>
    </div>
  );
}
