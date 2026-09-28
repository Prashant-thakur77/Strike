import Link from "next/link";
import { fmtBps, fmtDelta, fmtSeconds, shortAddr } from "@/lib/format";
import type { VaultSummary } from "@/lib/reads";
import styles from "../app.module.css";

export function MandatePanel({ vault }: { vault: VaultSummary }) {
  const m = vault.mandate;
  const cells = [
    {
      k: "Delta band",
      v: `${fmtDelta(m.minDeltaBps)} – ${fmtDelta(m.maxDeltaBps)}`,
      d: "Black-Scholes delta of the strike when proposed.",
    },
    {
      k: "Minimum price",
      v: `${fmtBps(m.minPremiumBps)} of fair value`,
      d: "No selling below the model price. Capped at 300%.",
    },
    {
      k: "Minimum yield",
      v: `${fmtBps(m.minYieldBps, 2)} per option`,
      d: "Premium over the collateral one option locks.",
    },
    {
      k: "Max share sold",
      v: `${fmtBps(m.maxShareSoldBps)} of capacity`,
      d: "Some of the vault always stays unsold.",
    },
    {
      k: "Tenor",
      v: `${fmtSeconds(m.minTenor)} – ${fmtSeconds(m.maxTenor)}`,
      d: "Expiry must also be an NYSE close.",
    },
    {
      k: "Strike side",
      v: vault.isCall ? "Above spot" : "Below spot",
      d: "Never sells an option already in the money.",
    },
  ];
  return (
    <div className={styles.panel}>
      <div className={styles.grid3}>
        {cells.map((c) => (
          <div key={c.k} className={styles.mCell}>
            <span className="micro micro-muted">{c.k}</span>
            <strong className={styles.mValue}>{c.v}</strong>
            <p>{c.d}</p>
          </div>
        ))}
      </div>
      <p className={styles.hint}>
        Run by agent{" "}
        <Link className="text-link" href="/app/agents">
          #{vault.agentId.toString()}
        </Link>{" "}
        · curator <span className="mono">{shortAddr(vault.curator)}</span>. A rejected proposal slashes the
        agent&apos;s bond to this vault&apos;s depositors.
      </p>
    </div>
  );
}
