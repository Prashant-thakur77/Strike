"use client";

import Link from "next/link";
import { isMirrorChain, mirrorBadge } from "@/lib/mirrorAudit";
import { useMirrorAudit } from "./useMirrorAudit";
import styles from "./mirror.module.css";

/**
 * One line under a testnet vault's spot price: "Price checked against mainnet Chainlink ✓ (15 of 15 rounds)", linking
 * to the price mirror audit on /app/proof. Nothing on Robinhood Chain mainnet (Chainlink is read directly) or while
 * the audit loads or fails.
 */
export function MirrorBadge({ chainId, symbol }: { chainId: number; symbol: string }) {
  const q = useMirrorAudit(chainId);
  if (!isMirrorChain(chainId) || !q.data) return null;
  const b = mirrorBadge(q.data, symbol);
  if (!b) return null;
  return (
    <Link
      href="/app/proof#mirror"
      className={styles.badge}
      data-ok={b.ok}
      title={b.title}
      data-testid="mirror-badge"
    >
      {b.text}
    </Link>
  );
}
