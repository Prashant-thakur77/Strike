import type { ReactNode } from "react";
import { Term } from "@/components/ui/Term";
import type { GlossaryId } from "@/lib/glossary";
import { Skeleton } from "./Skeleton";
import styles from "./app.module.css";

export interface MetaCell {
  label: string;
  /** Glossary entry for the label: shown as a term with its definition on hover, focus or tap. */
  term?: GlossaryId;
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
            <dt className="micro micro-muted">{c.term ? <Term id={c.term}>{c.label}</Term> : c.label}</dt>
            <dd className={styles.metaValue}>{c.value}</dd>
            {c.sub ? <dd className={styles.metaSub}>{c.sub}</dd> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The strip with its labels and placeholder values, so loading doesn't change the page's height. */
export function MetaStripSkeleton({ labels }: { labels: string[] }) {
  return (
    <MetaStrip cells={labels.map((label) => ({ label, value: <Skeleton width="3.5em" />, sub: " " }))} />
  );
}
