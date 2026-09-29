import { Reveal } from "@/components/ui/Reveal";
import { SectionHead } from "@/components/ui/SectionHead";
import styles from "./landing.module.css";

const STACK = [
  {
    name: "Robinhood Chain",
    tag: "Where the stock tokens live",
    text: "ERC-8056 stock tokens and their Chainlink feeds. Testnet 46630 now, a capped vault on mainnet 4663 next.",
  },
  {
    name: "USDG",
    tag: "The unit of account",
    text: "Premiums, put collateral, agent bonds and fees are all Global Dollar. No swaps at settlement.",
  },
  {
    name: "Arbitrum Stylus",
    tag: "The pricer",
    text: "Black-Scholes in Rust with fixed-point math, checked bit-for-bit against a Solidity twin in CI.",
  },
];

export function BuiltOn() {
  return (
    <section className={`theme-ink ${styles.builtOn}`} aria-labelledby="built-title">
      <div className="gutter">
        <SectionHead index="08" label="Built on" right="Arbitrum Open House" hideRightOnMobile />
        <h2 id="built-title" className="sr-only">
          Built on Robinhood Chain, USDG and Arbitrum Stylus
        </h2>
      </div>
      <div className={styles.statGrid}>
        {STACK.map((s, i) => (
          <Reveal key={s.name} className={styles.stat} delay={0.07 * i}>
            <span className="micro micro-muted">{s.tag}</span>
            <span className={styles.stackName}>{s.name}</span>
            <p className={styles.statText}>{s.text}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
