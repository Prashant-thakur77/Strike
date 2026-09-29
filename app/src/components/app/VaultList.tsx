"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useMarket, useVaults } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { fmtAmount, fmtNy, fmtPct, fmtUsd, fmtWadUsd, toNumber } from "@/lib/format";
import type { VaultHistory, VaultSummary } from "@/lib/reads";
import { Gate } from "./Gate";
import { MetaStrip } from "./MetaStrip";
import { PageHero } from "./PageHero";
import { PerShare } from "./PerShare";
import { Skeleton } from "./Skeleton";
import { StateTag } from "./StateTag";
import styles from "./app.module.css";

export function strategyName(v: Pick<VaultSummary, "isCall">) {
  return v.isCall ? "Covered call" : "Cash-secured put";
}

export function VaultsPage() {
  const { meta } = useStrike();
  const vaults = useVaults();
  const market = useMarket();
  const rows = vaults.data ?? [];
  const tvl = rows.reduce((s, r) => s + (r.summary.tvlUsd ?? 0), 0);
  const live = rows.filter((r) => r.summary.state === 2).length;
  const onSale = rows.filter(
    (r) => r.summary.state === 2 && r.summary.series && r.summary.series.sold < r.summary.series.size,
  ).length;
  const premium = rows.reduce(
    (s, r) => s + (r.history ? toNumber(r.history.premiumPaid, r.summary.usdg.decimals) : 0),
    0,
  );
  // Premium buyers have paid into live series: escrowed until settlement, so not in `premium` yet.
  const escrowed = rows.reduce(
    (s, r) =>
      s +
      (r.summary.state === 2 && r.summary.series
        ? toNumber(r.summary.series.premium, r.summary.usdg.decimals)
        : 0),
    0,
  );

  return (
    <>
      <PageHero
        index="01"
        label="Vaults"
        right={meta.label}
        title="Vaults"
        lead={
          <p className="lead">
            Put a stock token in a covered-call vault, or USDG in a cash-secured-put vault. Each week the
            vault sells one option series and pays the premium to depositors in USDG.
          </p>
        }
      />
      <Gate isLoading={vaults.isLoading} error={vaults.error} loading={<ListSkeleton />}>
        <MetaStrip
          cells={[
            {
              label: "Value locked",
              value: fmtUsd(tvl),
              sub: `${rows.length} vault${rows.length === 1 ? "" : "s"}`,
            },
            {
              label: "Live series",
              value: String(live),
              sub: onSale === live ? "options on sale now" : `${onSale} with options left to buy`,
            },
            {
              label: "Premium to depositors",
              value: fmtUsd(premium),
              sub:
                escrowed > 0
                  ? `settled · ${escrowed.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDG more in live series`
                  : "settled epochs, USDG",
            },
            {
              label: "US market",
              value: market.data ? (market.data.open ? "Open" : "Closed") : "—",
              sub: market.data ? fmtNy(market.data.now) : "NYSE hours",
            },
          ]}
        />
        <section className={`gutter ${styles.list}`} aria-label="Vaults">
          <div className={`${styles.listHead} micro micro-muted`} aria-hidden>
            <span />
            <span>Vault</span>
            <span>Value locked</span>
            <span>Epoch</span>
            <span>Live series</span>
            <span className={styles.right}>Premium APY</span>
            <span />
          </div>
          {rows.length === 0 ? (
            <p className="body">No vaults on this network yet.</p>
          ) : (
            rows.map((r, i) => (
              <VaultRow key={r.summary.address} index={i} vault={r.summary} history={r.history} />
            ))
          )}
        </section>
      </Gate>
    </>
  );
}

function VaultRow({
  vault,
  history,
  index,
}: {
  vault: VaultSummary;
  history: VaultHistory | null;
  index: number;
}) {
  const s = vault.series;
  return (
    <Link
      href={`/app/vault/${vault.address}`}
      className={styles.row}
      data-tone={vault.isCall ? "call" : "put"}
      aria-label={`${vault.underlying.symbol} ${strategyName(vault)} vault`}
    >
      <span className="index">{String(index + 1).padStart(2, "0")}</span>
      <span className={styles.rowName}>
        <span className={styles.rowTicker}>{vault.underlying.symbol}</span>
        <span className="micro micro-muted">
          {strategyName(vault)} · {vault.asset.symbol} in, USDG out
        </span>
      </span>
      <span className={styles.rowCell} data-label="Value locked">
        <span className="mono">{fmtUsd(vault.tvlUsd)}</span>
        <span className={styles.rowSub}>
          {fmtAmount(vault.totalAssets, vault.asset.decimals)} {vault.asset.symbol}
        </span>
      </span>
      <span className={styles.rowCell} data-label="Epoch">
        <StateTag state={vault.state} />
        <span className={styles.rowSub}>Epoch {vault.currentEpoch.toString()}</span>
      </span>
      <span className={styles.rowCell} data-label="Live series">
        {s ? (
          <>
            <span className="mono">
              {fmtWadUsd(s.strike)} {s.isCall ? "call" : "put"}
            </span>
            <PerShare price={s.strike} multiplier={vault.multiplier} />
            <span className={styles.rowSub}>{fmtNy(s.expiry)}</span>
          </>
        ) : (
          <span className={styles.rowSub}>{vault.state === 1 ? "Awaiting proposal" : "None"}</span>
        )}
      </span>
      <span className={`${styles.rowCell} ${styles.right}`} data-label="Premium APY">
        <span className={styles.rowApy}>{history ? fmtPct(history.apy) : "—"}</span>
        <span className={styles.rowSub}>trailing</span>
      </span>
      <span className={styles.rowArrow} aria-hidden>
        <ArrowUpRight strokeWidth={1.25} />
      </span>
    </Link>
  );
}

function ListSkeleton() {
  return (
    <section className={`gutter ${styles.list}`} aria-busy="true" aria-label="Loading vaults">
      {[0, 1].map((i) => (
        <div key={i} className={styles.row} data-tone="none">
          <Skeleton width="2em" />
          <span className={styles.rowName}>
            <Skeleton width="5em" />
          </span>
          <Skeleton width="6em" />
          <Skeleton width="5em" />
          <Skeleton width="7em" />
          <Skeleton width="4em" />
          <span />
        </div>
      ))}
    </section>
  );
}
