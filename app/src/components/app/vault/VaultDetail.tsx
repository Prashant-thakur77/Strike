"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight, ChevronDown } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { useConnection } from "wagmi";
import { useMarket, useVault, useVaultHistory } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { DeploymentScope } from "@/components/providers/DeploymentScope";
import { FEED_STATUS } from "@/lib/labels";
import { fmtAmount, fmtDay, fmtPct, fmtUsd, fmtWadUsd } from "@/lib/format";
import { clockNow, seriesPhase } from "@/lib/lifecycle";
import { LINKS } from "@/lib/links";
import { hasMultiplier } from "@/lib/shares";
import { AddressLink } from "../AddressLink";
import { Gate } from "../Gate";
import { MetaStrip } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { PerShare } from "../PerShare";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import { StateTag } from "../StateTag";
import { VersionTag, strategyName } from "../VaultList";
import { GasNudge } from "../faucet/GetStarted";
import { DripNudge } from "../faucet/UsdgDrip";
import { MirrorBadge } from "../mirror/MirrorBadge";
import { DepositPanel } from "./DepositPanel";
import { EpochTrace } from "./EpochTrace";
import { MandatePanel } from "./MandatePanel";
import { OptionsPanel } from "./OptionsPanel";
import { PositionPanel } from "./PositionPanel";
import { RiskPanel } from "./RiskPanel";
import { SeriesPanel } from "./SeriesPanel";
import { ThisWeekCall } from "./ThisWeekCall";
import { Timeline } from "./Timeline";
import { WhyStrikePanel } from "./WhyStrikePanel";
import { Term } from "@/components/ui/Term";
import styles from "../app.module.css";

