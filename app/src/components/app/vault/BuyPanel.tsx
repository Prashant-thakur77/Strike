"use client";

import { epochManagerAbi } from "@strike/sdk";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { erc20Abi } from "viem";
import { useConnection } from "wagmi";
import { useMarket, usePosition } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { fmtAmount, fmtWadUsd, parseAmount, toNumber } from "@/lib/format";
import type { Series, VaultSummary } from "@/lib/reads";
import { fmtMultiplier, hasMultiplier, perSharePrice } from "@/lib/shares";
import { ConnectButton } from "@/components/site/ConnectButton";
import { AmountField } from "../AmountField";
import { TxNote } from "../TxNote";
import styles from "../app.module.css";

const SLIPPAGE = [50, 100, 200] as const;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function BuyPanel({ vault, series }: { vault: VaultSummary; series: Series }) {
  const [text, setText] = useState("1");
  const [slip, setSlip] = useState<number>(100);
  const { client, deployment, chainId } = useStrike();
  const { address, isConnected } = useConnection();
  const market = useMarket().data;
  const pos = usePosition(vault).data;
  const tx = useTx();

  const dec = vault.underlying.decimals;
  const usdgDec = vault.usdg.decimals;
  const amount = parseAmount(useDebounced(text), dec);
  const remaining = series.size - series.sold;

  const quote = useQuery({
    queryKey: ["strike", chainId, "quote", series.id.toString(), amount?.toString()],
    enabled: !!client && !!deployment && amount !== null && amount > 0n,
    refetchInterval: 15_000,
    queryFn: () =>
      client!.readContract({
        address: deployment!.epochManager,
        abi: epochManagerAbi,
        functionName: "quoteBuy",
        args: [series.id, amount!],
      }),
  });
  const premium = quote.data?.[0];
  const maxPremium = premium === undefined ? undefined : premium + (premium * BigInt(slip)) / 10_000n;

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

  return (
    <div className={styles.buy}>
      <h3 className="micro">Buy options</h3>
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
    </div>
  );
}
