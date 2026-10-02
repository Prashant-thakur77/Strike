"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useAllVaults, useMarket } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import {
  fmtAmount,
  fmtBps,
  fmtDay,
  fmtDelta,
  fmtNy,
  fmtPct,
  fmtUsd,
  fmtWadUsd,
  toNumber,
} from "@/lib/format";
import { clockNow, seriesPhase } from "@/lib/lifecycle";
import type { VaultHistory, VaultSummary } from "@/lib/reads";
import { StartHere } from "@/components/ui/StartHere";
import { Gate } from "./Gate";
import { MetaStrip } from "./MetaStrip";
import { PageHero } from "./PageHero";
import { PerShare } from "./PerShare";
import { Skeleton } from "./Skeleton";
import { StateTag } from "./StateTag";
import { Term } from "@/components/ui/Term";
import { MarketSub } from "./market/MarketHours";
import styles from "./app.module.css";

export function strategyName(v: Pick<VaultSummary, "isCall">) {
  return v.isCall ? "Covered call" : "Cash-secured put";
}

/** Which protocol version's contracts a vault (or agent) belongs to, where a chain runs more than one. */
export function VersionTag({ version, label }: { version: string; label?: string }) {
  return (
    <span className={styles.version} data-version={version} title={`Strike ${version} contracts`}>
      {label ?? version}
    </span>
  );
}

type Row = { summary: VaultSummary; history: VaultHistory | null };

/** Newest protocol version first ("v3" before "v2"), keeping each deployment's own order inside. */
function byVersion(rows: Row[]): { version: string; rows: Row[] }[] {
  const groups: { version: string; rows: Row[] }[] = [];
  for (const r of rows) {
    const g = groups.find((x) => x.version === r.summary.version);
    if (g) g.rows.push(r);
    else groups.push({ version: r.summary.version, rows: [r] });
  }
  const n = (v: string) => Number(v.replace(/^v/, "")) || 0;
  return groups.sort((a, b) => n(b.version) - n(a.version));
}

