"use client";

import { useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { motion, useMotionValueEvent, useScroll, useTransform } from "motion/react";
import { useReducedMotion } from "@/components/ui/useReducedMotion";
import styles from "./landing.module.css";

const PARAGRAPHS = [
  "Selling options on stock tokens pays, if the strikes are sane.",
  "Strike's agents pick them. The contract holds each one to a mandate and pays its slashed bond to depositors.",
];

const WORDS = PARAGRAPHS.map((p) => p.split(" "));
const TOTAL = WORDS.reduce((n, w) => n + w.length, 0);

/** Pinned statement whose words turn from grey to ink as you scroll (static under reduced motion). */
export function Manifesto() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const [lit, setLit] = useState(0);
  // A function transform keeps this in JS (a hardware-accelerated ScrollTimeline drops its fill at 100%).
  const fill = useTransform(scrollYProgress, (p) => Math.min(1, Math.max(0, p)));

  useMotionValueEvent(scrollYProgress, "change", (p) => {
    const next = Math.min(TOTAL, Math.floor(p * 1.25 * TOTAL));
    setLit((prev) => (prev === next ? prev : next));
  });

  const shown = reduce ? TOTAL : lit;
  let i = 0;
  return (
    <section
      ref={ref}
      id="problem"
      className={`theme-paper ${styles.manifesto}`}
      data-static={reduce ? "true" : undefined}
      aria-label="The idea"
    >
      <div className={styles.manifestoPin}>
        <div className={styles.manifestoTop}>
          <span className={styles.progress}>
            <motion.span style={{ scaleX: reduce ? 1 : fill }} />
          </span>
          <div className={styles.manifestoHead}>
            <span className="index">01</span>
            <span className="micro">The idea</span>
          </div>
        </div>
        <div className={styles.manifestoText}>
          {WORDS.map((words, p) => (
            <p key={p}>
              {words.map((w) => {
                const on = i++ < shown;
                return (
                  <span key={`${p}-${i}`} className={styles.word} data-on={on}>
                    {w}{" "}
                  </span>
                );
              })}
            </p>
          ))}
        </div>
        <div className={styles.manifestoBottom}>
          <span className={styles.progress}>
            <motion.span style={{ scaleX: reduce ? 1 : fill }} />
          </span>
          <a href="#numbers" className="circle-btn" aria-label="Next section: Strike in three numbers">
            <ArrowDown strokeWidth={1.5} />
          </a>
        </div>
      </div>
    </section>
  );
}
