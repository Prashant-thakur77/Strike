"use client";

import Link from "next/link";
import { ArrowUpRight, RotateCw } from "lucide-react";
import { agoText, fmtCount, fmtOptions, fmtUsdg } from "@/lib/usage/aggregate";
import { Skeleton } from "../Skeleton";
import { useMinuteClock, useUsage } from "./useUsage";
import styles from "./usage.module.css";

/**
 * One line of testnet usage for the landing page's live section: wallets (and how many are outside the team),
 * epochs, proposals, options, slashes and decision records, counted from every deployment's logs by /api/stats.
 */
export function UsageStrip() {
  const q = useUsage();
  const now = useMinuteClock();
  const s = q.data;
  const t = s?.total;
  const num = (value: string | undefined, stat: string) => (
    <strong className={styles.stripNum} data-stat={stat}>
      {value ?? <Skeleton width="1.6em" />}
    </strong>
  );

  if (q.isError && !s) {
    return (
      <div className={styles.strip} data-testid="usage-strip" data-state="error" role="status">
        <p className={styles.stripText}>
          <span className="micro micro-muted">On testnet so far</span> Couldn&apos;t count the testnet
          activity right now.{" "}
          <button type="button" className="pill pill-small pill-ghost" onClick={() => q.refetch()}>
            Try again <RotateCw aria-hidden />
          </button>
        </p>
      </div>
    );
  }

  return (
    <div
      className={styles.strip}
      data-testid="usage-strip"
      data-state={s ? "ready" : "loading"}
      aria-busy={!s || undefined}
    >
      <p className={`micro micro-muted ${styles.stripLabel}`}>On testnet so far</p>
      <ul className={styles.stripList} aria-label="Testnet usage, all deployments">
        <li>
          {num(t && fmtCount(t.wallets), "wallets")} wallets{" "}
          <span className={styles.stripAside}>
            ({num(t && fmtCount(t.outsideWallets), "outside")} outside the team)
          </span>
        </li>
        <li>{num(t && fmtCount(t.epochsOpened), "epochs")} vault epochs</li>
        <li>
          {num(t && fmtCount(t.proposalsAccepted), "accepted")} proposals accepted,{" "}
          {num(t && fmtCount(t.proposalsRejected), "rejected")} rejected
        </li>
        <li>{num(t && fmtOptions(t.optionsBought), "options")} options bought</li>
        <li>{num(t && fmtUsdg(t.slashedUsdg), "slashed")} USDG slashed to depositors</li>
        <li>{num(t && fmtCount(t.decisionRecords), "records")} decision records anchored</li>
      </ul>
      <p className={`micro micro-muted ${styles.stripFoot}`}>
        <span>
          Counted from contract logs on {s ? s.deployments.length : "every"} deployments, Robinhood Chain
          testnet and Arbitrum Sepolia
          {s ? ` · updated ${agoText(s.generatedAt, now)}` : ""}
        </span>
        <Link href="/app/proof#usage" className="text-link">
          Per chain, with sources <ArrowUpRight size={12} aria-hidden />
        </Link>
      </p>
    </div>
  );
}
