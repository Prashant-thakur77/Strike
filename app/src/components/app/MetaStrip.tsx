import type { ReactNode } from "react";
import styles from "./app.module.css";

export interface MetaCell {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
}

/** Ink strip of stats separated by vertical hairlines. */
export function MetaStrip({ cells }: { cells: MetaCell[] }) {
  return (
    <section className={`theme-ink ${styles.meta}`} aria-label="Key figures">
      <dl className={styles.metaGrid} style={{ ["--cols" as string]: cells.length }}>
        {cells.map((c) => (
          <div key={c.label} className={styles.metaCell}>
            <dt className="micro micro-muted">{c.label}</dt>
            <dd className={styles.metaValue}>{c.value}</dd>
            {c.sub ? <dd className={styles.metaSub}>{c.sub}</dd> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}
