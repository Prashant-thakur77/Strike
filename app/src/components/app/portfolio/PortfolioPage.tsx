"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { PublicClient } from "viem";
import { useConnection } from "wagmi";
import { useAllVaults, useMarket } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { fmtNy, toNumber } from "@/lib/format";
import {
  hasPosition,
  intrinsicNow,
  optionState,
  portfolioTotals,
  type OptionRow,
  type OptionState,
  type PositionRow,
} from "@/lib/portfolio";
import { optionHoldings, position, type VaultSummary } from "@/lib/reads";
import { Gate } from "../Gate";
import { MetaStrip, MetaStripSkeleton } from "../MetaStrip";
import { PageHero } from "../PageHero";
import { Rail } from "../Rail";
import { Skeleton } from "../Skeleton";
import styles from "../app.module.css";

const usd = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const amt = (x: number, frac = 4) => x.toLocaleString("en-US", { maximumFractionDigits: frac });

const STATE_TEXT: Record<OptionState, string> = {
  live: "On sale or held, not expired",
  expired: "Expired, waiting for the settlement price",
  paid: "Settled in the money: redeem for the payout",
  worthless: "Settled out of the money: worth nothing",
  cancelled: "Series cancelled",
};

function assetUsd(v: VaultSummary): number {
  return v.isCall ? toNumber(v.spot.price, 18) : 1;
}

async function readPortfolio(
  client: PublicClient,
  vaults: { summary: VaultSummary; history: { seriesIds: bigint[] } | null }[],
  account: `0x${string}`,
): Promise<{ positions: PositionRow[]; options: OptionRow[] }> {
  const positions = await Promise.all(
    vaults.map(async ({ summary: v }): Promise<PositionRow> => {
      const p = await position(client, v.deployment, v, account);
      return {
        vault: v.address,
        symbol: v.symbol,
        version: v.version,
        isCall: v.isCall,
        underlying: v.underlying.symbol,
        shares: toNumber(p.shares, v.decimals),
        assets: toNumber(p.assets, v.asset.decimals),
        assetUsd: assetUsd(v),
        pendingPremium: toNumber(p.pendingPremium, v.usdg.decimals),
        queuedDeposit: toNumber(p.depositRequest.amount, v.asset.decimals),
        queuedRedeemShares: toNumber(p.redeemRequest.amount, v.decimals),
        claimableDepositShares: toNumber(p.claimableDepositShares, v.decimals),
        claimableRedeemAssets: toNumber(p.claimableRedeemAssets, v.asset.decimals),
      };
    }),
  );
  // Options: every series each vault has run, read in one balanceOfBatch per vault's deployment.
  const options = (
    await Promise.all(
      vaults.map(async ({ summary: v, history }) => {
        const ids = history?.seriesIds ?? (v.series ? [v.series.id] : []);
        if (ids.length === 0) return [];
        const held = await optionHoldings(client, v.deployment, ids, account);
        return held.map((h): OptionRow => ({
          seriesId: h.series.id.toString(),
          vault: v.address,
          symbol: v.symbol,
          isCall: h.series.isCall,
          underlying: v.underlying.symbol,
          strike: toNumber(h.series.strike, 18),
          expiry: Number(h.series.expiry),
          balance: toNumber(h.balance, v.underlying.decimals),
          settled: h.series.settled,
          cancelled: h.series.cancelled,
          payoutPerOption: toNumber(h.series.payoutPerOption, v.asset.decimals),
          assetUsd: assetUsd(v),
          spot: toNumber(v.spot.price, 18),
        }));
      }),
    )
  ).flat();
  return { positions, options };
}

