"use client";

import Link from "next/link";
import { ArrowRight, BadgeCheck, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useMarket } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { useWhyStrike } from "@/hooks/useWhyStrike";
import { fmtDeltaBps, fmtFactor, fmtPrice } from "@/lib/agentLog";
import { decisionPath } from "@/lib/decision";
import { fmtNy, fmtWadUsd, toNumber } from "@/lib/format";
import { FEED_STATUS } from "@/lib/labels";
import { clockNow, seriesPhase } from "@/lib/lifecycle";
import type { VaultSummary } from "@/lib/reads";
import styles from "../app.module.css";

/**
 * "This week's call" in five plain lines, built from the anchored decision record and the chain (no language model,
 * so nothing is made up): what was sold, why, the headroom left under the mandate, the market, and what it means
 * for a depositor. The full reasoning is one link away on the decision page.
 */
export function ThisWeekCall({ vault }: { vault: VaultSummary }) {
  const why = useWhyStrike(vault);
  const market = useMarket().data;
  const { chainId } = useStrike();
  const now = clockNow(market?.now);
  const phase = seriesPhase(vault, now);
  const s = vault.series;
  const sym = vault.underlying.symbol;
  const m = vault.mandate;
  const rec = why.data?.kind === "record" ? why.data : null;
  const d = rec?.record.decision ?? null;
  const delta =
    d?.targetDeltaBps ?? (rec?.record.dryRun?.delta != null ? rec.record.dryRun.delta * 10_000 : null);
  const premiumBps = d?.premiumBps ?? rec?.record.dryRun?.premiumBps ?? null;
  const verified = rec?.anchor.status === "match";

  const lines: { k: string; v: ReactNode }[] = [];
  if (s && (phase === "selling" || phase === "expired")) {
    const sold = toNumber(s.sold, vault.underlying.decimals);
    lines.push({
      k: "What",
      v: `${phase === "expired" ? "Sold" : "Selling"} ${sold.toLocaleString("en-US", { maximumFractionDigits: 4 })} of ${toNumber(s.size, vault.underlying.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${sym} ${s.isCall ? "calls" : "puts"} at a ${fmtWadUsd(s.strike)} strike, expiring ${fmtNy(s.expiry)}.`,
    });
  } else if (phase === "open") {
    lines.push({ k: "What", v: "This week is open: the agent has not proposed a strike yet." });
  } else {
    lines.push({
      k: "What",
      v: "Between weeks: nothing is being sold. The next option is listed when a week opens.",
    });
  }
  if (delta !== null) {
    lines.push({
      k: "Why",
      v: (
        <>
          The agent aimed at a {fmtDeltaBps(delta)} delta, inside the {fmtDeltaBps(m.minDeltaBps)} to{" "}
          {fmtDeltaBps(m.maxDeltaBps)} band
          {premiumBps !== null
            ? `, and asked ${fmtFactor(premiumBps)} of fair value where the rule is at least ${fmtFactor(m.minPremiumBps)}`
            : ""}
          .
        </>
      ),
    });
    lines.push({
      k: "Headroom",
      v: `${fmtDeltaBps(Math.max(0, m.maxDeltaBps - delta))} delta below the most the contract allows (${fmtDeltaBps(m.maxDeltaBps)}); a proposal past it is rejected and the agent loses part of its bond.`,
    });
  } else {
    lines.push({
      k: "Rules",
      v: `The contract only accepts a delta from ${fmtDeltaBps(m.minDeltaBps)} to ${fmtDeltaBps(m.maxDeltaBps)} at no less than ${fmtFactor(m.minPremiumBps)} of fair value; anything else is rejected and the agent loses part of its bond.`,
    });
  }
  lines.push({
    k: "Market",
    v: `${sym} at ${vault.spot.price > 0n ? fmtWadUsd(vault.spot.price) : "no price yet"}, price feed ${(FEED_STATUS[vault.spot.status] ?? "unknown").toLowerCase()}${market ? `, US market ${market.open ? "open" : "closed"}` : ""}${rec?.record.market?.spot ? `; ${fmtPrice(rec.record.market.spot)} when the agent decided` : ""}.`,
  });
  lines.push({
    k: "For you",
    v:
      s && (phase === "selling" || phase === "expired")
        ? vault.isCall
          ? `You earn the premium. If ${sym} closes above ${fmtWadUsd(s.strike)}, the rise above it on the part sold goes to the buyers.`
          : `You earn the premium. If ${sym} closes below ${fmtWadUsd(s.strike)}, the vault pays buyers the difference from its USDG.`
        : "Deposits made now join the next week's option and earn its premium.",
  });

  return (
    <div className={styles.callCard} data-testid="week-call" data-verified={verified || undefined}>
      <dl className={styles.callLines}>
        {lines.map((l) => (
          <div key={l.k} className={styles.callLine}>
            <dt className="micro micro-muted">{l.k}</dt>
            <dd>{l.v}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.callFoot}>
        {rec ? (
          <>
            <span className={styles.callCheck} data-ok={verified} data-testid="week-call-anchor">
              {verified ? <BadgeCheck size={15} aria-hidden /> : <CircleAlert size={15} aria-hidden />}
              {verified
                ? "From the agent's record, its hash checked against the on-chain anchor"
                : "From the agent's record; the on-chain hash check did not match yet"}
            </span>
            <Link href={decisionPath(chainId, rec.name)} className="text-link" data-testid="week-call-link">
              Full decision <ArrowRight size={13} aria-hidden />
            </Link>
          </>
        ) : (
          <span className={styles.callCheck}>
            {why.isPending
              ? "Looking for the agent's record…"
              : "Read from the chain; no decision record for this week."}
          </span>
        )}
        <a href="#why" className="text-link">
          Why this strike, in detail
        </a>
      </div>
    </div>
  );
}
