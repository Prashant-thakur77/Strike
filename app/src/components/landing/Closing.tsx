"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight } from "lucide-react";
import { motion, useScroll, useTransform } from "motion/react";
import { Footer } from "@/components/site/Footer";
import { CtaBar } from "@/components/ui/CtaBar";
import { useReducedMotion } from "@/components/ui/useReducedMotion";
import { LINKS } from "@/lib/links";
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
  const curtainRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  // The pinned curtain is one screen tall and clips: when its content (call to action plus footer) is taller than
  // the screen, as on short phones, stack the two panels instead so nothing is cut off.
  const [tooTall, setTooTall] = useState(false);
  useEffect(() => {
    const el = curtainRef.current;
    if (!el) return;
    const check = () => {
      // The inner block stretches to fill the pin, so add up its children for its natural height.
      const inner = el.firstElementChild as HTMLElement;
      const foot = el.lastElementChild as HTMLElement;
      const cs = getComputedStyle(inner);
      const kids = [...inner.children] as HTMLElement[];
      const innerH =
        parseFloat(cs.paddingTop) +
        parseFloat(cs.paddingBottom) +
        kids.reduce((h, k) => h + k.offsetHeight, 0) +
        (parseFloat(cs.rowGap) || 0) * Math.max(0, kids.length - 1);
      const content = innerH + foot.offsetHeight;
      const banner =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--banner-h")) || 0;
      setTooTall(content > window.innerHeight - banner);
    };
    check();
    const ro = new ResizeObserver(check);
    for (const c of el.children) ro.observe(c);
    for (const c of el.firstElementChild?.children ?? []) ro.observe(c);
    window.addEventListener("resize", check);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", check);
    };
  }, []);
  const stacked = reduce || tooTall;
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
      data-static={stacked ? "true" : undefined}
      aria-labelledby="closing-title"
    >
      <div className={styles.closingPin}>
        <motion.div
          className={`theme-teal ${styles.closingIntro}`}
          style={stacked ? undefined : { y: introY, opacity: introOpacity }}
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
          ref={curtainRef}
          className={`theme-mint ${styles.curtain}`}
          style={stacked ? undefined : { clipPath: curtain }}
        >
          <div className={`gutter ${styles.curtainInner}`}>
            <div className={styles.closingHead}>
              <span className={styles.closingGhost} aria-hidden>
                09
              </span>
              <span className="rule" />
              <div>
                <span className="index">09</span>
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
            <p className={styles.closingPlan}>
              <span>We&apos;re building Strike as a company, starting on these testnets.</span>
              <a href={LINKS.company} className="micro text-link" target="_blank" rel="noreferrer">
                Read the plan <ArrowUpRight size={12} aria-hidden />
              </a>
              <Link href="/waitlist" className="micro text-link">
                Join the mainnet waitlist <ArrowRight size={12} aria-hidden />
              </Link>
            </p>
          </div>
          <Footer />
        </motion.div>
      </div>
    </section>
  );
}
