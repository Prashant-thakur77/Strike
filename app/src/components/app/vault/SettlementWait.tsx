"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { useMarket } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { toNumber } from "@/lib/format";
import { settlementWait } from "@/lib/lifecycle";
import { LINKS } from "@/lib/links";
import { fmtUtc } from "@/lib/marketHours";
import { isMirrorChain } from "@/lib/mirrorAudit";
import type { Series, VaultSummary } from "@/lib/reads";
import { settlementLine, type SettlementAuditJson } from "@/lib/settlementAudit";
import styles from "../app.module.css";

async function getAudit(url: string): Promise<SettlementAuditJson> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as (SettlementAuditJson & { error?: string }) | null;
  if (!res.ok || !body || body.error) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

/**
 * A series past expiry that has not settled: when it expired, what price it will settle at and why that can take a
 * while, the mainnet check of the settlement round (/api/settlement-audit, the same one the epoch trace shows), and
 * that buying is closed. It never shows a settlement price before the contract records one.
 */
export function SettlementWait({ vault, series }: { vault: VaultSummary; series: Series }) {
  const { chainId } = useStrike();
  const market = useMarket().data;
  const mirrored = isMirrorChain(chainId);
  const audit = useQuery({
    queryKey: ["settlement-audit", chainId, vault.address, "wait", series.id.toString()],
    queryFn: () => getAudit(`/api/settlement-audit?chain=${chainId}&vault=${vault.address}`),
    enabled: mirrored && series.sold > 0n,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const check = audit.data?.series.find((x) => x.seriesId === series.id.toString()) ?? null;
  const w = settlementWait({
    symbol: vault.underlying.symbol,
    expiry: Number(series.expiry),
    sold: series.sold,
    lastPrintAt: vault.spot.updatedAt > 0n ? Number(vault.spot.updatedAt) : null,
    lastPrice: vault.spot.price > 0n ? toNumber(vault.spot.price, 18) : null,
    mirrored,
    reopensAt: market && !market.open ? market.opensAt : null,
    saleCutoff: market?.saleCutoff ?? null,
    fmt: fmtUtc,
  });

  return (
    <section
      className={styles.settleWait}
      aria-label="Waiting for settlement"
      data-testid="settlement-wait"
      data-printed={check ? check.status : undefined}
    >
      <p className="h3" data-testid="settlement-wait-headline">
        {w.headline}
      </p>
      <p className="body">{w.rule}</p>
      {w.lastPrint ? (
        <p className="body" data-testid="settlement-wait-last">
          {w.lastPrint}
        </p>
      ) : null}
      {w.why ? <p className={styles.hint}>{w.why}</p> : null}
      {check ? (
        <p className={styles.hint} data-testid="settlement-wait-audit">
          Mainnet check: {settlementLine(check).text}
        </p>
      ) : null}
      <p className="body" data-testid="settlement-wait-buying">
        <strong>{w.buying}</strong>
      </p>
      <p className={`micro ${styles.settleWaitLinks}`}>
        <a href={LINKS.trustModel} target="_blank" rel="noreferrer" className="text-link">
          Trust model: the settlement price <ArrowUpRight size={12} aria-hidden />
        </a>
        <a href={LINKS.settlementWait} target="_blank" rel="noreferrer" className="text-link">
          Runbook: waiting for the first print after expiry <ArrowUpRight size={12} aria-hidden />
        </a>
      </p>
    </section>
  );
}
