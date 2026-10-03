"use client";

import { useConnection, useSwitchChain } from "wagmi";
import { useStrike } from "@/hooks/useStrike";
import { CHAIN_META, isAppChainId } from "@/lib/chains";
import styles from "./app.module.css";

/**
 * One line above every page while the connected wallet is on another network than the one the app shows, with a
 * one-click switch. Every write also switches by itself first (`useTx`); this says so before anyone presses a button.
 */
export function WrongNetwork() {
  const { chainId, meta } = useStrike();
  const { isConnected, chainId: walletChain } = useConnection();
  const { mutate: switchChain, isPending } = useSwitchChain();
  if (!isConnected || walletChain === undefined || walletChain === chainId) return null;
  const on = isAppChainId(walletChain) ? CHAIN_META[walletChain].label : `chain ${walletChain}`;
  return (
    <div className={`gutter ${styles.wrongNet}`} role="status" data-testid="wrong-network">
      <span>
        Your wallet is on {on}; this page shows {meta.label}.
      </span>
      <button
        type="button"
        className="pill pill-small"
        disabled={isPending}
        onClick={() => switchChain({ chainId }, { onError: () => {} })}
      >
        {isPending ? "Confirm in your wallet…" : `Switch wallet to ${meta.label}`}
      </button>
    </div>
  );
}
