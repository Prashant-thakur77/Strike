"use client";

import { fmtNy, toNumber } from "@/lib/format";
import { breakeven } from "@/lib/payoff";
import type { VaultSummary } from "@/lib/reads";
import styles from "../app.module.css";

const num = (x: number, frac = 2) => x.toLocaleString("en-US", { maximumFractionDigits: frac });
const usd = (x: number) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "Your amount this week": both endings of the week for the amount being typed, from the vault's live series (the
 * premium it collected per unit deposited, and the break-even from the same `breakeven` the payoff chart draws).
 * With no series, the mandate's delta band says what kind of week to expect, labelled as a range.
 */
export function YourWeek({ vault, amount }: { vault: VaultSummary; amount: bigint | null }) {
  if (amount === null || amount === 0n) return null;
  const sym = vault.underlying.symbol;
  const a = toNumber(amount, vault.asset.decimals);
  const unit = vault.asset.symbol;
  const s = vault.series && !vault.series.cancelled && !vault.series.settled ? vault.series : null;
  const total = toNumber(vault.totalAssets, vault.asset.decimals);
  const premiumNow = s ? toNumber(s.premium, vault.usdg.decimals) : 0;
  const soldNow = s ? toNumber(s.sold, vault.underlying.decimals) : 0;

  // A queued deposit joins next week's series, so this week's figures are an example, not a promise.
  const label = vault.locked ? "If next week is like this one" : "Your amount this week";

  if (!s || total <= 0) {
    return (
      <div className={styles.yourWeek} data-testid="your-week" data-kind="range">
        <p className="micro micro-muted">{label}</p>
        <p className={styles.yourWeekLine}>
          No option is on sale yet. When the week opens, the agent picks a strike at a{" "}
          <strong>
            delta of {(vault.mandate.minDeltaBps / 10_000).toFixed(2)} to{" "}
            {(vault.mandate.maxDeltaBps / 10_000).toFixed(2)}
          </strong>
          , which the contract enforces: in the model, roughly a {Math.round(vault.mandate.minDeltaBps / 100)}
          % to {Math.round(vault.mandate.maxDeltaBps / 100)}% chance the option ends up being used.
        </p>
        <p className={styles.yourWeekLine}>
          Deposits go in now. Once the week opens, the vault locks until that week&apos;s option settles.
        </p>
      </div>
    );
  }

  const strike = toNumber(s.strike, 18);
  const share = a / (total + (vault.locked ? 0 : a));
  const yourPremium = premiumNow * share;
  const perOption = soldNow > 0 ? premiumNow / soldNow : 0;
  const be = perOption > 0 ? breakeven(s.isCall, strike, perOption) : null;
  const soldPct = vault.isCall && total > 0 ? Math.min(100, (soldNow / total) * 100) : null;
  const expiry = fmtNy(s.expiry);

  return (
    <div className={styles.yourWeek} data-testid="your-week" data-kind="series">
      <p className="micro micro-muted">{label}</p>
      <ul className={styles.yourWeekList}>
        <li data-testid="your-week-good">
          <strong>
            If {sym} closes {vault.isCall ? "at or below" : "at or above"} {usd(strike)}
          </strong>{" "}
          on {expiry}: you keep your {num(a, 4)} {unit} and earn about{" "}
          <strong>{num(yourPremium, 4)} USDG</strong> of premium.
        </li>
        <li data-testid="your-week-bad">
          <strong>
            If it closes {vault.isCall ? "above" : "below"} {usd(strike)}
          </strong>
          :{" "}
          {vault.isCall
            ? `the rise above ${usd(strike)} on the ${soldPct === null ? "" : `${num(soldPct, 0)}% of the vault `}that was sold goes to the option buyers, paid in ${sym}; you keep the premium.`
            : `the vault pays buyers the fall below ${usd(strike)} from its USDG, so you get back less than you put in; the premium makes up part of it.`}
          {be !== null
            ? ` You do better than not selling unless ${sym} closes ${vault.isCall ? "above" : "below"} ${usd(be)}.`
            : ""}
        </li>
        <li>
          {vault.locked
            ? `A deposit now is queued: it joins when this week settles, after ${expiry}, and is locked through the next week.`
            : `Locked from the moment the week opens until its option settles, after ${expiry}.`}
        </li>
      </ul>
      <p className={styles.yourWeekNote}>
        Your share of the {num(premiumNow, 2)} USDG this week&apos;s buyers paid, in proportion to your
        deposit. An estimate from the chain right now, not a promise.
      </p>
    </div>
  );
}
