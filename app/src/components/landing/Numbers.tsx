import { SectionHead } from "@/components/ui/SectionHead";
import { Reveal } from "@/components/ui/Reveal";
import styles from "./landing.module.css";

const STATS: { value: string; versus?: string; label: string; text: string }[] = [
  {
    value: "0",
    label: "Vault funds an agent can move",
    text: "The agent proposes a strike, a size and a price. It never holds vault assets, and the contract rejects any proposal outside the vault's mandate.",
  },
  {
    value: "10",
    versus: "USDG",
    label: "Slashed per rejected proposal",
    text: "Taken from the agent's bond and paid to that vault's depositors. Three strikes and the agent is suspended.",
  },
  {
    value: "2×",
    label: "The multiplier bug",
    text: "Chainlink stock prices already include the ERC-8056 split multiplier. Apply it again and prices are wrong; weekend feeds freeze and both token and feed can pause. SafeStockFeed applies it once and refuses stale or paused prices.",
  },
];

export function Numbers() {
  return (
    <section id="numbers" className={`theme-ink ${styles.numbers}`} aria-labelledby="numbers-title">
      <div className="gutter">
        <SectionHead
          index="02"
          label="Why Strike, in three numbers"
          right="AgentRegistry · MandateGuard · ERC-8056"
          hideRightOnMobile
        />
        <Reveal as="h2" id="numbers-title" className={`display-title ${styles.sectionTitle}`}>
          Rules
          <br />
          not trust
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
