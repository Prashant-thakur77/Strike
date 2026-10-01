"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useStrike } from "@/hooks/useStrike";
import { errorMessage } from "@/hooks/useTx";
import { NotAVaultError } from "@/lib/reads";
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
          Check the link, or switch networks if the vault lives on another one.
        </p>
        <div className={styles.emptyActions}>
          <Link href="/app" className="pill pill-small pill-ghost">
            All vaults
          </Link>
        </div>
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