export function VaultDetail({ address }: { address: Address }) {
  const vault = useVault(address);
  const history = useVaultHistory(vault.data);
  const { deployments, chainId } = useStrike();
  const market = useMarket().data;
  const v = vault.data;
  const phase = v ? seriesPhase(v, clockNow(market?.now)) : null;
  const expired = phase === "expired";
  // Where a chain runs more than one deployment (v2 and v3 on Robinhood Chain testnet), say which one this vault is.
  const showVersion = deployments.length > 1 && !!v?.version;
  const { isConnected } = useConnection();
  const folds = useFolds(DETAIL_IDS);

  return (
    <Gate isLoading={vault.isLoading} error={vault.error} loading={<DetailSkeleton />}>
      {v ? (
        <DeploymentScope deployment={v.deployment}>
          <PageHero
            theme={v.isCall ? "call" : "put"}
            label={`${strategyName(v)} vault · ${v.symbol}`}
            right={
              <Link href="/app" className={styles.back}>
                <ArrowLeft size={12} aria-hidden /> All vaults
              </Link>
            }
            title={v.underlying.symbol}
            lead={
              <>
                <p className={styles.heroStrategy}>
                  <Term id={v.isCall ? "coveredCall" : "cashSecuredPut"}>{strategyName(v)}</Term>
                </p>
                <p className="lead">
                  {v.isCall
                    ? `Deposit ${v.underlying.symbol}. Each week the vault sells covered calls on part of it and pays you the premium in USDG. If ${v.underlying.symbol} closes above the strike, that upside goes to the option buyers.`
                    : `Deposit USDG. Each week the vault sells cash-secured puts on ${v.underlying.symbol} and pays you the premium. If ${v.underlying.symbol} closes below the strike, the vault pays the difference in USDG.`}
                </p>
                <p className={`micro ${styles.heroAddr}`}>
                  {showVersion ? (
                    <>
                      <VersionTag version={v.version} /> {v.name}
                    </>
                  ) : (
                    v.name
                  )}{" "}
                  · <AddressLink address={v.address} />
                </p>
              </>
            }
          />
          <MetaStrip
            cells={[
              {
                label: "Value locked",
                value: fmtUsd(v.tvlUsd),
                sub: `${fmtAmount(v.totalAssets, v.asset.decimals)} ${v.asset.symbol} of ${fmtAmount(v.depositCap, v.asset.decimals, 0)} cap`,
              },
              {
                label: `${v.underlying.symbol} spot${hasMultiplier(v.multiplier) ? " per token" : ""}`,
                value: v.spot.price > 0n ? fmtWadUsd(v.spot.price) : "—",
                sub: (
                  <>
                    <PerShare price={v.spot.price} multiplier={v.multiplier} />
                    <span className={styles.metaLine}>
                      Price feed: {FEED_STATUS[v.spot.status] ?? "unknown"}
                    </span>
                    <MirrorBadge chainId={chainId} symbol={v.underlying.symbol} />
                  </>
                ),
              },
              {
                label: "Premium APY",
                term: "premium",
                value: !history.data ? (
                  <Skeleton />
                ) : history.data.apy === null ? (
                  <span className={styles.metaPending}>After the first settlement</span>
                ) : (
                  fmtPct(history.data.apy)
                ),
                sub:
                  history.data && history.data.apy === null
                    ? v.series
                      ? expired
                        ? "Trailing, from settled epochs. The first comes when this series settles, at the first mainnet price after its expiry."
                        : `Trailing, from settled epochs. First one ${fmtDay(v.series.expiry)}.`
                      : "Trailing, from settled epochs."
                    : "trailing, from settled epochs",
              },
              {
                label: `Epoch ${v.currentEpoch.toString()}`,
                term: "epoch",
                value: <StateTag state={v.state} expired={expired} large />,
                sub: expired
                  ? "Series expired, not settled yet: deposits and withdrawals queue until settlement"
                  : v.locked
                    ? "Vault locked: deposits and withdrawals queue until settlement"
                    : "Vault unlocked: deposit or withdraw now",
              },
            ]}
          />
          <div className={styles.detailBody}>
            <Rail
              index="01"
              id="call"
              label="This week's call"
              note="The agent's decision in five lines, from its anchored record and the chain."
            >
              <ThisWeekCall vault={v} />
            </Rail>
            <Rail
              index="02"
              label={v.locked ? "Queue a deposit or withdrawal" : "Deposit & withdraw"}
              note={
                expired
                  ? "This week's series has expired and the vault stays locked until it settles. Requests queue and are processed at settlement, at that epoch's closing share price."
                  : v.locked
                    ? "The vault is locked while this week's options are live. Requests queue and are processed at settlement, at that epoch's closing share price."
                    : "The vault is between epochs, so deposits and withdrawals go through at once."
              }
            >
              <GasNudge />
              {v.isCall ? null : <DripNudge />}
              <DepositPanel vault={v} />
            </Rail>
            <Rail
              index="03"
              label="This week's option"
              note="Buyers pay USDG: fair value at the moment of purchase times the series' premium factor, never below intrinsic value."
            >
              {v.isCall ? <DripNudge /> : null}
              <SeriesPanel vault={v} history={history.data} />
            </Rail>
            <Rail
              index="04"
              id="timeline"
              label="Epoch timeline"
              note="Where this week is: idle, open, selling, settled. Times are New York time."
            >
              <Timeline vault={v} history={history.data} />
            </Rail>
            <Rail
              index="05"
              label="Your position"
              note={
                <>
                  Shares, their value, premium waiting to be claimed and queued requests.{" "}
                  <Link href="/app/portfolio" className="text-link" data-testid="portfolio-link">
                    Every vault at once
                  </Link>
                </>
              }
            >
              <PositionPanel vault={v} />
            </Rail>
            {/* Option tokens only matter to a wallet that may hold some; signed out, Your position already asks. */}
            {isConnected ? (
              <Rail
                index="06"
                label="Your options"
                note="Option tokens you hold from this vault. Redeem them once the series settles."
              >
                <OptionsPanel vault={v} seriesIds={history.data?.seriesIds} />
              </Rail>
            ) : null}
            <Rail
              index={isConnected ? "07" : "06"}
              id="mandate"
              label="Mandate"
              note="The rules the agent can't break. Fixed when the vault was created; the contract rejects any proposal outside them."
            >
              <MandatePanel vault={v} />
            </Rail>
            <section
              className={`gutter ${styles.experts}`}
              aria-labelledby="experts-title"
              data-testid="vault-details"
            >
              <div className={styles.expertsHead}>
                <p id="experts-title" className={styles.expertsTitle}>
                  Details for experts
                </p>
                <button type="button" className={styles.expertsToggle} onClick={folds.toggleAll}>
                  {folds.allOpen ? "Close all" : "Open all"}
                </button>
              </div>
              <DetailFold
                id="why"
                index="A"
                label="Why this strike"
                note="The agent's own record of this decision, and the hash it anchored on-chain before proposing."
                open={folds.isOpen("why")}
                onToggle={folds.set}
              >
                <WhyStrikePanel vault={v} />
              </DetailFold>
              <DetailFold
                id="risk"
                index="B"
                label="Risk"
                note={
                  expired
                    ? "The ±30% stress test against the last print, computed on-chain by the Stylus risk engine."
                    : "Greeks and a ±30% stress test of this week's series, computed on-chain by the Stylus risk engine."
                }
                open={folds.isOpen("risk")}
                onToggle={folds.set}
              >
                <RiskPanel vault={v} />
              </DetailFold>
              <DetailFold
                id="trace"
                index="C"
                label="Epoch trace"
                note="Every step of this epoch and the last, each with its transaction and the evidence it carries. Times are UTC."
                open={folds.isOpen("trace")}
                onToggle={folds.set}
              >
                <p className={styles.detailLong}>
                  The opening snapshot, the anchored decision record, proposals and slashes, buys, the
                  settlement round checked against mainnet Chainlink, redemptions and claims, and deposits and
                  withdrawals, queued or made while the vault was unlocked.
                </p>
                <EpochTrace vault={v} />
              </DetailFold>
            </section>
            <aside className={`gutter ${styles.feedback}`} aria-label="Feedback">
              <div className={styles.feedbackRow}>
                <span className="micro micro-muted">Testnet · tell us what worked and what didn&apos;t</span>
                <a className="micro text-link" href={LINKS.feedback} target="_blank" rel="noreferrer">
                  Give feedback <ArrowUpRight size={12} aria-hidden />
                </a>
              </div>
            </aside>
          </div>
        </DeploymentScope>
      ) : null}
    </Gate>
  );
}

