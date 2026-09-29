import styles from "./landing.module.css";

/**
 * A covered call's payoff at expiry, drawn as a low, full-width chart under the headline: value rises with the
 * stock up to the strike K, then goes flat (the upside is sold for the premium). The dashed line is holding the
 * stock alone. The chart has its own row, so no line or label ever crosses the display type, and every label
 * sits in an empty corner of the plot.
 */
export function PayoffVisual() {
  return (
    <figure className={styles.payoff} aria-hidden>
      <div className={styles.payoffPlot}>
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className={styles.payoffSvg}>
          <path className={styles.payoffStock} d="M0 100 L1000 0" vectorEffect="non-scaling-stroke" />
          <path className={styles.payoffDrop} d="M640 30 L640 100" vectorEffect="non-scaling-stroke" />
          <path className={styles.payoffLine} d="M0 92 L640 30 L1000 30" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className={styles.payoffKnot} />
        <span className={styles.payoffLegend}>
          <span className="micro">
            <i data-kind="call" /> Covered call
          </span>
          <span className="micro">
            <i data-kind="stock" /> Stock alone
          </span>
        </span>
        <span className={`micro ${styles.payoffTag} ${styles.payoffTagK}`}>K · strike</span>
        <span className={`micro ${styles.payoffTag} ${styles.payoffTagEnd}`}>
          Upside sold <span className={styles.payoffBreak}>for premium</span>
        </span>
      </div>
    </figure>
  );
}
