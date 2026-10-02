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

/** A rule with its limit and the headroom left on it (the decision page's scorecard). */
export type ScoredMandateRule = MandateRule & {
  limit?: string;
  headroom?: { text: string; tone: "room" | "tight" | "over" } | null;
};

/**
 * The vault's mandate as plain rules, in `MandateGuard.check` order, marked against the current verdict. With a
 * limit and headroom per rule, each also shows the bound and how far the measured value sits from it.
 */
export function MandateRules({ rules }: { rules: ScoredMandateRule[] }) {
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
            {r.limit && r.mark !== "skip" ? (
              <span className={styles.measured} data-testid="rule-limit">
                limit {r.limit}
              </span>
            ) : null}
            {r.headroom ? (
              <span className={styles.headroom} data-tone={r.headroom.tone} data-testid="rule-headroom">
                {r.headroom.tone === "over"
                  ? "Over: "
                  : r.headroom.tone === "tight"
                    ? "No headroom: "
                    : "Headroom: "}
                {r.headroom.text}
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
