import type { ReactNode } from "react";
import styles from "./app.module.css";

interface RailProps {
  index: string;
  label: string;
  note?: ReactNode;
  id?: string;
  children: ReactNode;
}

/** Label rail on the left (index, label, a short note), content on the right. */
export function Rail({ index, label, note, id, children }: RailProps) {
  return (
    <section className={`gutter ${styles.rail}`} id={id} aria-label={label}>
      <div className={styles.railLabel}>
        <div className={styles.railHead}>
          <span className="index">{index}</span>
          <h2 className="micro">{label}</h2>
        </div>
        {note ? <p className={styles.railNote}>{note}</p> : null}
      </div>
      <div className={styles.railBody}>{children}</div>
    </section>
  );
}
