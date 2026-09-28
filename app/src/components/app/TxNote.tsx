"use client";

import { ArrowUpRight } from "lucide-react";
import type { TxState } from "@/hooks/useTx";
import { useStrike } from "@/hooks/useStrike";
import { explorerUrl } from "@/lib/chains";
import styles from "./app.module.css";

/** One line of transaction feedback under an action. */
export function TxNote({ tx }: { tx: TxState }) {
  const { chainId } = useStrike();
  if (tx.phase === "idle") return null;
  const link = tx.hash ? explorerUrl(chainId, "tx", tx.hash) : null;
  const text =
    tx.phase === "wallet"
      ? `${tx.label}: confirm in your wallet…`
      : tx.phase === "pending"
        ? `${tx.label}: waiting for the block…`
        : tx.phase === "done"
          ? `${tx.label}: done.`
          : `${tx.label} failed: ${tx.error}`;
  return (
    <p className={styles.txNote} data-phase={tx.phase} role={tx.phase === "error" ? "alert" : "status"}>
      {text}
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="text-link">
          View <ArrowUpRight size={12} aria-hidden />
        </a>
      ) : null}
    </p>
  );
}
