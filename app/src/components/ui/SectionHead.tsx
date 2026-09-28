import type { ReactNode } from "react";
import { Reveal } from "./Reveal";
import styles from "./ui.module.css";

interface SectionHeadProps {
  index?: string;
  label: string;
  right?: ReactNode;
  /** Drop the right-hand slot on phones when it is decorative. */
  hideRightOnMobile?: boolean;
}

/** A hairline that draws in, then the section index, an uppercase label and an optional right-hand slot. */
export function SectionHead({ index, label, right, hideRightOnMobile }: SectionHeadProps) {
  return (
    <div className={styles.head}>
      <Reveal variant="draw" className="rule" />
      <div className={styles.headRow}>
        {index ? <span className="index">{index}</span> : null}
        <span className="micro">{label}</span>
        {right ? (
          <span className={`micro ${styles.headRight} ${hideRightOnMobile ? styles.hideRightMobile : ""}`}>
            {right}
          </span>
        ) : null}
      </div>
    </div>
  );
}
