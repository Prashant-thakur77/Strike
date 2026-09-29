"use client";

import { epochManagerAbi } from "@strike/sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, RotateCw } from "lucide-react";
import { getAddress } from "viem";
import { errorMessage } from "@/hooks/useTx";
import { DEPLOYMENT, explorerAddress } from "@/lib/proof";
import { Skeleton } from "../Skeleton";
import { testnetClient } from "../activity/client";
import styles from "./proof.module.css";

/** Reads `EpochManager.pricer()` on Robinhood Chain testnet and says which pricer it is. */
export function ActivePricer() {
  const q = useQuery({
    queryKey: ["proof-pricer", DEPLOYMENT.epochManager],
    queryFn: async () => {
      const client = testnetClient();
      const [pricer, block] = await Promise.all([
        client.readContract({
          address: DEPLOYMENT.epochManager,
          abi: epochManagerAbi,
          functionName: "pricer",
        }),
        client.getBlockNumber(),
      ]);
      return { pricer: getAddress(pricer as string), block };
    },
    staleTime: 60_000,
    retry: 1,
  });

  const stylus = getAddress(DEPLOYMENT.stylusPricer);
  const solidity = getAddress(DEPLOYMENT.solidityPricer);
  const which = q.data
    ? q.data.pricer === stylus
      ? "stylus"
      : q.data.pricer === solidity
        ? "solidity"
        : "other"
    : null;

  return (
    <div className={styles.pricer} aria-live="polite" data-state={which ?? (q.isError ? "error" : "loading")}>
      <div className={styles.pricerCall}>
        <span className="micro micro-muted">Read on-chain now</span>
        <code className={`mono ${styles.pricerFn}`}>EpochManager.pricer()</code>
      </div>
      <div className={styles.pricerResult}>
        {q.data ? (
          <>
            <a
              className={`mono ${styles.pricerAddr}`}
              href={explorerAddress(q.data.pricer)}
              target="_blank"
              rel="noreferrer"
              data-testid="active-pricer"
            >
              {q.data.pricer} <ArrowUpRight size={12} aria-hidden />
            </a>
            <p className={styles.pricerVerdict}>
              {which === "stylus"
                ? "The Stylus pricer (Rust/WASM). Every sale and proposeByDelta on the live deployment prices through it."
                : which === "solidity"
                  ? "The Solidity reference pricer, not the Stylus one: the deployment file is out of date."
                  : "Neither pricer in the deployment file: check the deployment."}
            </p>
            <p className={styles.pricerMeta}>
              Block {q.data.block.toLocaleString("en-US")} · expected {DEPLOYMENT.activePricer} (
              <code className="mono">activePricer</code> in 46630.json)
            </p>
          </>
        ) : q.isError ? (
          <>
            <p className={styles.pricerVerdict}>Couldn&apos;t read the chain: {errorMessage(q.error)}</p>
            <p className={styles.pricerMeta}>
              The deployment file names {DEPLOYMENT.activePricer} as the active pricer.
            </p>
            <button type="button" className="pill pill-small" onClick={() => q.refetch()}>
              Try again <RotateCw aria-hidden />
            </button>
          </>
        ) : (
          <>
            <Skeleton width="min(24em, 100%)" />
            <Skeleton width="14em" />
          </>
        )}
      </div>
    </div>
  );
}
