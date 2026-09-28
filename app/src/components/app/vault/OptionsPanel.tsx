"use client";

import { epochManagerAbi } from "@strike/sdk";
import { useConnection } from "wagmi";
import { useOptionHoldings } from "@/hooks/queries";
import { useStrike } from "@/hooks/useStrike";
import { useTx } from "@/hooks/useTx";
import { fmtAmount, fmtNy, fmtWadUsd, toNumber } from "@/lib/format";
import type { OptionHolding, VaultSummary } from "@/lib/reads";
import { ConnectButton } from "@/components/site/ConnectButton";
import { PerShare } from "../PerShare";
import { Skeleton } from "../Skeleton";
import { TxNote } from "../TxNote";
import styles from "../app.module.css";

function payout(h: OptionHolding, vault: VaultSummary): string {
  const s = h.series;
  if (s.cancelled)
    return `${fmtAmount((h.balance * s.premium) / (s.sold || 1n), vault.usdg.decimals)} USDG refund`;
  if (!s.settled) return "At expiry";
  if (s.payoutPerOption === 0n) return "0 · expired worthless";
  if (s.isCall)
    return `${fmtAmount((h.balance * s.payoutPerOption) / 10n ** 18n, vault.underlying.decimals, 4)} ${vault.underlying.symbol}`;
  const usd = toNumber(h.balance, vault.underlying.decimals) * toNumber(s.payoutPerOption, 18);
  return `${usd.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDG`;
}

export function OptionsPanel({ vault, seriesIds }: { vault: VaultSummary; seriesIds: bigint[] | undefined }) {
  const { isConnected, address } = useConnection();
  const { deployment, chainId } = useStrike();
  const holdings = useOptionHoldings(seriesIds);
  const tx = useTx();

  if (!isConnected || !address) {
    return (
      <div className={styles.prompt}>
        <p className="body">Connect a wallet to see the options you hold.</p>
        <ConnectButton />
      </div>
    );
  }
  if (!holdings.data) return <Skeleton width="50%" />;
  if (holdings.data.length === 0) return <p className="body">You hold no options from this vault.</p>;

  return (
    <div className={styles.panel}>
      <ul className={styles.holdings}>
        {holdings.data.map((h) => {
          const s = h.series;
          const final = s.settled || s.cancelled;
          return (
            <li key={s.id.toString()} className={styles.holding}>
              <div>
                <strong className="h3">
                  {vault.underlying.symbol} {fmtWadUsd(s.strike, 0)} {s.isCall ? "call" : "put"}
                </strong>
                {/* The current multiplier only describes live series; settled ones keep their own history. */}
                {final ? null : <PerShare price={s.strike} multiplier={vault.multiplier} />}
                <span className="micro micro-muted">
                  {fmtNy(s.expiry)} ·{" "}
                  {s.cancelled
                    ? "Cancelled"
                    : s.settled
                      ? `Settled at ${fmtWadUsd(s.settlementPrice)}`
                      : "Live"}
                </span>
              </div>
              <span className={styles.holdingAmt}>
                <span className="micro micro-muted">Held</span>
                <span className="mono">{fmtAmount(h.balance, vault.underlying.decimals, 4)}</span>
              </span>
              <span className={styles.holdingAmt}>
                <span className="micro micro-muted">Payout</span>
                <span className="mono">{payout(h, vault)}</span>
              </span>
              <button
                type="button"
                className="pill pill-small"
                disabled={!final || tx.busy || !deployment}
                onClick={() =>
                  tx.exec("Redeem", (w) =>
                    w({
                      address: deployment!.epochManager,
                      abi: epochManagerAbi,
                      functionName: "redeem",
                      args: [s.id, h.balance, address],
                      chainId,
                    }),
                  )
                }
              >
                {final ? "Redeem" : "After expiry"}
              </button>
            </li>
          );
        })}
      </ul>
      <TxNote tx={tx} />
    </div>
  );
}
