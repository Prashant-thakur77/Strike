"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useRegistry, useRejections, useVaults } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { AGENT_STATUS, reasonOf } from "@/lib/labels";
import { explorerUrl } from "@/lib/chains";
import { fmtAmount, fmtBps, fmtNy, fmtWadUsd, shortAddr } from "@/lib/format";
import type { AgentRow, Registry } from "@/lib/reads";
import { Gate } from "../Gate";
import { MetaStrip } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import styles from "../app.module.css";

function rank(a: AgentRow, b: AgentRow) {
  return b.accepted - a.accepted || a.rejected - b.rejected || Number(a.id - b.id);
}

export function AgentsPage() {
  const { meta } = useStrike();
  const reg = useRegistry();
  const r = reg.data;
  return (
    <>
      <PageHero
        index="02"
        label="Agents"
        right={meta.label}
        title="Agents"
        lead={
          <p className="lead">
            Agents pick each week&apos;s strike, but only inside the vault&apos;s mandate. Each one posts a
            USDG bond; every proposal the contract rejects costs part of it, paid to that vault&apos;s
            depositors.
          </p>
        }
      />
      <Gate isLoading={reg.isLoading} error={reg.error} loading={<Skeleton width="40%" />}>
        {r ? (
          <>
            <MetaStrip
              cells={[
                {
                  label: "Agents registered",
                  value: String(r.agents.length),
                  sub: `${r.agents.filter((a) => a.status === 1).length} active`,
                },
                {
                  label: "Minimum bond",
                  value: `${fmtAmount(r.minBond, r.usdg.decimals, 0)} USDG`,
                  sub: "to propose at all",
                },
                {
                  label: "Slash per rejection",
                  value: `${fmtAmount(r.slashAmount, r.usdg.decimals, 0)} USDG`,
                  sub: "to the vault's depositors",
                },
                { label: "Suspended at", value: `${r.maxStrikes} strikes`, sub: "until an admin reinstates" },
              ]}
            />
            <div className={styles.detailBody}>
              <Rail
                index="01"
                label="Leaderboard"
                note="Ranked by accepted proposals, then fewest rejections. Track record is AgentRegistry.track: epochs settled and their depositor PnL before fees."
              >
                <Leaderboard registry={r} />
              </Rail>
              <Rail
                index="02"
                label="Rejected proposals"
                note="Every ProposalRejected event: what the agent asked for and the rule it broke."
              >
                <RejectionFeed />
              </Rail>
            </div>
          </>
        ) : null}
      </Gate>
    </>
  );
}

