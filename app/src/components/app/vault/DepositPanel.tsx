"use client";

import { strikeVaultAbi } from "@strike/sdk";
import { useState } from "react";
import { erc20Abi } from "viem";
import { useConnection } from "wagmi";
import { usePosition } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { fmtAmount, parseAmount } from "@/lib/format";
import type { VaultSummary } from "@/lib/reads";
import { ConnectButton } from "@/components/site/ConnectButton";
import { AmountField } from "../AmountField";
import { TxNote } from "../TxNote";
import styles from "../app.module.css";

type Mode = "deposit" | "withdraw";

export function DepositPanel({ vault }: { vault: VaultSummary }) {
  const [mode, setMode] = useState<Mode>("deposit");
  const [text, setText] = useState("");
  const { address, isConnected } = useConnection();
  const { chainId } = useStrike();
  const pos = usePosition(vault).data;
  const tx = useTx();

  const locked = vault.locked;
  const assetDec = vault.asset.decimals;
  // Queued withdrawals are requested in shares (the price is only known at settlement); everything else in assets.
  const inShares = mode === "withdraw" && locked;
  const decimals = inShares ? vault.decimals : assetDec;
  const amount = parseAmount(text, decimals);

  const capLeft =
    vault.depositCap > vault.totalAssets + vault.pendingDepositAssets
      ? vault.depositCap - vault.totalAssets - vault.pendingDepositAssets
      : 0n;
  const max = !pos
    ? undefined
    : mode === "deposit"
      ? min(pos.assetBalance, locked ? capLeft : pos.maxDeposit)
      : locked
        ? pos.shares
        : pos.maxWithdraw;
  const needsApproval = mode === "deposit" && !!pos && amount !== null && pos.assetAllowance < amount;
  const tooMuch = amount !== null && max !== undefined && amount > max;
  const invalid = amount === null || amount === 0n || tooMuch;

  const verb =
    mode === "deposit" ? (locked ? "Queue deposit" : "Deposit") : locked ? "Queue withdrawal" : "Withdraw";

  async function submit() {
    if (!address || amount === null) return;
    const v = { address: vault.address, abi: strikeVaultAbi, chainId } as const;
    if (needsApproval) {
      const ok = await tx.exec(`Approve ${vault.asset.symbol}`, (w) =>
        w({
          address: vault.asset.address,
          abi: erc20Abi,
          functionName: "approve",
          args: [vault.address, amount],
          chainId,
        }),
      );
      if (!ok) return;
    }
    let ok = false;
    if (mode === "deposit" && !locked)
      ok = await tx.exec(verb, (w) => w({ ...v, functionName: "deposit", args: [amount, address] }));
    if (mode === "deposit" && locked)
      ok = await tx.exec(verb, (w) => w({ ...v, functionName: "requestDeposit", args: [amount, address] }));
    if (mode === "withdraw" && !locked)
      ok = await tx.exec(verb, (w) =>
        w({ ...v, functionName: "withdraw", args: [amount, address, address] }),
      );
    if (mode === "withdraw" && locked)
      ok = await tx.exec(verb, (w) => w({ ...v, functionName: "requestRedeem", args: [amount] }));
    if (ok) setText("");
  }

  const estimate =
    inShares && amount && vault.totalSupply > 0n ? (amount * vault.totalAssets) / vault.totalSupply : null;

  return (
    <div className={styles.panel}>
      <div className={styles.tabs} role="tablist" aria-label="Deposit or withdraw">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            aria-pressed={mode === m}
            className="chip"
            onClick={() => {
              setMode(m);
              setText("");
              tx.reset();
            }}
          >
            {m === "deposit"
              ? locked
                ? "Queue deposit"
                : "Deposit"
              : locked
                ? "Queue withdrawal"
                : "Withdraw"}
          </button>
        ))}
      </div>
      {locked ? (
        <p className={styles.callout}>
          <strong>Locked until settlement.</strong> This week&apos;s options are backed by the vault, so
          nothing moves in or out until the epoch settles. A queued deposit becomes shares at that
          epoch&apos;s closing price; a queued withdrawal pays out at the same price, including that
          week&apos;s premium. Claim either one after settlement.
        </p>
      ) : null}
      <AmountField
        label={inShares ? "Shares to withdraw" : mode === "deposit" ? "Amount" : "Amount to withdraw"}
        value={text}
        onChange={setText}
        unit={inShares ? vault.symbol : vault.asset.symbol}
        decimals={decimals}
        max={max}
        disabled={!isConnected}
      />
      <p className={styles.hint}>
        {inShares && estimate !== null
          ? `≈ ${fmtAmount(estimate, assetDec, 4)} ${vault.asset.symbol} at today's share price, before this week's result.`
          : mode === "deposit"
            ? `Deposit cap left: ${fmtAmount(capLeft, assetDec)} ${vault.asset.symbol}.`
            : "Withdrawals are paid in the vault's asset. Claim premium separately."}
        {tooMuch ? " More than you can move." : ""}
      </p>
      {isConnected ? (
        <button type="button" className="pill" disabled={invalid || tx.busy} onClick={submit}>
          {needsApproval ? `Approve & ${verb.toLowerCase()}` : verb}
        </button>
      ) : (
        <ConnectButton />
      )}
      <TxNote tx={tx} />
    </div>
  );
}

function min(a: bigint, b: bigint) {
  return a < b ? a : b;
}