/** One wallet across every vault on the selected network. */
export function PortfolioPage() {
  const { client, chainId, meta } = useStrike();
  const { address } = useConnection();
  const vaults = useAllVaults();
  const now = useMarket().data?.now ?? null;
  const q = useQuery({
    queryKey: ["strike", chainId, "portfolio", address, vaults.data?.map((v) => v.summary.address).join(",")],
    enabled: !!client && !!address && !!vaults.data,
    refetchInterval: 30_000,
    queryFn: () => readPortfolio(client!, vaults.data!, address!),
  });
  const held = q.data?.positions.filter(hasPosition) ?? [];
  const totals = q.data ? portfolioTotals(q.data.positions, q.data.options) : null;
  return (
    <>
      <PageHero
        label="Portfolio"
        right={meta.label}
        title="Portfolio"
        lead={
          <p className="lead">
            Your vault shares, the premium waiting for you, queued deposits and withdrawals, and the options
            you hold, across every vault on {meta.label}. Read from the chain for the connected wallet;
            nothing is stored.
          </p>
        }
      />
      {!address ? (
        <div className={`gutter ${styles.prompt}`} data-testid="portfolio-connect">
          <p className="h3">Connect a wallet to see its positions.</p>
          <p className="body">
            The page reads each vault&apos;s <code className="mono">balanceOf</code>,{" "}
            <code className="mono">pendingPremium</code> and queued requests, and the option token&apos;s
            balances, for the address you connect. It sends nothing.
          </p>
          <p className="body">
            <Link href="/app" className="text-link">
              Browse the vaults
            </Link>{" "}
            or{" "}
            <Link href="/app/faucet" className="text-link">
              get test tokens
            </Link>{" "}
            first.
          </p>
        </div>
      ) : (
        <>
          <Gate
            isLoading={vaults.isPending || q.isPending}
            error={vaults.error ?? q.error}
            loading={
              <MetaStripSkeleton
                labels={["Vaults with a position", "Deposits", "Premium to claim", "Options held"]}
              />
            }
          >
            {totals ? (
              <MetaStrip
                cells={[
                  {
                    label: "Vaults with a position",
                    value: String(totals.vaults),
                    sub: `of ${q.data!.positions.length}`,
                  },
                  { label: "Deposits", value: usd(totals.depositsUsd), sub: "at the feed's spot" },
                  {
                    label: "Premium to claim",
                    term: "premium",
                    value: `${amt(totals.premiumToClaim, 6)} USDG`,
                    sub: "claimPremium on each vault",
                  },
                  {
                    label: "Options held",
                    term: "option",
                    value: amt(totals.options),
                    sub:
                      totals.redeemableUsd > 0 ? `${usd(totals.redeemableUsd)} to redeem` : "none to redeem",
                  },
                ]}
              />
            ) : null}
          </Gate>
          {q.data ? (
            <div className={styles.detailBody} data-testid="portfolio">
              <Rail
                index="01"
                id="positions"
                label="Vault positions"
                note="Shares and their value in the vault's asset, the premium you can claim, and requests waiting for the epoch to close."
              >
                {held.length === 0 ? (
                  <p className={styles.hint} data-testid="portfolio-empty">
                    This wallet holds no shares, premium or queued requests in any vault on {meta.label}.
                  </p>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table} aria-label="Vault positions">
                      <thead>
                        <tr>
                          <th scope="col">Vault</th>
                          <th scope="col" className={styles.num}>
                            Shares
                          </th>
                          <th scope="col" className={styles.num}>
                            Worth
                          </th>
                          <th scope="col" className={styles.num}>
                            Premium to claim
                          </th>
                          <th scope="col">Queued or claimable</th>
                        </tr>
                      </thead>
                      <tbody>
                        {held.map((p) => (
                          <tr key={p.vault} data-testid="portfolio-position">
                            <th scope="row">
                              <Link href={`/app/vault/${p.vault}?chain=${chainId}`} className="text-link">
                                {p.symbol}
                                {p.version ? ` (${p.version})` : ""}
                              </Link>
                              <span className={styles.cellMuted}>
                                {p.underlying} {p.isCall ? "covered call" : "cash-secured put"}
                              </span>
                            </th>
                            <td className={`mono ${styles.num}`}>{amt(p.shares)}</td>
                            <td className={`mono ${styles.num}`}>
                              {amt(p.assets)} {p.isCall ? p.underlying : "USDG"}
                              <span className={styles.cellMuted}>{usd(p.assets * p.assetUsd)}</span>
                            </td>
                            <td className={`mono ${styles.num}`}>{amt(p.pendingPremium, 6)} USDG</td>
                            <td>
                              <Requests p={p} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Rail>
              <Rail
                index="02"
                id="options"
                label="Options held"
                note="Every series of these vaults this wallet holds, with where it stands. A settled in-the-money option is redeemed on its vault's page."
              >
                {q.data.options.length === 0 ? (
                  <p className={styles.hint} data-testid="portfolio-no-options">
                    This wallet holds no options from these vaults.
                  </p>
                ) : (
                  <div className={styles.tableWrap}>
                    <table className={styles.table} aria-label="Options held">
                      <thead>
                        <tr>
                          <th scope="col">Series</th>
                          <th scope="col" className={styles.num}>
                            Held
                          </th>
                          <th scope="col" className={styles.num}>
                            Strike
                          </th>
                          <th scope="col">Expiry</th>
                          <th scope="col">State</th>
                          <th scope="col" className={styles.num}>
                            In the money now
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {q.data.options.map((o) => {
                          const st =
                            now === null ? (o.settled ? optionState(o, 0) : "live") : optionState(o, now);
                          return (
                            <tr
                              key={`${o.vault}-${o.seriesId}`}
                              data-testid="portfolio-option"
                              data-state={st}
                            >
                              <th scope="row">
                                <Link href={`/app/vault/${o.vault}?chain=${chainId}`} className="text-link">
                                  {o.underlying} {o.isCall ? "call" : "put"} {usd(o.strike)}
                                </Link>
                                <span className={styles.cellMuted} title={`Series ${o.seriesId}`}>
                                  {o.symbol} · series {o.seriesId.slice(0, 6)}…{o.seriesId.slice(-4)}
                                </span>
                              </th>
                              <td className={`mono ${styles.num}`}>{amt(o.balance)}</td>
                              <td className={`mono ${styles.num}`}>{usd(o.strike)}</td>
                              <td>{fmtNy(BigInt(o.expiry))}</td>
                              <td>{STATE_TEXT[st]}</td>
                              <td className={`mono ${styles.num}`}>
                                {st === "paid"
                                  ? `${amt(o.payoutPerOption * o.balance, 6)} ${o.isCall ? o.underlying : "USDG"} to redeem`
                                  : st === "live" || st === "expired"
                                    ? `${usd(intrinsicNow(o) * o.balance)} at ${usd(o.spot)}`
                                    : "none"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className={styles.hint}>
                  &quot;In the money now&quot; is what exercise would pay at the feed&apos;s current spot, not
                  a market price: these options are European and pay only at the settlement price.
                </p>
              </Rail>
            </div>
          ) : null}
          {address && q.data === undefined && !q.isPending && !q.error ? <Skeleton width="50%" /> : null}
        </>
      )}
    </>
  );
}

function Requests({ p }: { p: PositionRow }) {
  const parts: string[] = [];
  if (p.queuedDeposit > 0)
    parts.push(`deposit of ${amt(p.queuedDeposit)} ${p.isCall ? p.underlying : "USDG"} queued`);
  if (p.queuedRedeemShares > 0) parts.push(`withdrawal of ${amt(p.queuedRedeemShares)} shares queued`);
  if (p.claimableDepositShares > 0) parts.push(`${amt(p.claimableDepositShares)} shares to claim`);
  if (p.claimableRedeemAssets > 0)
    parts.push(`${amt(p.claimableRedeemAssets)} ${p.isCall ? p.underlying : "USDG"} to claim`);
  return parts.length ? <>{parts.join(" · ")}</> : <span className={styles.cellMuted}>none</span>;
}
