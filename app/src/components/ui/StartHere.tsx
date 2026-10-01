import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { START_HERE } from "@/lib/tour";
import styles from "./ui.module.css";

interface StartHereProps {
  /** Where step 1 ("See a vault") points; on the vaults page it is the list below. */
  firstHref?: string;
  className?: string;
}

/** The four-step path through the app for a first-time visitor, each step a link. */
export function StartHere({ firstHref, className }: StartHereProps) {
  return (
    <nav className={`${styles.start} ${className ?? ""}`} aria-label="Start here">
      <span className={`micro ${styles.startLabel}`}>New here? Start here</span>
      <ol className={styles.startSteps}>
        {START_HERE.map((s, i) => (
          <li key={s.href}>
            <Link href={i === 0 && firstHref ? firstHref : s.href} className={styles.startStep}>
              <span className="index">{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.startText}>
                <span className={styles.startTitle}>
                  {s.label} <ArrowUpRight aria-hidden />
                </span>
                <span className={styles.startNote}>{s.note}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
