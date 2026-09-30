"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import styles from "./backtest.module.css";

export type SeriesKey = "vault" | "bh";

export interface LegendItem {
  key: SeriesKey;
  label: string;
  /** "line" for line charts, "bar" for bars. */
  shape: "line" | "bar";
}

interface ChartFrameProps {
  id: string;
  title: string;
  legend?: LegendItem[];
  /** The chart (SVG + tooltip). */
  chart: ReactNode;
  /** Its table twin. */
  table: ReactNode;
  caption?: ReactNode;
}

/** A chart with its title, legend, caption and a "Show as table" switch that swaps the chart for its data. */
export function ChartFrame({ id, title, legend, chart, table, caption }: ChartFrameProps) {
  const [asTable, setAsTable] = useState(false);
  const titleId = `${id}-title`;
  return (
    <figure className={styles.frame} aria-labelledby={titleId} data-view={asTable ? "table" : "chart"}>
      <div className={styles.frameHead}>
        <h3 id={titleId} className="micro">
          {title}
        </h3>
        <div className={styles.frameTools}>
          {legend && !asTable ? (
            <ul className={styles.legend} aria-label="Legend">
              {legend.map((l) => (
                <li key={l.key} data-series={l.key} data-shape={l.shape}>
                  {l.label}
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            className={styles.viewToggle}
            aria-pressed={asTable}
            aria-controls={`${id}-body`}
            onClick={() => setAsTable((v) => !v)}
          >
            {asTable ? "Show as chart" : "Show as table"}
          </button>
        </div>
      </div>
      <div id={`${id}-body`}>{asTable ? <div className={styles.tableBox}>{table}</div> : chart}</div>
      {caption ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
    </figure>
  );
}

/** Width of an element, kept in sync with a ResizeObserver. */
export function useWidth(initial = 640): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.max(200, Math.round(el.getBoundingClientRect().width)));
    const ro = new ResizeObserver(([e]) => {
      if (e) setWidth(Math.max(200, Math.round(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Hover and keyboard focus over a set of `count` marks: the pointer snaps to the nearest mark (via `pick`), arrow keys
 * step through them, Home/End jump, Escape clears. Focus with nothing active starts at `start`.
 */
export function useActive(count: number, start: number) {
  const [active, setActive] = useState<number | null>(null);
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  const onKeyDown = (e: KeyboardEvent) => {
    const cur = active ?? start;
    const step = e.shiftKey ? 10 : 1;
    let next: number | null = cur;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = clamp(cur + step);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = clamp(cur - step);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = count - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setActive(next);
  };
  return {
    active,
    setActive,
    bind: {
      tabIndex: 0,
      onKeyDown,
      onFocus: () => setActive((a) => a ?? clamp(start)),
      onBlur: () => setActive(null),
      onPointerLeave: () => setActive(null),
    },
  };
}

export interface TipRow {
  key: SeriesKey;
  label: string;
  value: string;
}

/** Tooltip: the heading, then one row per series, value first and a short line key beside it. */
export function Tip({
  x,
  width,
  top = 8,
  heading,
  rows,
  note,
}: {
  x: number;
  width: number;
  top?: number;
  heading: string;
  rows: TipRow[];
  note?: string;
}) {
  // Beside the mark when there is room (right first, then left), so the tip never hides what it describes.
  const est = 184;
  const half = est / 2;
  const style =
    x + 14 + est <= width
      ? { left: x + 14, top, transform: "none" }
      : x - 14 - est >= 0
        ? { left: x - 14, top, transform: "translateX(-100%)" }
        : { left: Math.min(Math.max(x, half), width - half), top };
  return (
    <div className={styles.tip} style={style} aria-hidden data-testid="chart-tip">
      <span className={styles.tipHead}>{heading}</span>
      {rows.map((r) => (
        <span key={r.key} className={styles.tipRow} data-series={r.key}>
          <strong>{r.value}</strong> {r.label}
        </span>
      ))}
      {note ? <span className={styles.tipNote}>{note}</span> : null}
    </div>
  );
}

/** Screen-reader echo of the tooltip; always mounted so changes are announced. */
export function Live({ text }: { text: string }) {
  return (
    <p className="sr-only" aria-live="polite">
      {text}
    </p>
  );
}
