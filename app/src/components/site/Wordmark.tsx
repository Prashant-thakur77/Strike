import styles from "./site.module.css";

/** "Strike" set tight, crossed by a price line with a strike marker. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`${styles.wordmark} ${className ?? ""}`}>
      <span className={styles.wordmarkText}>Strike</span>
      <span className={styles.wordmarkLine} aria-hidden />
      <span className={styles.wordmarkDot} aria-hidden />
    </span>
  );
}
