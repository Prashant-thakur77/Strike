"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./app.module.css";

/**
 * The wrapper of a wide data table. Every table wrapper scrolls sideways with a shadow at the edge that has more
 * columns; with `stack`, below 640px each row becomes a card instead, every cell labelled with its column's heading,
 * so no column (a check's result, a branch's net) sits off-screen on a phone. The labels are copied from the table's
 * own `thead` into `data-label` on each body cell, and kept in step when rows change.
 */
export function TableWrap({ stack = false, children }: { stack?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!stack || !el) return;
    const label = () => {
      for (const table of el.querySelectorAll("table")) {
        const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent?.trim() ?? "");
        for (const tr of table.querySelectorAll("tbody tr"))
          [...tr.children].forEach((cell, i) => {
            const h = heads[i];
            if (h && cell.getAttribute("data-label") !== h) cell.setAttribute("data-label", h);
          });
      }
    };
    label();
    // Child lists and text only: setting the attributes is not itself observed, so this cannot loop.
    const mo = new MutationObserver(label);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [stack]);
  return (
    <div ref={ref} className={styles.tableWrap} data-stack={stack || undefined}>
      {children}
    </div>
  );
}