export function VaultsPage() {
  const { meta, deployments } = useStrike();
  const vaults = useAllVaults();
  const market = useMarket();
  const rows = vaults.data ?? [];
  // One group per deployment where the chain runs more than one (v3 and v2 on Robinhood Chain testnet).
  const multi = deployments.length > 1;
  const groups = multi ? byVersion(rows) : [{ version: "", rows }];
  const defaultVersion = deployments[0]?.version ?? "";
  const tvl = rows.reduce((s, r) => s + (r.summary.tvlUsd ?? 0), 0);
  const now = clockNow(market.data?.now);
  // A series past expiry stays Selling on chain until it settles: counted apart, never as on sale.
  const live = rows.filter((r) => seriesPhase(r.summary, now) === "selling").length;
  const settling = rows.filter((r) => seriesPhase(r.summary, now) === "expired").length;
  const onSale = rows.filter(
    (r) =>
      seriesPhase(r.summary, now) === "selling" &&
      r.summary.series &&
      r.summary.series.sold < r.summary.series.size,
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
            Put a <Term id="stockToken">stock token</Term> in a <Term id="coveredCall">covered-call</Term>{" "}
            vault, or USDG in a <Term id="cashSecuredPut">cash-secured-put</Term> vault. Each week the vault
            sells one option <Term id="series">series</Term> and pays the <Term id="premium">premium</Term> to
            depositors in <Term id="usdg">USDG</Term>.
          </p>
        }
      >
        <StartHere firstHref="#vault-list" className={styles.heroStart} />
      </PageHero>
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
              term: "series",
              value: String(live),
              sub: [
                onSale === live ? "options on sale now" : `${onSale} with options left to buy`,
                settling ? `${settling} expired, waiting for settlement` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            },
            {
              label: "Premium to depositors",
              term: "premium",
              value: fmtUsd(premium),
              sub:
                escrowed > 0
                  ? `settled · ${escrowed.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDG more in live series`
                  : "settled epochs, USDG",
            },
            {
              label: "US market",
              value: market.data ? (market.data.open ? "Open" : "Closed") : "—",
              sub: market.data ? <MarketSub market={market.data} /> : "NYSE hours",
            },
          ]}
        />
        <section id="vault-list" className={`gutter ${styles.list}`} aria-label="Vaults">
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
            groups.map((g, gi) => {
              const offset = groups.slice(0, gi).reduce((n, x) => n + x.rows.length, 0);
              return (
                <div
                  key={g.version || "all"}
                  className={styles.listGroup}
                  data-version={g.version || undefined}
                >
                  {multi ? (
                    <p className={`micro micro-muted ${styles.listGroupHead}`}>
                      <VersionTag version={g.version} />
                      <span>
                        {g.rows.length} vault{g.rows.length === 1 ? "" : "s"}
                        {g.version === defaultVersion
                          ? " · the network's default deployment"
                          : ` · deployed next to ${defaultVersion}`}
                      </span>
                    </p>
                  ) : null}
                  {g.rows.map((r, i) => (
                    <VaultRow
                      key={r.summary.address}
                      index={offset + i}
                      vault={r.summary}
                      history={r.history}
                      showVersion={multi}
                      now={now}
                    />
                  ))}
                </div>
              );
            })
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
  showVersion,
  now,
}: {
  vault: VaultSummary;
  history: VaultHistory | null;
  index: number;
  showVersion: boolean;
  now: number;
}) {
  const s = vault.series;
  const expired = seriesPhase(vault, now) === "expired";
  return (
    <Link
      href={`/app/vault/${vault.address}`}
      className={styles.row}
      data-tone={vault.isCall ? "call" : "put"}
      aria-label={`${vault.underlying.symbol} ${strategyName(vault)} vault ${vault.symbol}, agent #${vault.agentId}${showVersion && vault.version ? ` (${vault.version})` : ""}`}
      data-version={vault.version || undefined}
    >
      <span className="index">{String(index + 1).padStart(2, "0")}</span>
      <span className={styles.rowName}>
        <span className={styles.rowTitle}>
          <span className={styles.rowTicker}>{vault.underlying.symbol}</span>
          <span className={styles.rowTags}>
            <span className={styles.kind} data-tone={vault.isCall ? "call" : "put"}>
              {strategyName(vault)}
            </span>
            {showVersion && vault.version ? <VersionTag version={vault.version} /> : null}
          </span>
        </span>
        <span className={`micro micro-muted ${styles.rowMeta}`} data-testid="vault-row-meta">
          <span className={styles.rowSymbol}>{vault.symbol}</span> · agent #{vault.agentId.toString()} ·{" "}
          {vault.asset.symbol} in · USDG premium out
        </span>
        <span className={styles.rowMandate} data-testid="vault-row-mandate">
          Mandate: delta {fmtDelta(vault.mandate.minDeltaBps)}–{fmtDelta(vault.mandate.maxDeltaBps)} · premium
          ≥ {fmtBps(vault.mandate.minPremiumBps)} of fair · sells ≤ {fmtBps(vault.mandate.maxShareSoldBps)}
        </span>
      </span>
      <span className={styles.rowCell} data-label="Value locked">
        <span className="mono">{fmtUsd(vault.tvlUsd)}</span>
        <span className={styles.rowSub}>
          {fmtAmount(vault.totalAssets, vault.asset.decimals)} {vault.asset.symbol}
        </span>
      </span>
      <span className={styles.rowCell} data-label="Epoch">
        <StateTag state={vault.state} expired={expired} />
        <span className={styles.rowSub}>Epoch {vault.currentEpoch.toString()}</span>
      </span>
      <span className={styles.rowCell} data-label="Live series">
        {s ? (
          <>
            <span className={`mono ${styles.rowStrike}`}>
              {fmtWadUsd(s.strike)} {s.isCall ? "call" : "put"}
            </span>
            <PerShare price={s.strike} multiplier={vault.multiplier} />
            <span className={styles.rowSub}>
              {expired ? `Expired ${fmtNy(s.expiry)}, waiting for settlement` : fmtNy(s.expiry)}
            </span>
          </>
        ) : vault.state === 1 ? (
          <>
            <span>Awaiting proposal</span>
            <span className={styles.rowSub}>the agent picks this week&apos;s strike</span>
          </>
        ) : (
          <>
            <span>None this week</span>
            <span className={styles.rowSub}>a series is listed when an epoch opens (Mondays)</span>
          </>
        )}
      </span>
      <span className={`${styles.rowCell} ${styles.right}`} data-label="Premium APY">
        {history && history.apy !== null ? (
          <>
            <span className={styles.rowApy}>{fmtPct(history.apy)}</span>
            <span className={styles.rowSub}>trailing</span>
          </>
        ) : (
          <>
            <span className={styles.rowApyPending}>After the first settlement</span>
            <span className={styles.rowSub}>{s ? fmtDay(s.expiry) : "once an epoch settles"}</span>
          </>
        )}
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
          <span className="index">{String(i + 1).padStart(2, "0")}</span>
          <span className={styles.rowName}>
            <Skeleton width="5em" />
          </span>
          {["Value locked", "Epoch", "Live series", "Premium APY"].map((label) => (
            <span key={label} className={styles.rowCell} data-label={label}>
              <Skeleton width="4.5em" />
            </span>
          ))}
          <span className={styles.rowArrow} aria-hidden />
        </div>
      ))}
    </section>
  );
}
