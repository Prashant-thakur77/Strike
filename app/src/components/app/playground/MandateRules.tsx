"use client";

import { CircleCheck, CircleDashed, CircleMinus, CircleX } from "lucide-react";
import type { MandateRule, RuleMark } from "@/lib/playground";
import styles from "./playground.module.css";

const MARK_TEXT: Record<RuleMark, string> = {
  pass: "Passes",
  fail: "Fails",
  skip: "Not reached",
  idle: "Unchecked",
};

function MarkIcon({ mark }: { mark: RuleMark }) {
  if (mark === "pass") return <CircleCheck aria-hidden />;
  if (mark === "fail") return <CircleX aria-hidden />;
  if (mark === "skip") return <CircleMinus aria-hidden />;
  return <CircleDashed aria-hidden />;
}

/** The vault's mandate as plain rules, in `MandateGuard.check` order, marked against the current verdict. */
export function MandateRules({ rules }: { rules: MandateRule[] }) {
  return (
    <ol className={styles.rules} aria-label="Mandate rules in the order the contract checks them">
      {rules.map((r, i) => (
        <li key={r.reason} className={styles.rule} data-mark={r.mark}>
          <span className="index">{String(i + 1).padStart(2, "0")}</span>
          <div className={styles.ruleBody}>
            <span className={styles.ruleTitle}>
              {r.title}
              <code>{r.reason}</code>
            </span>
            <span className={styles.ruleText}>{r.rule}</span>
          </div>
          <div className={styles.mark} data-mark={r.mark}>
            <span className={styles.markTag}>
              <MarkIcon mark={r.mark} />
              {MARK_TEXT[r.mark]}
            </span>
            {r.measured ? <span className={styles.measured}>{r.measured}</span> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
