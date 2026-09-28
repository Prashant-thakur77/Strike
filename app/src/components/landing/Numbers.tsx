import { SectionHead } from "@/components/ui/SectionHead";
import { Reveal } from "@/components/ui/Reveal";
import styles from "./landing.module.css";

const STATS = [
  {
    value: "0%",
    label: "Yield on a stock token",
    text: "Robinhood Chain has perps, but no options and no way to earn on a TSLA or NVDA token you already hold.",
  },
  {
    value: "$14M",
    versus: "vs $400M",
    label: "Stock tokens vs idle stablecoins",
    text: "Stock-token market cap is a rounding error next to the stablecoins sitting on the same chain.",
  },
  {
    value: "2×",
    label: "The multiplier bug",
    text: "Chainlink stock prices already include the ERC-8056 split multiplier. Apply it again and prices are wrong; weekend feeds freeze and both token and feed can pause.",
  },
];

export function Numbers() {
  return (
    <section id="numbers" className={`theme-ink ${styles.numbers}`} aria-labelledby="numbers-title">
      <div className="gutter">
        <SectionHead
          index="02"
          label="The problem, in three numbers"
          right="CertiK · FalconX · ERC-8056"
          hideRightOnMobile
        />
        <Reveal as="h2" id="numbers-title" className={`display-title ${styles.sectionTitle}`}>
          Idle by
          <br />
          default
        </Reveal>
      </div>
      <div className={styles.statGrid}>
        {STATS.map((s, i) => (
          <Reveal key={s.label} className={styles.stat} delay={0.07 * i}>
            <span className="micro micro-muted">{s.label}</span>
            <span className={styles.statValue}>
              {s.value}
              {s.versus ? <span className={styles.statVersus}>{s.versus}</span> : null}
            </span>
            <p className={styles.statText}>{s.text}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
