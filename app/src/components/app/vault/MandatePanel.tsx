import Link from "next/link";
import { fmtBps, fmtDelta, fmtSeconds } from "@/lib/format";
import type { VaultSummary } from "@/lib/reads";
import { AddressLink } from "../AddressLink";
import { Term } from "@/components/ui/Term";
import styles from "../app.module.css";

export function MandatePanel({ vault }: { vault: VaultSummary }) {
  const m = vault.mandate;
  const cells = [
    {
      k: "Delta band",
      term: "delta" as const,
      v: `${fmtDelta(m.minDeltaBps)} – ${fmtDelta(m.maxDeltaBps)}`,
      d: "Black-Scholes delta of the strike when proposed.",
    },
    {
      k: "Minimum price",
      term: "fairValue" as const,
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
      term: "tenor" as const,
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
            <span className="micro micro-muted">
              {"term" in c && c.term ? <Term id={c.term}>{c.k}</Term> : c.k}
            </span>
            <strong className={styles.mValue}>{c.v}</strong>
            <p>{c.d}</p>
          </div>
        ))}
      </div>
      <p className={styles.hint}>
        Run by{" "}
        <Link className={styles.inlineLink} href="/app/agents">
          agent #{vault.agentId.toString()}
        </Link>{" "}
        · curator <AddressLink address={vault.curator} />. A rejected proposal slashes the agent&apos;s bond
        to this vault&apos;s depositors.
      </p>
    </div>
  );
}
