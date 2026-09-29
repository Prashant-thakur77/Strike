import { Reveal } from "@/components/ui/Reveal";
import styles from "./landing.module.css";

const RULES = [
  ["Stale price", "Older than the feed's max age: revert StalePrice."],
  ["Paused token", "The stock token is paused: TokenPaused."],
  ["Paused feed", "The oracle side is paused: FeedPaused."],
  ["Corporate action", "A split or dividend is scheduled: block until it takes effect, plus a grace period."],
  ["Multiplier, once", "Chainlink prices already include uiMultiplier. Never applied again."],
  ["Market hours", "Opening and selling need an open NYSE session (holidays and early closes on-chain)."],
  ["Settlement round", "Only the first print at or after expiry, verified against the round before it."],
  ["Sequencer", "Optional L2 uptime feed: no reads while the sequencer is down or recovering."],
];

const INVARIANTS = [
  [
    "Collateral covers payouts",
    "Locked collateral is always at least the maximum payout of every option sold.",
  ],
  [
    "Shares match assets",
    "Shares × share price equals vault assets, to rounding, and rounding favours the vault.",
  ],
  ["Nothing leaks while locked", "During an epoch, assets move only inside settlement."],
  ["Settles once", "A series settles at most once, at a price that never changes after."],
];

export function Safety() {
  return (
    <section id="safety" className={`theme-paper ${styles.safety}`} aria-labelledby="safety-title">
      <div className={`gutter ${styles.rail}`}>
        <div className={styles.railLabel}>
          <span className="index">05</span>
          <span className="micro">Safety</span>
        </div>
        <div className={styles.railBody}>
          <Reveal as="h2" id="safety-title" className="display-h2">
            Refuse. Don&apos;t guess.
          </Reveal>
          <Reveal as="p" className="body" delay={0.1}>
            Almost every way to lose money here comes from how stock tokens behave: splits, weekends, pauses.
            So every price goes through SafeStockFeed, and when a check fails the contract waits instead of
            guessing.
          </Reveal>

          <h3 className={`micro ${styles.subhead}`}>SafeStockFeed rules</h3>
          <ul className={styles.ruleList}>
            {RULES.map(([name, text], i) => (
              <Reveal as="li" key={name} delay={(i % 2) * 0.07}>
                <strong>{name}</strong>
                <span>{text}</span>
              </Reveal>
            ))}
          </ul>

          <h3 className={`micro ${styles.subhead}`}>Invariants, fuzzed in CI</h3>
          <div className={styles.cells}>
            {INVARIANTS.map(([name, text], i) => (
              <Reveal key={name} className={styles.cell} delay={i * 0.07}>
                <span className="index">{String(i + 1).padStart(2, "0")}</span>
                <strong className="h3">{name}</strong>
                <p>{text}</p>
              </Reveal>
            ))}
          </div>

          <Reveal as="blockquote" className={styles.quote}>
            <span className="micro">Status</span>
            <p>Unaudited. Testnets first, then one small, capped mainnet vault.</p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
