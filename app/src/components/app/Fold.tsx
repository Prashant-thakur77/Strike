"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import styles from "./app.module.css";

interface FoldProps {
  /** What the closed fold says, e.g. "Show all 16 contracts". */
  summary: ReactNode;
  /** Summary once open (defaults to "Show less"). */
  openSummary?: ReactNode;
  /** Media query under which the fold starts closed; it starts open everywhere else. */
  closedBelow?: number;
  /** Always start closed, whatever the width (the toggle then shows on wide screens too). */
  closed?: boolean;
  children: ReactNode;
}

/**
 * A `<details>` that keeps long secondary content one tap away on phones and simply open on wider screens.
 * Content stays in the DOM either way, so links and find-in-page keep working.
 */
export function Fold({ summary, openSummary, closedBelow = 820, closed = false, children }: FoldProps) {
  const narrow = useMediaQuery(`(max-width: ${closedBelow}px)`);
  const [user, setUser] = useState<boolean | null>(null);
  const open = user ?? !(closed || narrow);
  return (
    <details
      className={styles.fold}
      data-toggle={closed ? "always" : undefined}
      open={open}
      onToggle={(e) => {
        // Only a reader's own click differs from what we rendered; ignore toggles we caused.
        if (e.currentTarget.open !== open) setUser(e.currentTarget.open);
      }}
    >
      <summary className={styles.foldSummary}>
        <span>{open ? (openSummary ?? "Show less") : summary}</span>
        <ChevronDown size={14} aria-hidden />
      </summary>
      <div className={styles.foldBody}>{children}</div>
    </details>
  );
}
