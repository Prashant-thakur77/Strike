"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { useRegistry, useRejections, useVaults } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { AGENT_STATUS, reasonOf } from "@/lib/labels";
import { explorerNftUrl, explorerUrl } from "@/lib/chains";
import { fmtAmount, fmtBps, fmtNy, fmtWadUsd, shortAddr } from "@/lib/format";
import type { AgentRow, Registry } from "@/lib/reads";
import { Gate } from "../Gate";
import { DecisionLog } from "./DecisionLog";
import { RegisterAgent } from "./RegisterAgent";
import { SeasonBanner } from "./SeasonBanner";
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
        index="04"
        label="Agents"
        right={meta.label}
        title="Agents"
        lead={
          <p className="lead">
            Agents pick each week&apos;s strike, but only inside the vault&apos;s mandate. Each one posts a
            USDG bond; every proposal the contract rejects costs part of it, paid to that vault&apos;s
            depositors. Any wallet can{" "}
            <a href="#run-your-own-agent" className="text-link">
              run its own agent
            </a>
            .
          </p>
        }
      />
      <SeasonBanner />
      <Gate isLoading={reg.isLoading} error={reg.error} loading={<Skeleton width="40%" />}>
        {r ? (
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
        ) : null}
      </Gate>
      {/* The decision log comes from GitHub, not the chain: it shows whatever the network or its state. */}
      <div className={styles.detailBody}>
        {r ? (
          <Rail
            index="01"
            label="Leaderboard"
            note="Ranked by accepted proposals, then fewest rejections. Open a row for the track record (AgentRegistry.track), the ERC-8004 identity and reputation, and the vaults it runs."
          >
            <Leaderboard registry={r} />
          </Rail>
        ) : null}
        <Rail
          index="02"
          id="decision-log"
          label="Decision log"
          note={
            <>
              Every Monday the example agent proposes for each Robinhood Chain testnet vault and every Friday
              it settles, by itself, from a scheduled GitHub Actions job. Each run commits a record of what it
              saw, what it chose and why, and what the contract said. Newest first.
            </>
          }
        >
          <DecisionLog />
        </Rail>
        {r ? (
          <Rail
            index="03"
            label="Rejected proposals"
            note="Every ProposalRejected event: what the agent asked for and the rule it broke."
          >
            <RejectionFeed />
          </Rail>
        ) : null}
        {r ? (
          <Rail
            index="04"
            id="run-your-own-agent"
            label="Run your own agent"
            note="Any wallet can register an AI agent, bond it and run a vault with it. No permission needed: the contracts enforce the rules."
          >
            <RegisterAgent registry={r} />
          </Rail>
        ) : null}
      </div>
    </>
  );
}

function Leaderboard({ registry }: { registry: Registry }) {
  const vaults = useVaults().data;
  const vaultName = (a: string) => {
    const v = vaults?.find((x) => x.summary.address.toLowerCase() === a.toLowerCase())?.summary;
    return v ? `${v.underlying.symbol} ${v.isCall ? "covered call" : "cash-secured put"}` : shortAddr(a);
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
            <th scope="col">Strikes</th>
            <th scope="col" className={styles.num}>
              Bond
            </th>
            <th scope="col">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        {agents.map((a, i) => (
          <AgentRows
            key={a.id.toString()}
            agent={a}
            rank={i}
            registry={registry}
            vaultName={vaultName}
            defaultOpen={i === 0}
          />
        ))}
      </table>
    </div>
  );
}

