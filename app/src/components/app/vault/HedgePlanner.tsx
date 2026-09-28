"use client";

import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { formatUnits } from "viem";
import { useConnection } from "wagmi";
import { useAffordable, usePosition, useQuoteBuy, useTokenBalance } from "@/hooks/queries";
import { useDebounced } from "@/hooks/useDebounced";
import { fmtAmount, fmtDollars, fmtPct, fmtWadUsd, parseAmount } from "@/lib/format";
import {
  optionStep,
  protectOutcome,
  protectPlan,
  quoteBudget,
  upsideOutcome,
  withSlippage,
} from "@/lib/hedge";
import type { Series, VaultSummary } from "@/lib/reads";
import { fmtMultiplier, hasMultiplier, perSharePrice, sharesOf } from "@/lib/shares";
import { AmountField } from "../AmountField";
import styles from "../app.module.css";

// The buy panel's two sizing helpers. Each one works out an option amount and hands it back through `onUse`,
// which fills the plain amount field; buying always goes through that field.

interface PlannerProps {
  vault: VaultSummary;
  series: Series;
  /** Options the series has left (underlying base units). */
  remaining: bigint;
  /** Why buying is blocked right now (market closed, sales over), or null. */
  blocked: string | null;
  /** The field's text, or null while the user hasn't typed (a default is shown). */
  value: string | null;
  onChange: (v: string) => void;
  onUse: (options: bigint) => void;
}

function Cell({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode[] }) {
  return (
    <div>
      <dt className="micro micro-muted">{label}</dt>
      <dd className="mono">{value}</dd>
      {sub?.filter(Boolean).map((s, i) => (
        <dd key={i} className="micro micro-muted">
          {s}
        </dd>
      ))}
    </div>
  );
}

function UseButton({ options, onUse }: { options: bigint | null; onUse: (options: bigint) => void }) {
  return (
    <button
      type="button"
      className="pill"
      disabled={options === null || options === 0n}
      onClick={() => options && onUse(options)}
    >
      Use this amount <ArrowRight aria-hidden />
    </button>
  );
}

/** Puts: how many options cover the stock tokens you hold, and what the position is worth at worst. */
export function ProtectPlanner({ vault, series, remaining, blocked, value, onChange, onUse }: PlannerProps) {
  const { isConnected } = useConnection();
  const dec = vault.underlying.decimals;
  const usdgDec = vault.usdg.decimals;
  const sym = vault.underlying.symbol;
  const m = vault.multiplier;
  const scaled = hasMultiplier(m);
  const balance = useTokenBalance(vault.underlying.address).data;

  // Until the user types, the field holds their wallet balance of the stock token.
  const shown =
    value ?? (isConnected && balance !== undefined && balance > 0n ? formatUnits(balance, dec) : "");
  const held = parseAmount(useDebounced(shown), dec);
  const plan = held !== null && held > 0n ? protectPlan(held, remaining) : null;
  const options = plan && plan.options > 0n ? plan.options : null;
  const quote = useQuoteBuy(series.id, options);
  const premium = options ? quote.data : undefined;
  const out =
    plan && premium !== undefined && vault.spot.price > 0n
      ? protectOutcome({
          held: held!,
          options: plan.options,
          premium,
          spot: vault.spot.price,
          strike: series.strike,
          tokenDecimals: dec,
          usdDecimals: usdgDec,
        })
      : null;
  const wait = options && quote.isFetching ? "…" : "—";

  return (
    <>
      <div className={styles.hedgeField}>
        <AmountField
          label={`${sym} tokens you hold`}
          value={shown}
          onChange={onChange}
          unit={sym}
          decimals={dec}
          max={isConnected ? balance : undefined}
          maxLabel="Wallet"
        />
        {scaled && held ? (
          <p className="micro micro-muted">
            {fmtAmount(held, dec, 4)} tokens = {fmtAmount(sharesOf(held, m), dec, 4)} shares · multiplier{" "}
            {fmtMultiplier(m)}
          </p>
        ) : null}
      </div>
      <dl className={styles.hedgeGrid}>
        <Cell
          label="Options needed"
          value={plan ? `${fmtAmount(plan.options, dec, 4)} puts` : "—"}
          sub={[plan?.capped ? `Capped: ${fmtAmount(remaining, dec)} left` : "One put per token held"]}
        />
        <Cell
          label="Premium"
          value={premium !== undefined ? `${fmtAmount(premium, usdgDec)} USDG` : wait}
          sub={["Quoted now, before slippage"]}
        />
        <Cell
          label="Cost of protection"
          value={out ? fmtPct(out.costRatio, 2) : "—"}
          sub={[out ? `of ${fmtDollars(out.positionValue, usdgDec)} today` : "of today's value"]}
        />
        <Cell
          label={scaled ? "Protected price per token" : "Protected price"}
          value={fmtWadUsd(series.strike)}
          sub={[
            scaled
              ? `${fmtWadUsd(perSharePrice(series.strike, m))} per share · multiplier ${fmtMultiplier(m)}`
              : "The strike",
          ]}
        />
        <Cell
          label="Worst case at expiry"
          value={out ? fmtDollars(out.worstCase, usdgDec) : "—"}
          sub={[
            plan
              ? `${fmtAmount(plan.options, dec, 4)} × ${fmtWadUsd(series.strike)} − premium`
              : "Tokens × strike − premium",
          ]}
        />
        <Cell
          label="Max loss vs today"
          value={out ? fmtDollars(out.maxLoss, usdgDec) : "—"}
          sub={[out ? `${fmtPct(out.maxLossRatio, 2)} of today's value` : "Today's value − worst case"]}
        />
      </dl>
      {plan?.capped ? (
        <p className={styles.callout}>
          {remaining > 0n ? (
            <>
              <strong>Capped at what&apos;s left.</strong> The series has {fmtAmount(remaining, dec)} options
              left, so this covers {fmtAmount(plan.options, dec, 4)} of your {fmtAmount(held!, dec, 4)} {sym}.
              The other {fmtAmount(plan.uncovered, dec, 4)} stay unprotected, and the worst case counts them
              at zero.
            </>
          ) : (
            <>
              <strong>Sold out.</strong> This series has no options left to buy.
            </>
          )}
        </p>
      ) : null}
      <p className={styles.hint}>
        {blocked ??
          `${isConnected ? "" : `Connect a wallet to fill in your ${sym} balance. `}Each put pays (K − S) USDG if ${sym} settles below the strike, so the tokens it covers are worth at least the strike at expiry, less the premium.`}
      </p>
      <UseButton options={options} onUse={onUse} />
    </>
  );
}

