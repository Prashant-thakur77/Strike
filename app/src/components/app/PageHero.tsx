import type { ReactNode } from "react";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHead } from "@/components/ui/SectionHead";
import styles from "./app.module.css";

interface PageHeroProps {
  index?: string;
  label: string;
  right?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  theme?: "paper" | "call" | "put";
  children?: ReactNode;
}

/** App page header in the case-study style: eyebrow on a hairline, a huge title, the lead in the right column. */
export function PageHero({ index, label, right, title, lead, theme = "paper", children }: PageHeroProps) {
  return (
    <header className={`theme-${theme} ${styles.hero}`}>
      <div className="gutter">
        <SectionHead index={index} label={label} right={right} />
        <div className={styles.heroGrid}>
          <Reveal as="h1" className={`display-h1 ${styles.heroTitle}`}>
            {title}
          </Reveal>
          {lead ? (
            <Reveal className={styles.heroLead} delay={0.12}>
              {lead}
            </Reveal>
          ) : null}
        </div>
        {children}
      </div>
    </header>
  );
}
