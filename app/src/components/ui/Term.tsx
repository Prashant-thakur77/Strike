"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GLOSSARY, type GlossaryId } from "@/lib/glossary";
import styles from "./ui.module.css";

const GAP = 8;
const MARGIN = 12;

/**
 * A jargon word with its plain-language definition: dotted underline, definition on hover, keyboard focus or tap
 * (Escape or a second tap closes it). The definition is also the trigger's accessible description, so screen
 * readers get it without opening anything.
 */
export function Term({ id, children }: { id: GlossaryId; children?: ReactNode }) {
  const entry = GLOSSARY[id];
  const descId = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const place = useCallback(() => {
    const t = ref.current;
    const b = tip.current;
    if (!t || !b) return;
    const r = t.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const left = Math.min(Math.max(MARGIN, r.left + r.width / 2 - w / 2), vw - w - MARGIN);
    const below = r.bottom + GAP;
    const top = below + h > window.innerHeight - MARGIN && r.top - GAP - h > MARGIN ? r.top - GAP - h : below;
    setPos({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setPinned(false);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setPinned(false);
      }
    };
    window.addEventListener("scroll", place, { passive: true, capture: true });
    window.addEventListener("resize", place);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, place]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.term}
        aria-describedby={descId}
        aria-expanded={open}
        data-term={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => !pinned && setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          setPinned(false);
        }}
        onClick={() => {
          // Taps (and clicks): pin it open until the next tap anywhere, or close a pinned one.
          setOpen(!pinned);
          setPinned(!pinned);
        }}
      >
        {children ?? entry.term}
      </button>
      <span id={descId} className="sr-only">
        {entry.def}
      </span>
      {mounted && open
        ? createPortal(
            <span
              ref={tip}
              role="tooltip"
              data-term-tip={id}
              className={styles.termTip}
              style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
            >
              <strong>{entry.term}.</strong> {entry.def}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