function Leaderboard({ registry }: { registry: Registry }) {
  const vaults = useVaults().data;
  const vaultName = (a: string) => {
    const v = vaults?.find((x) => x.summary.address.toLowerCase() === a.toLowerCase())?.summary;
    return v ? `${v.underlying.symbol} ${v.isCall ? "CC" : "CSP"}` : shortAddr(a);
  };
  const agents = [...registry.agents].sort(rank);
  if (agents.length === 0) return <p className="body">No agents registered yet.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={`${styles.table} ${styles.board}`}>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Agent</th>
            <th scope="col">Status</th>
            <th scope="col" className={styles.num}>
              Accepted
            </th>
            <th scope="col" className={styles.num}>
              Rejected
            </th>
            <th scope="col" className={styles.num}>
              Track record
            </th>
            <th scope="col">Strikes</th>
            <th scope="col" className={styles.num}>
              Bond
            </th>
            <th scope="col">ERC-8004 id</th>
            <th scope="col">Runs</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a, i) => (
            <tr key={a.id.toString()}>
              <td className="index">{String(i + 1).padStart(2, "0")}</td>
              <td>
                <strong>Agent {a.id.toString()}</strong>
                <span className={`mono ${styles.cellMuted}`}>{shortAddr(a.signer)}</span>
              </td>
              <td>
                <span className={styles.status} data-status={AGENT_STATUS[a.status]}>
                  {AGENT_STATUS[a.status] ?? "Unknown"}
                </span>
              </td>
              <td className={`mono ${styles.num}`} data-label="Accepted">
                {a.accepted}
              </td>
              <td className={`mono ${styles.num}`} data-label="Rejected">
                {a.rejected}
              </td>
              <td className={styles.num} data-label="Track record">
                <TrackRecord agent={a} decimals={registry.usdg.decimals} />
              </td>
              <td data-label="Strikes">
                <span className={styles.pips} aria-label={`${a.strikes} of ${registry.maxStrikes} strikes`}>
                  {Array.from({ length: registry.maxStrikes }, (_, k) => (
                    <i key={k} data-on={k < a.strikes} />
                  ))}
                </span>
              </td>
              <td className={`mono ${styles.num}`} data-label="Bond">
                {fmtAmount(a.bond, registry.usdg.decimals)} USDG
              </td>
              <td data-label="ERC-8004 id">
                {a.erc8004Id > 0n ? (
                  <span className="mono">#{a.erc8004Id.toString()}</span>
                ) : (
                  <span className={styles.cellMuted}>Not linked</span>
                )}
              </td>
              <td data-label="Runs">
                {a.vaults.length === 0
                  ? "—"
                  : a.vaults.map((v) => (
                      <Link key={v} href={`/app/vault/${v}`} className={`text-link ${styles.runLink}`}>
                        {vaultName(v)}
                      </Link>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `AgentRegistry.track(agentId)`: settled epochs and cumulative depositor PnL in USDG. */
function TrackRecord({ agent, decimals }: { agent: AgentRow; decimals: number }) {
  const pnl = agent.cumulativePnl;
  const sign = pnl > 0n ? "+" : pnl < 0n ? "−" : "";
  const n = agent.settledEpochs;
  return (
    <>
      <span className={`mono ${styles.pnl}`} data-sign={pnl > 0n ? "gain" : pnl < 0n ? "loss" : "flat"}>
        {n === 0 ? "—" : `${sign}${fmtAmount(pnl < 0n ? -pnl : pnl, decimals)} USDG`}
      </span>
      <span className={styles.cellMuted}>
        {n} epoch{n === 1 ? "" : "s"} settled
      </span>
    </>
  );
}

function RejectionFeed() {
  const feed = useRejections();
  const { chainId } = useStrike();
  const vaults = useVaults().data;
  if (feed.isLoading) return <Skeleton width="50%" />;
  if (!feed.data || feed.data.length === 0) {
    return <p className="body">No rejected proposals yet. Every agent has stayed inside its mandate.</p>;
  }
  return (
    <ol className={styles.feed}>
      {feed.data.map((r) => {
        const v = vaults?.find((x) => x.summary.address.toLowerCase() === r.vault.toLowerCase())?.summary;
        const reason = reasonOf(r.reason);
        const dec = v?.underlying.decimals ?? 18;
        const url = explorerUrl(chainId, "tx", r.tx);
        return (
          <li key={r.key} className={styles.feedItem}>
            <span className={`mono ${styles.feedTime}`}>{r.time ? fmtNy(r.time) : "—"}</span>
            <div className={styles.feedMain}>
              <span className={styles.reason}>{reason.name}</span>
              <p>
                <strong>Agent {r.agentId.toString()}</strong> on{" "}
                <Link href={`/app/vault/${r.vault}`} className="text-link">
                  {v
                    ? `${v.underlying.symbol} ${v.isCall ? "covered call" : "cash-secured put"}`
                    : shortAddr(r.vault)}
                </Link>
                : {reason.text.toLowerCase()}.
              </p>
              <span className={`micro micro-muted ${styles.feedAsk}`}>
                Asked {fmtWadUsd(r.strike)} strike · {fmtAmount(r.size, dec)} options · {fmtBps(r.premiumBps)}{" "}
                of fair · expiry {fmtNy(r.expiry)} · epoch {r.epoch.toString()}
                {url ? (
                  <>
                    {" · "}
                    <a href={url} target="_blank" rel="noreferrer" className="text-link">
                      Tx <ArrowUpRight size={11} aria-hidden />
                    </a>
                  </>
                ) : null}
              </span>
            </div>
            <span className={styles.slash}>
              <span className="micro micro-muted">Slashed</span>
              <span className="mono">−{fmtAmount(r.slashed, 6)} USDG</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
