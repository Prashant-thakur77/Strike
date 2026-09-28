"use client";

import { strikeVaultAbi } from "@strike/sdk";
import { useConnection } from "wagmi";
import { usePosition } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { fmtAmount, fmtUsd, toNumber, usdValue } from "@/lib/format";
import type { VaultSummary } from "@/lib/reads";
import { ConnectButton } from "@/components/site/ConnectButton";
import { Skeleton } from "../Skeleton";
import { TxNote } from "../TxNote";
import styles from "../app.module.css";

export function PositionPanel({ vault }: { vault: VaultSummary }) {
  const { address, isConnected } = useConnection();
  const { chainId } = useStrike();
  const pos = usePosition(vault);
  const tx = useTx();

  if (!isConnected || !address) {
    return (
      <div className={styles.prompt}>
        <p className="body">Connect a wallet to see your shares, premium and queued requests.</p>
        <ConnectButton />
      </div>
    );
  }
  const p = pos.data;
  const dec = vault.asset.decimals;
  const valueUsd =
    p &&
    (vault.isCall
      ? vault.spot.price > 0n
        ? usdValue(p.assets, dec, vault.spot.price)
        : null
      : toNumber(p.assets, dec));
  const depositPending =
    !!p && p.depositRequest.amount > 0n && p.depositRequest.epoch > vault.lastProcessedEpoch;
  const depositReady =
    !!p && p.depositRequest.amount > 0n && p.depositRequest.epoch <= vault.lastProcessedEpoch;
  const redeemPending =
    !!p && p.redeemRequest.amount > 0n && p.redeemRequest.epoch > vault.lastProcessedEpoch;
  const redeemReady = !!p && p.redeemRequest.amount > 0n && p.redeemRequest.epoch <= vault.lastProcessedEpoch;
  const v = { address: vault.address, abi: strikeVaultAbi, chainId } as const;

  return (
    <div className={styles.panel}>
      <div className={styles.cells}>
        <Cell label="Shares" value={p ? fmtAmount(p.shares, vault.decimals, 4) : null} sub={vault.symbol} />
        <Cell
          label="Value"
          value={p ? `${fmtAmount(p.assets, dec, 4)} ${vault.asset.symbol}` : null}
          sub={valueUsd !== null && valueUsd !== undefined ? `≈ ${fmtUsd(valueUsd, 2)}` : undefined}
        />
        <Cell
          label="Premium to claim"
          value={p ? `${fmtAmount(p.pendingPremium, vault.usdg.decimals)} USDG` : null}
        >
          <button
            type="button"
            className="pill pill-small"
            disabled={!p || p.pendingPremium === 0n || tx.busy}
            onClick={() => tx.exec("Claim premium", (w) => w({ ...v, functionName: "claimPremium" }))}
          >
            Claim
          </button>
        </Cell>
        <Cell
          label="Queued deposit"
          value={
            !p
              ? null
              : depositReady
                ? `${fmtAmount(p.claimableDepositShares, vault.decimals, 4)} shares ready`
                : depositPending
                  ? `${fmtAmount(p.depositRequest.amount, dec, 4)} ${vault.asset.symbol}`
                  : "None"
          }
          sub={
            depositPending ? `Processed when epoch ${p?.depositRequest.epoch.toString()} settles` : undefined
          }
        >
          {depositReady ? (
            <button
              type="button"
              className="pill pill-small"
              disabled={tx.busy}
              onClick={() =>
                tx.exec("Claim shares", (w) => w({ ...v, functionName: "claimDeposit", args: [address] }))
              }
            >
              Claim shares
            </button>
          ) : depositPending ? (
            <button
              type="button"
              className="pill pill-small pill-ghost"
              disabled={tx.busy}
              onClick={() =>
                tx.exec("Cancel deposit", (w) => w({ ...v, functionName: "cancelDepositRequest" }))
              }
            >
              Cancel
            </button>
          ) : null}
        </Cell>
        <Cell
          label="Queued withdrawal"
          value={
            !p
              ? null
              : redeemReady
                ? `${fmtAmount(p.claimableRedeemAssets, dec, 4)} ${vault.asset.symbol} ready`
                : redeemPending
                  ? `${fmtAmount(p.redeemRequest.amount, vault.decimals, 4)} shares`
                  : "None"
          }
          sub={
            redeemPending ? `Processed when epoch ${p?.redeemRequest.epoch.toString()} settles` : undefined
          }
        >
          {redeemReady ? (
            <button
              type="button"
              className="pill pill-small"
              disabled={tx.busy}
              onClick={() =>
                tx.exec("Claim withdrawal", (w) => w({ ...v, functionName: "claimRedeem", args: [address] }))
              }
            >
              Claim
            </button>
          ) : null}
        </Cell>
        <Cell
          label="Wallet"
          value={p ? `${fmtAmount(p.assetBalance, dec, 4)} ${vault.asset.symbol}` : null}
          sub={p ? `${fmtAmount(p.usdgBalance, vault.usdg.decimals)} USDG` : undefined}
        />
      </div>
      <TxNote tx={tx} />
    </div>
  );
}

function Cell({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: string | null;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.cell}>
      <span className="micro micro-muted">{label}</span>
      <span className={styles.cellValue}>{value ?? <Skeleton width="5em" />}</span>
      {sub ? <span className={styles.cellSub}>{sub}</span> : null}
      {children ? <div className={styles.cellAction}>{children}</div> : null}
    </div>
  );
}
