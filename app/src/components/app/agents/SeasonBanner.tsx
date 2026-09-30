"use client";

import { ArrowDown, ArrowUpRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { LINKS } from "@/lib/links";
import styles from "./season.module.css";

/** localStorage item; the root layout's boot script reads the same item to hide the banner before first paint. */
export const SEASON_STORAGE_ID = "strike.season0.v1";

const STEPS = ["Register", "Bond", "Run one epoch", "File feedback"] as const;

function dismissedBefore(): boolean {
  try {
    return window.localStorage.getItem(SEASON_STORAGE_ID) === "dismissed";
  } catch {
    return false;
  }
}

/**
 * "Season 0" invitation on /app/agents: testnet agents welcome, the four steps, and where to start. Rendered on the
 * server so first-time visitors see it at once; dismissed for good in this browser with the close button.
 */
export function SeasonBanner() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (dismissedBefore()) setDismissed(true);
  }, []);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    document.documentElement.classList.add("season0-off");
    try {
      window.localStorage.setItem(SEASON_STORAGE_ID, "dismissed");
    } catch {
      // storage unavailable: the banner comes back on the next visit
    }
  };

  return (
    <aside className={`theme-mint ${styles.season}`} aria-label="Season 0">
      <div className={styles.inner}>
        <div className={styles.head}>
          <span className="micro">
            <span className={styles.dot} aria-hidden />
            Season 0 · Testnet
          </span>
          <p className={styles.title}>Testnet agents welcome.</p>
          <p className={styles.lead}>
            Bring an agent to Robinhood Chain testnet. No permission needed; the contracts enforce the rules.
          </p>
        </div>
        <ol className={styles.steps} aria-label="Season 0 checklist">
          {STEPS.map((s, i) => (
            <li key={s}>
              <span className="index">{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.step}>{s}</span>
            </li>
          ))}
        </ol>
        <div className={styles.actions}>
          <a href="#run-your-own-agent" className="pill pill-small">
            Run your own agent <ArrowDown aria-hidden />
          </a>
          <a href={LINKS.feedback} target="_blank" rel="noreferrer" className="text-link micro">
            Feedback form <ArrowUpRight aria-hidden size={12} />
          </a>
        </div>
        <button type="button" className={styles.close} onClick={dismiss} aria-label="Dismiss Season 0 banner">
          <X aria-hidden />
        </button>
      </div>
    </aside>
  );
}
