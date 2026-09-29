"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useStrike } from "@/hooks/useStrike";
import { errorMessage } from "@/hooks/useTx";
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
  if (error) {
    return (
      <section className={`gutter ${styles.empty}`} role="alert">
        <span className="micro micro-muted">{meta.label}</span>
        <h2 className="display-h2">Couldn&apos;t read this from the chain.</h2>
        <p className="body">{errorMessage(error)}</p>
        <div className={styles.emptyActions}>
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
