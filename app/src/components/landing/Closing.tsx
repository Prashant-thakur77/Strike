"use client";

import { useRef } from "react";
import { ArrowDown } from "lucide-react";
import { motion, useScroll, useTransform } from "motion/react";
import { Footer } from "@/components/site/Footer";
import { CtaBar } from "@/components/ui/CtaBar";
import { useReducedMotion } from "@/components/ui/useReducedMotion";
import styles from "./landing.module.css";

/** 0 before `from`, 1 after `to`, linear in between. */
function ramp(p: number, from: number, to: number) {
  return Math.min(1, Math.max(0, (p - from) / (to - from)));
}

/**
 * Pinned two-phase ending: a dark teal panel with solid and outline mega type, then a mint curtain wipes up with
 * the call to action and the footer. Without motion it is two stacked panels.
 */
export function Closing() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // Function transforms run in JS every frame. (Range-mapped ones get hardware-accelerated onto a native
  // ScrollTimeline, which drops back to the unclipped base style at exactly 100% progress.)
  const curtain = useTransform(
    scrollYProgress,
    (p) => `inset(${(100 * (1 - ramp(p, 0.3, 0.72))).toFixed(3)}% 0% 0% 0%)`,
  );
  const introY = useTransform(scrollYProgress, (p) => `${(-12 * ramp(p, 0.2, 0.72)).toFixed(3)}%`);
  const introOpacity = useTransform(scrollYProgress, (p) => 1 - 0.8 * ramp(p, 0.4, 0.72));

  return (
    <section
      ref={ref}
      className={styles.closing}
      data-static={reduce ? "true" : undefined}
      aria-labelledby="closing-title"
    >
      <div className={styles.closingPin}>
        <motion.div
          className={`theme-teal ${styles.closingIntro}`}
          style={reduce ? undefined : { y: introY, opacity: introOpacity }}
        >
          <div className={styles.glow} aria-hidden />
          <span className="micro">One more thing</span>
          <p className={styles.mega} aria-hidden>
            <span>Sell the</span>
            <span className="outline-text">week.</span>
          </p>
          <span className={`micro ${styles.continue}`}>
            Continue scrolling <ArrowDown aria-hidden />
          </span>
        </motion.div>
        <motion.div
          className={`theme-mint ${styles.curtain}`}
          style={reduce ? undefined : { clipPath: curtain }}
        >
          <span className={styles.closingGhost} aria-hidden>
            08
          </span>
          <div className={`gutter ${styles.curtainInner}`}>
            <div className={styles.closingHead}>
              <span className="rule" />
              <div>
                <span className="index">08</span>
                <span className="micro">Start</span>
              </div>
            </div>
            <div className={styles.closingBody}>
              <span className="micro">Testnet is live</span>
              <h2 id="closing-title" className={styles.closingTitle}>
                Put your stock
                <br />
                tokens <span className="outline-text">to work.</span>
              </h2>
            </div>
            <CtaBar href="/app" label="Deposit, buy options or just look around" text="Open the app" />
          </div>
          <Footer />
        </motion.div>
      </div>
    </section>
  );
}
