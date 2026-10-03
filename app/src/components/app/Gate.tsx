"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { createPublicClient, type Address, type PublicClient } from "viem";
import { useConnection, useSwitchChain } from "wagmi";
import { useStrike } from "@/hooks/useStrike";
import { errorMessage } from "@/hooks/useTx";
import { CHAIN_META, getAppChain, isAppChainId, type AppChainId } from "@/lib/chains";
import { deployedChainIds } from "@/lib/deployment";
import { NotAVaultError, vaultDeployment } from "@/lib/reads";
import { readTransport } from "@/lib/rpc/client";
import { NotDeployed } from "./NotDeployed";
import styles from "./app.module.css";

interface GateProps {
  isLoading?: boolean;
  error?: unknown;
  loading?: ReactNode;
  children: ReactNode;
}

/** Deployment / loading / error states shared by every data page. */
export function Gate({ isLoading, error, loading, children }: GateProps) {
  const { ready, deployment, meta } = useStrike();
  if (!ready) return <>{loading}</>;
  if (!deployment) return <NotDeployed />;
  if (error instanceof NotAVaultError) {
    return (
      <section className={`gutter ${styles.empty}`} role="alert">
        <span className="micro micro-muted">{meta.label}</span>
        <h2 className={`display-h2 ${styles.emptyTitle}`}>No Strike vault at this address.</h2>
        <p className="body">
          <span className="mono">{error.address}</span> is not a vault registered with Strike on {meta.label}.
        </p>
        <VaultElsewhere address={error.address} />
      </section>
    );
  }
  if (error) {
    return (
      <section className={`gutter ${styles.empty}`} role="alert">
        <span className="micro micro-muted">{meta.label}</span>
        <h2 className={`display-h2 ${styles.emptyTitle}`}>Couldn&apos;t read this from the chain.</h2>
        <p className="body">{errorMessage(error)}</p>
        <p className="body">
          Public test-network RPCs are often busy for a moment. Try again, or switch networks from the menu.
        </p>
        <div className={styles.emptyActions}>
          <button type="button" className="pill pill-small" onClick={() => window.location.reload()}>
            Try again
          </button>
          <Link href="/app" className="pill pill-small pill-ghost">
            All vaults
          </Link>
        </div>
      </section>
    );
  }
  if (isLoading) return <>{loading}</>;
  return <>{children}</>;
}

/** The other networks' clients, for the not-a-vault page (the app's own client follows the selected network). */
function otherNetworks(current: number): { id: AppChainId; client: PublicClient }[] {
  return deployedChainIds()
    .filter((id): id is AppChainId => isAppChainId(id) && id !== current && id !== 31337)
    .map((id) => ({
      id,
      client: createPublicClient({ chain: getAppChain(id), transport: readTransport(id) }) as PublicClient,
    }));
}

/**
 * Where the address is a Strike vault instead, with a button that moves the app (and a connected wallet) there. A
 * link shared from one network often opens on another (the app follows the wallet), and v3's Arbitrum Sepolia vaults
 * share their addresses with v1's on Robinhood Chain testnet, so "check the link" alone was a dead end (QA, 3 Oct).
 */
function VaultElsewhere({ address }: { address: Address }) {
  const { chainId, setChainId } = useStrike();
  const { isConnected } = useConnection();
  const { mutate: switchChain } = useSwitchChain();
  const q = useQuery({
    queryKey: ["vault-elsewhere", chainId, address],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      for (const { id, client } of otherNetworks(chainId))
        if (await vaultDeployment(client, id, address)) return id;
      return null;
    },
  });
  const found = q.data ?? null;
  return (
    <>
      <p
        className="body"
        data-testid="vault-elsewhere"
        data-state={q.isPending ? "loading" : found ? "found" : "none"}
      >
        {q.isPending
          ? "Looking for it on the other networks…"
          : found
            ? `It is a Strike vault on ${CHAIN_META[found].label}. Switch the app to that network to open it${isConnected ? "; your wallet is asked to follow" : ""}.`
            : "Nor on the other networks Strike runs on. Check the link."}
      </p>
      <div className={styles.emptyActions}>
        {found ? (
          <button
            type="button"
            className="pill pill-small"
            onClick={() => {
              setChainId(found);
              if (isConnected) switchChain({ chainId: found }, { onError: () => {} });
            }}
          >
            Switch to {CHAIN_META[found].label}
          </button>
        ) : null}
        <Link href="/app" className="pill pill-small pill-ghost">
          All vaults
        </Link>
      </div>
    </>
  );
}