/** Calls: how many options a USDG budget buys, where they break even, and what they pay if the stock rallies. */
export function UpsidePlanner({
  vault,
  series,
  remaining,
  blocked,
  value,
  onChange,
  onUse,
  slip,
  slippage,
}: PlannerProps & { slip: number; slippage: ReactNode }) {
  const dec = vault.underlying.decimals;
  const usdgDec = vault.usdg.decimals;
  const sym = vault.underlying.symbol;
  const m = vault.multiplier;
  const scaled = hasMultiplier(m);
  const pos = usePosition(vault).data;

  const shown = value ?? "100";
  const budget = parseAmount(useDebounced(shown), usdgDec);
  // Size so that the premium plus the slippage allowance (the buy's maxPremium) never exceeds the budget.
  const quoteCap = budget !== null ? quoteBudget(budget, slip) : null;
  const afford = useAffordable(series.id, quoteCap, remaining, optionStep(dec));
  const a = budget && budget > 0n ? afford.data : undefined;
  const bought = a && a.options > 0n ? a : null;
  const out = bought
    ? upsideOutcome({
        options: bought.options,
        premium: bought.premium,
        strike: series.strike,
        tokenDecimals: dec,
        usdDecimals: usdgDec,
      })
    : null;
  const maxPay = bought ? withSlippage(bought.premium, slip) : undefined;
  const wait = budget && afford.isFetching ? "…" : "—";
  const tooSmall = !!a && a.options === 0n;
  const noFunds = !!pos && budget !== null && budget > pos.usdgBalance;

  return (
    <>
      <AmountField
        label="Budget: the most you want to spend"
        value={shown}
        onChange={onChange}
        unit="USDG"
        decimals={usdgDec}
        max={pos?.usdgBalance}
        maxLabel="Wallet"
      />
      <dl className={styles.hedgeGrid}>
        <Cell
          label="Options affordable"
          value={a ? `${fmtAmount(a.options, dec, 4)} calls` : wait}
          sub={[
            a?.capped
              ? `Capped: all ${fmtAmount(remaining, dec)} left`
              : `of ${fmtAmount(remaining, dec)} left`,
          ]}
        />
        <Cell
          label="You pay"
          value={bought ? `${fmtAmount(bought.premium, usdgDec)} USDG` : wait}
          sub={["Confirmed with a fresh quote"]}
        />
        <Cell
          label={scaled ? "Breakeven per token" : "Breakeven at expiry"}
          value={out ? fmtWadUsd(out.breakeven) : "—"}
          sub={[
            out
              ? `${fmtWadUsd(series.strike)} strike + ${fmtWadUsd(out.premiumPerOption)} per option`
              : "Strike + premium per option",
            out && scaled ? `${fmtWadUsd(perSharePrice(out.breakeven, m))} per share` : null,
          ]}
        />
        <Cell
          label="Max loss"
          value={maxPay !== undefined ? `${fmtAmount(maxPay, usdgDec)} USDG` : "—"}
          sub={[`Premium + ${slip / 100}% slippage, within budget`]}
        />
        <Cell
          label="Payout 10% above breakeven"
          value={out ? `${fmtAmount(out.payoutTokens, dec, 4)} ${sym}` : "—"}
          sub={[
            out
              ? `${fmtDollars(out.payoutUsd, usdgDec)} if ${sym} settles at ${fmtWadUsd(out.target)}`
              : `Paid in ${sym}`,
          ]}
        />
        <Cell
          label="Profit at that price"
          value={out ? fmtDollars(out.profit, usdgDec) : "—"}
          sub={["Payout − premium"]}
        />
      </dl>
      {slippage}
      <p className={styles.hint}>
        {blocked ??
          `${noFunds ? "More than the USDG in your wallet. " : ""}${tooSmall ? "That budget is too small for any options. " : ""}Each call pays (S − K) / S ${sym} if ${sym} settles above the strike, worth S − K in dollars. If it settles at or below the strike you lose the premium, and never more than your budget.`}
      </p>
      <UseButton options={bought ? bought.options : null} onUse={onUse} />
    </>
  );
}
