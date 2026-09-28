"use client";

import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { Address } from "viem";
import { useVault, useVaultHistory } from "@/hooks/queries";
import { FEED_STATUS } from "@/lib/labels";
import { fmtAmount, fmtPct, fmtUsd, fmtWadUsd } from "@/lib/format";
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
import { SeriesPanel } from "./SeriesPanel";
import { Timeline } from "./Timeline";
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
                <p className={styles.heroStrategy}>{strategyName(v)}</p>
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
                    <span className={styles.metaLine}>Feed: {FEED_STATUS[v.spot.status] ?? "unknown"}</span>
                  </>
                ),
              },
              {
                label: "Premium APY",
                value: history.data ? fmtPct(history.data.apy) : <Skeleton />,
                sub: "trailing, from settled epochs",
              },
              {
                label: `Epoch ${v.currentEpoch.toString()}`,
                value: <StateTag state={v.state} large />,
                sub: v.locked ? "Vault locked" : "Vault unlocked",
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
              note="Buyers pay USDG; the price is fair value at the moment of purchase times the series' premium factor."
            >
              <SeriesPanel vault={v} />
            </Rail>
            <Rail
              index="04"
              label="Epoch timeline"
              note="Idle, open, selling, settled. Times are New York time."
            >
              <Timeline vault={v} history={history.data} />
            </Rail>
            <Rail
              index="05"
              label="Your options"
              note="Option tokens you hold from this vault. Redeem them once the series settles."
            >
              <OptionsPanel vault={v} seriesIds={history.data?.seriesIds} />
            </Rail>
            <Rail
              index="06"
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
