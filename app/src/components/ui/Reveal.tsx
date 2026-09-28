"use client";

import { useEffect, useRef, type CSSProperties, type ElementType, type ReactNode } from "react";

type Variant = "up" | "fade" | "wipe" | "draw";

interface RevealProps {
  children?: ReactNode;
  as?: ElementType;
  variant?: Variant;
  /** Delay in seconds (use steps of ~0.07 for staggers). */
  delay?: number;
  className?: string;
  style?: CSSProperties;
  id?: string;
}

let observer: IntersectionObserver | null = null;
/** Observed element → elements to reveal when it intersects. */
const pending = new Map<Element, Set<Element>>();

/**
 * Reveal `el` when `watch` scrolls into view. A clip-path wipe starts fully clipped, which Chromium's
 * IntersectionObserver treats as never intersecting, so wipes watch their parent instead.
 */
function observe(el: Element, watch: Element) {
  if (typeof IntersectionObserver === "undefined") {
    el.classList.add("is-in");
    return () => {};
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        pending.get(e.target)?.forEach((t) => t.classList.add("is-in"));
        pending.delete(e.target);
        observer?.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
  );
  const set = pending.get(watch) ?? new Set<Element>();
  set.add(el);
  pending.set(watch, set);
  observer.observe(watch);
  return () => {
    set.delete(el);
    if (set.size === 0) {
      pending.delete(watch);
      observer?.unobserve(watch);
    }
  };
}

/** Fades and lifts its content in (expo-out) the first time it scrolls into view. Static under reduced motion. */
export function Reveal({
  children,
  as: Tag = "div",
  variant = "up",
  delay = 0,
  className,
  style,
  id,
}: RevealProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observe(el, variant === "wipe" ? (el.parentElement ?? el) : el);
  }, [variant]);
  const attr = variant === "up" ? "" : variant;
  return (
    <Tag
      ref={ref}
      id={id}
      data-reveal={attr}
      className={className}
      style={{ ...style, ["--delay" as string]: `${delay}s` }}
    >
      {children}
    </Tag>
  );
}
