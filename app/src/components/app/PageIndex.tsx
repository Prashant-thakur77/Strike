"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./app.module.css";

export interface IndexItem {
  id: string;
  label: string;
}

/**
 * A sticky "on this page" bar under the app nav for long pages: one chip per section, the one in view marked.
 * Pair it with a wrapper carrying `styles.indexed` so anchors clear the bar when jumped to.
 */
export function PageIndex({ items }: { items: IndexItem[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);

  // Keep the current chip in view when the row scrolls sideways (phones), without moving the page.
  useEffect(() => {
    const ol = list.current;
    const a = current ? ol?.querySelector<HTMLElement>(`a[href="#${current}"]`) : null;
    if (!ol || !a) return;
    const left = a.offsetLeft - ol.offsetLeft - 16;
    if (
      left < ol.scrollLeft ||
      a.offsetLeft - ol.offsetLeft + a.offsetWidth > ol.scrollLeft + ol.clientWidth
    ) {
      ol.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
    }
  }, [current]);

  // The current section is the last one whose anchor has scrolled past the bar.
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = 180;
      let at: string | null = null;
      for (const i of items) {
        const el = document.getElementById(i.id);
        if (el && el.getBoundingClientRect().top <= line) at = i.id;
      }
      setCurrent(at);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [items]);

  return (
    <nav className={styles.pageIndex} aria-label="On this page">
      <div className={`gutter ${styles.pageIndexInner}`}>
        <span className={`micro micro-muted ${styles.pageIndexLabel}`}>On this page</span>
        <ol ref={list} className={styles.pageIndexList}>
          {items.map((item, n) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={styles.pageIndexLink}
                aria-current={current === item.id ? "location" : undefined}
              >
                <span className="index">{String(n + 1).padStart(2, "0")}</span> {item.label}
              </a>
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}
