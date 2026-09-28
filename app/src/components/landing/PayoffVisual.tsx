import styles from "./landing.module.css";

/**
 * A covered call's payoff: value rises with the stock up to the strike K, then goes flat (upside sold for
 * premium). The dashed line is holding the stock alone. Drawn in white under mix-blend-mode: difference, so it
 * turns dark on paper and light where it crosses the letters.
 */
export function PayoffVisual() {
  return (
    <div className={styles.payoff}>
      <svg viewBox="0 0 1000 600" preserveAspectRatio="none" className={styles.payoffSvg}>
        <path
          className={styles.payoffStock}
          d="M0 560 L1000 20"
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
        <path className={styles.payoffDrop} d="M640 214 L640 600" vectorEffect="non-scaling-stroke" />
        <path
          className={styles.payoffLine}
          d="M0 520 L640 174 L1000 174"
          pathLength={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className={styles.payoffKnot} style={{ left: "64%", top: "29%" }} />
      <span className={`micro ${styles.payoffLabel}`} style={{ left: "64%", top: "29%" }}>
        K · strike
      </span>
      <span
        className={`micro ${styles.payoffLabel} ${styles.payoffLabelEnd}`}
        style={{ left: "100%", top: "29%" }}
      >
        Upside sold for premium
      </span>
    </div>
  );
}
