"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Wordmark } from "@/components/site/Wordmark";
import styles from "./app.module.css";

/** localStorage key; the root layout's boot script reads the same key to hide the notice before first paint. */
export const ACK_KEY = "strike.ack.v1";

// Acknowledged during this page load: survives client-side navigation even when storage is unavailable.
let ackedThisVisit = false;

function acknowledged(): boolean {
  if (ackedThisVisit) return true;
  try {
    return window.localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
}

function remember() {
  ackedThisVisit = true;
  document.documentElement.classList.add("acked");
  try {
    window.localStorage.setItem(ACK_KEY, "1");
  } catch {
    // storage unavailable (private mode, blocked): the notice comes back on the next visit
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * First-visit notice for the app: not for US persons, unaudited testnet software. Full screen, focus trapped,
 * everything behind it inert until the visitor ticks the box and continues. Rendered on the server so first-time
 * visitors see it at once; returning visitors never see it (the boot script marks <html> before paint).
 */
export function EligibilityGate() {
  const [phase, setPhase] = useState<"boot" | "open" | "closed">("boot");
  const [agreed, setAgreed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    setPhase(acknowledged() ? "closed" : "open");
  }, []);

  useEffect(() => {
    const el = root.current;
    if (phase !== "open" || !el) return;
    // Make everything outside the notice inert: unfocusable, unclickable and hidden from assistive tech.
    const inerted: HTMLElement[] = [];
    for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
      for (const sibling of Array.from(node.parentElement?.children ?? [])) {
        if (sibling !== node && sibling instanceof HTMLElement && !sibling.inert) {
          sibling.inert = true;
          inerted.push(sibling);
        }
      }
    }
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    el.focus();
    return () => {
      for (const sibling of inerted) sibling.inert = false;
      document.body.style.overflow = overflow;
    };
  }, [phase]);

  if (phase === "closed") return null;

  // Keep Tab and Shift+Tab cycling inside the notice.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !root.current) return;
    const items = Array.from(root.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onContinue = () => {
    if (!agreed) return;
    remember();
    setPhase("closed");
  };

  return (
    <div
      ref={root}
      className={`theme-teal ${styles.ack}`}
      data-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className={styles.ackInner}>
        <div className={styles.ackTop}>
          <Wordmark />
          <span className="micro micro-muted">Before you open the app</span>
        </div>
        <span className="rule" />
        <div className={styles.ackHead}>
          <span className="index">00</span>
          <span className="micro">Eligibility</span>
          <span className={`micro ${styles.ackHeadRight}`}>Unaudited · Testnet</span>
        </div>

        <h2 id={titleId} className={styles.ackTitle}>
          <span>Not for</span>
          <span className="outline-text">US persons.</span>
        </h2>

        <ol id={descId} className={styles.ackList}>
          <li>
            <span className="index">01</span>
            <p>
              Robinhood stock tokens are offered only to non-US persons. Strike is not available to anyone in
              the United States or to US persons anywhere.
            </p>
          </li>
          <li>
            <span className="index">02</span>
            <p>
              Strike is unaudited, experimental software running on test networks. Contracts can have bugs; do
              not use real funds. Nothing here is investment advice.
            </p>
          </li>
        </ol>

        <div className={styles.ackForm}>
          <label className={styles.ackCheck}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I am not a US person and understand this is experimental</span>
          </label>
          <div className={styles.ackActions}>
            <button type="button" className="pill pill-accent" disabled={!agreed} onClick={onContinue}>
              Continue <ArrowRight aria-hidden />
            </button>
            <Link href="/" className={`micro ${styles.ackLeave}`}>
              Back to the home page
            </Link>
          </div>
          <p className={`micro micro-muted ${styles.ackNote}`}>
            Remembered in this browser only. Nothing is sent anywhere.
          </p>
        </div>
      </div>
    </div>
  );
}