function DetailSkeleton() {
  return (
    <div className="gutter" aria-busy="true" style={{ paddingTop: 80, display: "grid", gap: 24 }}>
      <Skeleton width="30%" />
      <span className="display-h1">
        <Skeleton width="3em" />
      </span>
      <Skeleton width="60%" />
    </div>
  );
}

const DETAIL_IDS = ["why", "risk", "trace"] as const;
type DetailId = (typeof DETAIL_IDS)[number];

/**
 * Which expert sections are open. Closed at first so the page leads with the action; a link to one (#why, #risk,
 * #trace, from the docs, the decision page or the trace's own links) opens it and scrolls to it.
 */
function useFolds(ids: readonly DetailId[]) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      if (!(ids as readonly string[]).includes(id)) return;
      setOpen((o) => ({ ...o, [id]: true }));
      // After the section has rendered open (the page may still be loading its data).
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [ids]);
  const allOpen = ids.every((id) => open[id]);
  return {
    isOpen: (id: string) => !!open[id],
    set: (id: string, value: boolean) => setOpen((o) => (o[id] === value ? o : { ...o, [id]: value })),
    allOpen,
    toggleAll: () => setOpen(Object.fromEntries(ids.map((id) => [id, !allOpen]))),
  };
}

/** One expert section: a labelled summary with a one-line note; the content stays in the page when closed. */
function DetailFold({
  id,
  index,
  label,
  note,
  open,
  onToggle,
  children,
}: {
  id: string;
  index: string;
  label: string;
  note: ReactNode;
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
  children: ReactNode;
}) {
  // Arriving on a link to this section after the vault has loaded: bring it into view once it is open.
  useEffect(() => {
    if (window.location.hash === `#${id}`) {
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    }
  }, [id]);
  return (
    <section id={id} className={styles.detailFold} aria-labelledby={`${id}-title`}>
      <details
        open={open}
        onToggle={(e) => {
          if (e.currentTarget.open !== open) onToggle(id, e.currentTarget.open);
        }}
        data-testid={`fold-${id}`}
      >
        <summary className={styles.detailSummary}>
          <span className="index">{index}</span>
          <span className={styles.detailLabel}>
            <h2 id={`${id}-title`} className={styles.detailTitle}>
              {label}
            </h2>
            <span className={styles.detailNote}>{note}</span>
          </span>
          <span className={styles.detailChevron} aria-hidden>
            <ChevronDown size={16} />
          </span>
        </summary>
        <div className={styles.detailBodyInner}>{children}</div>
      </details>
    </section>
  );
}
