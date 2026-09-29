import { ArrowUpRight } from "lucide-react";
import { LINKS } from "@/lib/links";
import styles from "./monitor.module.css";

const SAFE_STOCK_FEED = `${LINKS.github}/blob/main/contracts/src/libraries/SafeStockFeed.sol`;

interface Check {
  theme: string;
  verdict: string;
  rule: string;
  text: string;
  lines: { line: number; label: string }[];
}

// In the order `SafeStockFeed.status()` runs them. Line numbers point at contracts/src/libraries/SafeStockFeed.sol.
const CHECKS: Check[] = [
  {
    theme: "Two pause layers · the token",
    verdict: "TokenPaused",
    rule: "paused() == true",
    text: "Robinhood can halt the token itself. A halted token has no tradable market, so no price for it is safe to act on, whatever the feed says.",
    lines: [{ line: 55, label: "L55" }],
  },
  {
    theme: "Two pause layers · the feed",
    verdict: "FeedPaused",
    rule: "oraclePaused() == true",
    text: "A separate flag Robinhood raises around corporate actions; while it is up the feed holds its last value. Testnet tokens don't have the function, and a missing or reverting call counts as not paused.",
    lines: [
      { line: 56, label: "L56" },
      { line: 166, label: "L166" },
    ],
  },
  {
    theme: "Splits in flight",
    verdict: "CorporateActionPending",
    rule: "uiMultiplier ≠ newUIMultiplier, or now < effectiveAt + 1 day",
    text: "A split or stock dividend changes how many shares one raw token is worth. From the moment it is scheduled until a day after it lands, the feed and the token can disagree, so prices in that window are refused.",
    lines: [
      { line: 57, label: "L57" },
      { line: 147, label: "L147" },
    ],
  },
  {
    theme: "Broken rounds",
    verdict: "InvalidPrice",
    rule: "answer ≤ 0, or updatedAt > block.timestamp",
    text: "A zero, negative or future-dated answer is a malfunction, never a price.",
    lines: [{ line: 61, label: "L61" }],
  },
  {
    theme: "Frozen weekend feeds",
    verdict: "StalePrice",
    rule: "block.timestamp − updatedAt > 25 h",
    text: "Stock feeds run 24/5 and have no heartbeat off-hours, so from Friday night to Sunday night the last print just sits there. Past the limit the price is stale, not merely quiet.",
    lines: [{ line: 63, label: "L63" }],
  },
  {
    theme: "Multiplier double-count",
    verdict: "never × uiMultiplier",
    rule: "priceWad = answer scaled to 18 decimals",
    text: "The Chainlink answer already prices one raw token including the multiplier. Multiplying it again counts every split and dividend twice. Strike's math uses the feed price as-is; the per-share column above divides by the multiplier for display only.",
    lines: [
      { line: 11, label: "L11" },
      { line: 159, label: "L159" },
    ],
  },
];

/** The SafeStockFeed rules, what each one guards against, and where it lives in the source. */
export function CheckList() {
  return (
    <ol className={styles.checks}>
      {CHECKS.map((c, i) => (
        <li key={c.verdict} className={styles.check}>
          <span className="index">{String(i + 1).padStart(2, "0")}</span>
          <div className={styles.checkBody}>
            <span className="micro micro-muted">{c.theme}</span>
            <h3 className={styles.checkTitle}>{c.verdict}</h3>
            <code className={`mono ${styles.checkRule}`}>{c.rule}</code>
            <p>{c.text}</p>
            <span className={styles.checkLinks}>
              {c.lines.map((l) => (
                <a
                  key={l.line}
                  href={`${SAFE_STOCK_FEED}#L${l.line}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-link"
                >
                  SafeStockFeed.sol {l.label} <ArrowUpRight size={12} aria-hidden />
                </a>
              ))}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
