import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHead } from "@/components/ui/SectionHead";
import styles from "./landing.module.css";

const DOORS = [
  {
    href: "/app/playground",
    name: "Playground",
    text: "Test a proposal against the live mandate.",
  },
  {
    href: "/app/monitor",
    name: "Monitor",
    text: "Live safety checks on Robinhood Chain mainnet stock tokens.",
  },
  {
    href: "/app/proof",
    name: "Proof",
    text: "Every claim with its evidence.",
  },
];

/** Three read-only doors into the app that need no wallet. */
export function TryIt() {
  return (
    <section id="try" className={`theme-paper-2 ${styles.try}`} aria-labelledby="try-title">
      <div className="gutter">
        <SectionHead
          index="07"
          label="No wallet needed"
          right="Read-only · live chain data"
          hideRightOnMobile
        />
        <Reveal as="h2" id="try-title" className={`display-h2 ${styles.tryTitle}`}>
          Try it without a wallet
        </Reveal>
        <ul className={styles.doors}>
          {DOORS.map((d, i) => (
            <Reveal as="li" key={d.href} delay={0.07 * i}>
              <Link href={d.href} className={styles.door}>
                <span className={styles.doorTop}>
                  <span className="index">{String(i + 1).padStart(2, "0")}</span>
                  <span className={styles.doorArrow} aria-hidden>
                    <ArrowUpRight strokeWidth={1.5} />
                  </span>
                </span>
                <span className={styles.doorName}>{d.name}</span>
                <span className={styles.doorText}>{d.text}</span>
              </Link>
            </Reveal>
          ))}
        </ul>
      </div>
    </section>
  );
}
