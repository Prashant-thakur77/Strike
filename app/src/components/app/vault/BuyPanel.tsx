"use client";

import { epochManagerAbi } from "@strike/sdk";
import { useState } from "react";
import { erc20Abi, formatUnits } from "viem";
import { useConnection } from "wagmi";
import { useMarket, usePosition, useQuoteBuy } from "@/hooks/queries";
import { useDebounced } from "@/hooks/useDebounced";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { fmtAmount, fmtWadUsd, parseAmount, toNumber } from "@/lib/format";
import { withSlippage } from "@/lib/hedge";
import type { Series, VaultSummary } from "@/lib/reads";
import { fmtMultiplier, hasMultiplier, perSharePrice } from "@/lib/shares";
import { ConnectButton } from "@/components/site/ConnectButton";
import { AmountField } from "../AmountField";
import { TxNote } from "../TxNote";
import { ProtectPlanner, UpsidePlanner } from "./HedgePlanner";
import styles from "../app.module.css";

const SLIPPAGE = [50, 100, 200] as const;

/** "amount": the expert mode, a raw option amount. "hedge": size the buy from a position (puts) or a budget (calls). */
type Mode = "amount" | "hedge";

export function BuyPanel({ vault, series }: { vault: VaultSummary; series: Series }) {
  const [mode, setMode] = useState<Mode>("amount");
  const [text, setText] = useState("1");
  const [hedgeText, setHedgeText] = useState<string | null>(null);
  const [slip, setSlip] = useState<number>(100);
  const { deployment, chainId } = useStrike();
  const { address, isConnected } = useConnection();
  const market = useMarket().data;
  const pos = usePosition(vault).data;
  const tx = useTx();

  const dec = vault.underlying.decimals;
  const usdgDec = vault.usdg.decimals;
  const amount = parseAmount(useDebounced(text), dec);
  const remaining = series.size - series.sold;

  const quote = useQuoteBuy(series.id, amount);
  const premium = quote.data;
  const maxPremium = premium === undefined ? undefined : withSlippage(premium, slip);

  const saleOpen = market ? market.now + market.saleCutoff < Number(series.expiry) : true;
  const blocked = !market
    ? null
    : !market.open
      ? "The US market is closed. Options sell during NYSE hours only."
      : !saleOpen
        ? "Sales have closed for this series (they stop an hour before expiry)."
        : null;
  const overSize = amount !== null && amount > remaining;
  const noFunds = !!pos && maxPremium !== undefined && pos.usdgBalance < maxPremium;
  const needsApproval = !!pos && maxPremium !== undefined && pos.usdgAllowance < maxPremium;
  const disabled =
    !amount || amount === 0n || overSize || !!blocked || noFunds || maxPremium === undefined || tx.busy;

  async function buy() {
    if (!address || !amount || maxPremium === undefined || !deployment) return;
    if (needsApproval) {
      const ok = await tx.exec("Approve USDG", (w) =>
        w({
          address: deployment.usdg,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployment.epochManager, maxPremium],
          chainId,
        }),
      );
      if (!ok) return;
    }
    const ok = await tx.exec("Buy options", (w) =>
      w({
        address: deployment.epochManager,
        abi: epochManagerAbi,
        functionName: "buy",
        args: [series.id, amount, maxPremium, address],
        chainId,
      }),
    );
    if (ok) setText("");
  }

  const perOption =
    premium !== undefined && amount ? toNumber(premium, usdgDec) / toNumber(amount, dec) : null;
  // One option is written on one raw token; with an ERC-8056 multiplier that token is not exactly one share.
  const scaled = hasMultiplier(vault.multiplier);
  const sym = vault.underlying.symbol;

  function fillAmount(options: bigint) {
    setText(formatUnits(options, dec));
    setMode("amount");
    tx.reset();
  }

  const slippage = (
    <div className={styles.slip} role="group" aria-label="Slippage">
      <span className="micro micro-muted">Slippage</span>
      {SLIPPAGE.map((bps) => (
        <button
          key={bps}
          type="button"
          className="chip"
          aria-pressed={slip === bps}
          onClick={() => setSlip(bps)}
        >
          {bps / 100}%
        </button>
      ))}
    </div>
  );

  const planner = {
    vault,
    series,
    remaining,
    blocked,
    value: hedgeText,
    onChange: setHedgeText,
    onUse: fillAmount,
  };

  return (
    <div className={styles.buy}>
      <div className={styles.buyHead}>
        <h3 className="micro">Buy options</h3>
        <div className={styles.tabs} role="tablist" aria-label="How to size the buy">
          {(["amount", "hedge"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              aria-pressed={mode === m}
              className="chip"
              onClick={() => setMode(m)}
            >
              {m === "amount" ? "Amount" : series.isCall ? "Upside for a budget" : "Protect my position"}
            </button>
          ))}
        </div>
      </div>
      {mode === "hedge" ? (
        series.isCall ? (
          <UpsidePlanner {...planner} slip={slip} slippage={slippage} />
        ) : (
          <ProtectPlanner {...planner} />
        )
      ) : (
        <>
          <AmountField
            label={
              scaled
                ? `Options (1 = one ${sym} token = ${fmtMultiplier(vault.multiplier)} shares)`
                : `Options (1 = one ${sym})`
            }
            value={text}
            onChange={setText}
            unit={series.isCall ? "Calls" : "Puts"}
            decimals={dec}
            max={remaining}
            maxLabel="Left"
          />
          <dl className={styles.quote}>
            <div>
              <dt className="micro micro-muted">You pay</dt>
              <dd className="mono">
                {premium !== undefined ? `${fmtAmount(premium, usdgDec)} USDG` : quote.isFetching ? "…" : "—"}
              </dd>
            </div>
            <div>
              <dt className="micro micro-muted">Per option</dt>
              <dd className="mono">{perOption !== null ? `${perOption.toFixed(4)} USDG` : "—"}</dd>
            </div>
            <div>
              <dt className="micro micro-muted">Max with slippage</dt>
              <dd className="mono">
                {maxPremium !== undefined ? `${fmtAmount(maxPremium, usdgDec)} USDG` : "—"}
              </dd>
            </div>
            {scaled ? (
              <div>
                <dt className="micro micro-muted">Strike per share</dt>
                <dd className="mono">{fmtWadUsd(perSharePrice(series.strike, vault.multiplier))}</dd>
                <dd className="micro micro-muted">
                  {fmtWadUsd(series.strike)} per token · multiplier {fmtMultiplier(vault.multiplier)}
                </dd>
              </div>
            ) : null}
          </dl>
          {slippage}
          {blocked || overSize || noFunds ? (
            <p className={styles.hint}>
              {blocked ??
                (overSize ? "More than the options left in this series." : "Not enough USDG in your wallet.")}
            </p>
          ) : (
            <p className={styles.hint}>
              {series.isCall
                ? `Pays (S − K) / S ${vault.underlying.symbol} per option if ${vault.underlying.symbol} settles above the strike.`
                : "Pays (K − S) USDG per option if the stock settles below the strike."}{" "}
              Your loss is capped at the premium.
            </p>
          )}
          {isConnected ? (
            <button type="button" className="pill" disabled={disabled} onClick={buy}>
              {needsApproval ? "Approve USDG & buy" : "Buy"}
            </button>
          ) : (
            <ConnectButton />
          )}
          <TxNote tx={tx} />
        </>
      )}
    </div>
  );
}
