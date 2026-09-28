"use client";

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import styles from "./ui.module.css";

interface FitTextProps {
  lines: string[];
  className?: string;
  /** Upper bound for a line, in px. */
  max?: number;
  /** First-paint size of each line in vw, before the exact fit runs. */
  estimates?: number[];
  style?: CSSProperties;
}

/** Sizes every line so it spans the container's full width (justified display type). */
export function FitText({ lines, className, max = 420, estimates, style }: FitTextProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const fit = () => {
      const width = root.clientWidth;
      if (width === 0) return;
      for (const line of Array.from(root.children) as HTMLElement[]) {
        line.style.fontSize = "100px";
        const natural = line.scrollWidth;
        if (natural > 0) line.style.fontSize = `${Math.min(max, (100 * width) / natural)}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(root);
    document.fonts?.ready.then(fit).catch(() => {});
    return () => ro.disconnect();
  }, [lines, max]);

  return (
    <span ref={ref} className={`${styles.fit} ${className ?? ""}`} style={style}>
      {lines.map((l, i) => (
        <span
          key={l}
          className={styles.fitLine}
          style={estimates?.[i] ? { fontSize: `${estimates[i]}vw` } : undefined}
        >
          {l}
        </span>
      ))}
    </span>
  );
}
