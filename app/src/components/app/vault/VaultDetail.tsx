"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { Address } from "viem";
import { useVault, useVaultHistory } from "@/hooks/queries";
import { FEED_STATUS } from "@/lib/labels";
import { fmtAmount, fmtDay, fmtPct, fmtUsd, fmtWadUsd } from "@/lib/format";
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
import { strategyName } from "../VaultList";
import { DepositPanel } from "./DepositPanel";
import { MandatePanel } from "./MandatePanel";
import { OptionsPanel } from "./OptionsPanel";
import { PositionPanel } from "./PositionPanel";
import { RiskPanel } from "./RiskPanel";
import { SeriesPanel } from "./SeriesPanel";
import { Timeline } from "./Timeline";
import { WhyStrikePanel } from "./WhyStrikePanel";
import { Term } from "@/components/ui/Term";
import styles from "../app.module.css";

export function VaultDetail({ address }: { address: Address }) {
  const vault = useVault(address);
  const history = useVaultHistory(vault.data);
  const v = vault.data;

  return (
    <Gate isLoading={vault.isLoading} error={vault.error} loading={<DetailSkeleton />}>
      {v ? (
        <>
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
                  {v.name} · <AddressLink address={v.address} />
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
                      ? `Trailing, from settled epochs. First one ${fmtDay(v.series.expiry)}.`
                      : "Trailing, from settled epochs."
                    : "trailing, from settled epochs",
              },
              {
                label: `Epoch ${v.currentEpoch.toString()}`,
                term: "epoch",
                value: <StateTag state={v.state} large />,
                sub: v.locked
                  ? "Vault locked: deposits and withdrawals queue until settlement"
                  : "Vault unlocked: deposit or withdraw now",
              },
            ]}
          />
          <div className={styles.detailBody}>
            <Rail
              index="01"
              label="Your position"
              note="Shares, their value, premium waiting to be claimed and queued requests."
            >
              <PositionPanel vault={v} />
            </Rail>
            <Rail
              index="02"
              label={v.locked ? "Queue a deposit or withdrawal" : "Deposit & withdraw"}
              note={
                v.locked
                  ? "The vault is locked while this week's options are live. Requests queue and are processed at settlement, at that epoch's closing share price."
                  : "The vault is between epochs, so deposits and withdrawals go through at once."
              }
            >
              <DepositPanel vault={v} />
            </Rail>
            <Rail
              index="03"
              label="This week's option"
              note="Buyers pay USDG: fair value at the moment of purchase times the series' premium factor, never below intrinsic value."
            >
              <SeriesPanel vault={v} />
            </Rail>
            <Rail
              index="04"
              id="why"
              label="Why this strike"
              note="The agent's own record of this epoch's decision: who planned it, what it dry-ran, why, and the hash it anchored on-chain before proposing."
            >
              <WhyStrikePanel vault={v} />
            </Rail>
            <Rail
              index="05"
              id="risk"
              label="Risk"
              note="Greeks and a ±30% stress test of this week's series, computed on-chain by the Stylus risk engine each time the page refreshes."
            >
              <RiskPanel vault={v} />
            </Rail>
            <Rail
              index="06"
              label="Epoch timeline"
              note="Idle, open, selling, settled. Times are New York time."
            >
              <Timeline vault={v} history={history.data} />
            </Rail>
            <Rail
              index="07"
              label="Your options"
              note="Option tokens you hold from this vault. Redeem them once the series settles."
            >
              <OptionsPanel vault={v} seriesIds={history.data?.seriesIds} />
            </Rail>
            <Rail
              index="08"
              label="Mandate"
              note="Fixed when the vault was created. The contract rejects any proposal outside it."
            >
              <MandatePanel vault={v} />
            </Rail>
            <aside className={`gutter ${styles.feedback}`} aria-label="Feedback">
              <div className={styles.feedbackRow}>
                <span className="micro micro-muted">Testnet · tell us what worked and what didn&apos;t</span>
                <a className="micro text-link" href={LINKS.feedback} target="_blank" rel="noreferrer">
                  Give feedback <ArrowUpRight size={12} aria-hidden />
                </a>
              </div>
            </aside>
          </div>
        </>
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
