"use client";

import { useStrike } from "@/hooks/useStrike";
import { CHAIN_META, isAppChainId } from "@/lib/chains";
import { deployedChainIds } from "@/lib/deployment";
import styles from "./app.module.css";

/** Shown when the selected network has no Strike deployment in the SDK map. */
export function NotDeployed() {
  const { meta, setChainId } = useStrike();
  const available = deployedChainIds().filter(isAppChainId);
  return (
    <section className={`gutter ${styles.empty}`} aria-live="polite">
      <span className="micro micro-muted">Network</span>
      <h2 className="display-h2">Not deployed on {meta.label} yet.</h2>
      <p className="body">
        Strike&apos;s contracts are not on this network yet. When they are, their addresses are added to the
        SDK and this page fills in by itself.
      </p>
      {available.length > 0 ? (
        <div className={styles.emptyActions}>
          <span className="micro">Deployed on</span>
          {available.map((id) => (
            <button
              key={id}
              type="button"
              className="pill pill-small pill-ghost"
              onClick={() => setChainId(id)}
            >
              {CHAIN_META[id].label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
