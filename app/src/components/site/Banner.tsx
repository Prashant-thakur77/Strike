import styles from "./site.module.css";

/** Always-visible risk notice. */
export function Banner() {
  return (
    <div className={styles.banner} role="note" aria-label="Risk notice">
      <span className="micro">
        <span className={styles.bannerDot} aria-hidden />
        Unaudited · Testnet
      </span>
      <span className={`micro ${styles.bannerRight}`}>Experimental software. Do not use real funds.</span>
    </div>
  );
}
