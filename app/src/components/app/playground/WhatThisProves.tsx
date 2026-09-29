import { ArrowUpRight } from "lucide-react";
import {
  EPOCH_MANAGER_URL,
  LIVE_REJECTION_TX,
  LIVE_REJECTION_URL,
  MANDATE_GUARD_URL,
} from "@/lib/playground";
import styles from "./playground.module.css";

export function WhatThisProves() {
  return (
    <section className={`theme-ink ${styles.proves}`} aria-labelledby="pg-proves">
      <div className={styles.provesGrid}>
        <div className={styles.provesHead}>
          <span className="index">04</span>
          <h2 id="pg-proves" className="micro">
            What this proves
          </h2>
        </div>
        <div className={styles.provesBody}>
          <p className={styles.provesStatement}>
            Agents only propose. <em>The contract enforces the mandate</em>, and a proposal that breaks it is
            rejected and slashed.
          </p>
          <ul className={styles.provesList}>
            <li>
              <strong>Not a simulation.</strong>
              Every verdict on this page is an <code>eth_call</code> to the deployed EpochManager on Robinhood
              Chain testnet. Nothing is recomputed in the browser.
            </li>
            <li>
              <strong>Same code path.</strong>
              <code>previewProposal</code> is a view over <code>_evaluate</code> and{" "}
              <code>MandateGuard.check</code>, the exact functions <code>proposeSeries</code> runs before it
              lists a series or slashes the agent.
            </li>
            <li>
              <strong>Immutable limits.</strong>
              The mandate is fixed when the vault is created. No curator, agent or admin can widen it
              afterwards; the premium floor can never go below 90% of fair value.
            </li>
          </ul>
          <div className={styles.provesLinks}>
            <a className="pill pill-accent" href={MANDATE_GUARD_URL} target="_blank" rel="noreferrer">
              MandateGuard.sol on GitHub <ArrowUpRight aria-hidden />
            </a>
            <a className="pill pill-ghost" href={LIVE_REJECTION_URL} target="_blank" rel="noreferrer">
              A live rejection: {LIVE_REJECTION_TX.slice(0, 10)}…{LIVE_REJECTION_TX.slice(-6)}{" "}
              <ArrowUpRight aria-hidden />
            </a>
            <a className="pill pill-ghost" href={EPOCH_MANAGER_URL} target="_blank" rel="noreferrer">
              EpochManager.sol <ArrowUpRight aria-hidden />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
