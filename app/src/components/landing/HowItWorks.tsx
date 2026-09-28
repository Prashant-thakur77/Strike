import { SectionHead } from "@/components/ui/SectionHead";
import { Reveal } from "@/components/ui/Reveal";
import styles from "./landing.module.css";

const STEPS = [
  {
    title: "Open",
    when: "Mon · after 09:30 ET",
    text: "The epoch opens once the market is open and the price feed is fresh. The vault locks: deposits and withdrawals queue until settlement.",
  },
  {
    title: "Propose",
    when: "Mon · the vault's agent",
    text: "The agent proposes a strike, a size and a price. MandateGuard checks delta, price against Black-Scholes fair value, share of the vault sold and tenor.",
  },
  {
    title: "Sell",
    when: "Mon → Fri",
    text: "Buyers pay USDG for ERC-1155 options. Each purchase is priced off the oracle at that moment, so a stale quote can't be arbitraged.",
  },
  {
    title: "Expire",
    when: "Fri · 16:00 ET",
    text: "SafeStockFeed takes the first print at or after the close, and only if it is fresh, unpaused and multiplier-correct. No valid print, no settlement: it waits.",
  },
  {
    title: "Settle",
    when: "Anyone can call",
    text: "Calls pay (S − K) / S in the stock token, puts pay (K − S) in USDG. The premium, less the fee, goes to depositors, the queue clears and the vault unlocks.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className={`theme-paper-2 ${styles.how}`} aria-labelledby="how-title">
      <div className="gutter">
        <SectionHead index="03" label="How it works" right="One epoch = one week" hideRightOnMobile />
        <Reveal as="h2" id="how-title" className={`display-title ${styles.sectionTitle}`}>
          One week,
          <br />
          five steps
        </Reveal>
        <ol className={styles.steps}>
          {STEPS.map((s, i) => (
            <li key={s.title} className={styles.step}>
              <Reveal variant="draw" className="rule" />
              <div className={styles.stepTop}>
                <span className="index">{String(i + 1).padStart(2, "0")}</span>
                <span className="micro">{s.when}</span>
              </div>
              <div className={styles.stepBody}>
                <Reveal as="h3" className="display-project">
                  {s.title}
                </Reveal>
                <Reveal as="p" className="lead" delay={0.12}>
                  {s.text}
                </Reveal>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