function AgentRows({
  agent: a,
  rank: i,
  registry,
  vaultName,
  defaultOpen,
}: {
  agent: AgentRow;
  rank: number;
  registry: Registry;
  vaultName: (a: string) => string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { chainId } = useStrike();
  const detailsId = useId();
  const dec = registry.usdg.decimals;
  const identityUrl =
    registry.identityRegistry && a.erc8004Id > 0n
      ? explorerNftUrl(chainId, registry.identityRegistry, a.erc8004Id)
      : null;
  const reputationUrl = registry.reputationRegistry
    ? explorerUrl(chainId, "address", registry.reputationRegistry)
    : null;
  const regUrl = registrationLink(a.registrationUri);
  return (
    <tbody className={styles.agentGroup} data-open={open}>
      <tr>
        <td className="index">{String(i + 1).padStart(2, "0")}</td>
        <td>
          <strong>Agent {a.id.toString()}</strong>
          <span className={`mono ${styles.cellMuted}`}>{shortAddr(a.signer)}</span>
          {a.erc8004Id > 0n ? (
            identityUrl ? (
              <a href={identityUrl} target="_blank" rel="noreferrer" className={styles.idChip}>
                ERC-8004 #{a.erc8004Id.toString()} <ArrowUpRight size={11} aria-hidden />
              </a>
            ) : (
              <span className={styles.idChip}>ERC-8004 #{a.erc8004Id.toString()}</span>
            )
          ) : null}
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
        <td data-label="Strikes">
          <span className={styles.pips} aria-label={`${a.strikes} of ${registry.maxStrikes} strikes`}>
            {Array.from({ length: registry.maxStrikes }, (_, k) => (
              <i key={k} data-on={k < a.strikes} />
            ))}
          </span>
        </td>
        <td className={`mono ${styles.num}`} data-label="Bond">
          {fmtAmount(a.bond, dec)} USDG
        </td>
        <td className={styles.toggleCell}>
          <button
            type="button"
            className={styles.rowToggle}
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((o) => !o)}
          >
            <span>{open ? "Less" : "More"}</span>
            <ChevronDown size={14} aria-hidden />
            <span className="sr-only"> about agent {a.id.toString()}</span>
          </button>
        </td>
      </tr>
      <tr id={detailsId} className={styles.agentDetails} hidden={!open}>
        <td colSpan={8}>
          <dl className={styles.agentFacts}>
            <div>
              <dt className="micro micro-muted">Track record</dt>
              <dd>
                <TrackRecord agent={a} decimals={dec} />
              </dd>
            </div>
            <div>
              <dt className="micro micro-muted">ERC-8004 identity</dt>
              <dd>
                {a.erc8004Id > 0n ? (
                  <>
                    <span className={styles.factValue}>#{a.erc8004Id.toString()}</span>
                    <span className={styles.factLinks}>
                      {identityUrl ? (
                        <a href={identityUrl} target="_blank" rel="noreferrer" className="text-link">
                          Identity token <ArrowUpRight size={11} aria-hidden />
                        </a>
                      ) : null}
                      {regUrl ? (
                        <a href={regUrl} target="_blank" rel="noreferrer" className="text-link">
                          Registration file <ArrowUpRight size={11} aria-hidden />
                        </a>
                      ) : null}
                    </span>
                  </>
                ) : (
                  <span className={styles.cellMuted}>Not linked</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="micro micro-muted">Reputation</dt>
              <dd>
                {registry.reputationRegistry ? (
                  <>
                    <span className={styles.factValue}>
                      {a.feedbackPosted === null
                        ? "—"
                        : `${a.feedbackPosted} feedback post${a.feedbackPosted === 1 ? "" : "s"}`}
                    </span>
                    <span className={styles.cellMuted}>
                      Epoch PnL and rejections, posted to the ERC-8004 registry
                    </span>
                    {reputationUrl ? (
                      <a href={reputationUrl} target="_blank" rel="noreferrer" className="text-link">
                        Reputation registry <ArrowUpRight size={11} aria-hidden />
                      </a>
                    ) : null}
                  </>
                ) : (
                  <span className={styles.cellMuted}>No reputation registry on this network</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="micro micro-muted">Runs</dt>
              <dd className={styles.factLinks}>
                {a.vaults.length === 0 ? (
                  <span className={styles.cellMuted}>No vaults yet</span>
                ) : (
                  a.vaults.map((v) => (
                    <Link key={v} href={`/app/vault/${v}`} className="text-link">
                      {vaultName(v)}
                    </Link>
                  ))
                )}
              </dd>
            </div>
          </dl>
        </td>
      </tr>
    </tbody>
  );
}

/** A tokenURI as a link people can open: GitHub raw files go to their GitHub page, ipfs:// through a gateway. */
function registrationLink(uri: string | null): string | null {
  if (!uri) return null;
  const raw = uri.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (raw) return `https://github.com/${raw[1]}/${raw[2]}/blob/${raw[3]}/${raw[4]}`;
  if (uri.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${uri.slice(7)}`;
  return /^https?:\/\//.test(uri) ? uri : null;
}

/** `AgentRegistry.track(agentId)`: settled epochs and cumulative depositor PnL in USDG. */
function TrackRecord({ agent, decimals }: { agent: AgentRow; decimals: number }) {
  const pnl = agent.cumulativePnl;
  const sign = pnl > 0n ? "+" : pnl < 0n ? "−" : "";
  const n = agent.settledEpochs;
  if (n === 0) {
    return (
      <>
        <span className={styles.factValue}>No settled epochs yet</span>
        <span className={styles.cellMuted}>0 epochs settled · depositor PnL shows after the first</span>
      </>
    );
  }
  return (
    <>
      <span
        className={`mono ${styles.pnl} ${styles.factValue}`}
        data-sign={pnl > 0n ? "gain" : pnl < 0n ? "loss" : "flat"}
      >
        {`${sign}${fmtAmount(pnl < 0n ? -pnl : pnl, decimals)} USDG`}
      </span>
      <span className={styles.cellMuted}>
        depositor PnL before fees · {n} epoch{n === 1 ? "" : "s"} settled
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
