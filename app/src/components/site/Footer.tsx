import Link from "next/link";
import { ArrowUp, ArrowUpRight } from "lucide-react";
import { LINKS } from "@/lib/links";
import styles from "./site.module.css";

const PAGES = [
  ["/app", "Vaults"],
  ["/app/playground", "Playground"],
  ["/app/backtest", "Backtest"],
  ["/app/agents", "Agents"],
  ["/app/monitor", "Monitor"],
  ["/app/proof", "Proof"],
  ["/app/faucet", "Faucet"],
  ["/app/portfolio", "Portfolio"],
  ["/app/glossary", "Glossary"],
  ["/app/lessons", "Lessons"],
  ["/app/governance", "Governance"],
  ["/waitlist", "Mainnet waitlist"],
] as const;

/** Micro row on a hairline (every page, then project links), plus the eligibility and risk notice. */
export function Footer() {
  return (
    <footer className={styles.footer}>
      <span className="rule" />
      <div className={styles.footRow}>
        <span className="micro">Strike · weekly options vaults</span>
        <div className={styles.footNavs}>
          <nav aria-label="Pages" className={styles.footLinks}>
            {PAGES.map(([href, label]) => (
              <Link key={href} className="micro" href={href}>
                {label}
              </Link>
            ))}
          </nav>
          <nav aria-label="Project links" className={styles.footLinks}>
            <a className="micro" href={LINKS.github} target="_blank" rel="noreferrer">
              GitHub <ArrowUpRight aria-hidden />
            </a>
            <a className="micro" href={LINKS.docs} target="_blank" rel="noreferrer">
              Docs <ArrowUpRight aria-hidden />
            </a>
            <a className="micro" href={LINKS.judges} target="_blank" rel="noreferrer">
              Judges&apos; tour <ArrowUpRight aria-hidden />
            </a>
            <a className="micro" href={LINKS.skill} target="_blank" rel="noreferrer">
              SKILL.md <ArrowUpRight aria-hidden />
            </a>
            <a className="micro" href={LINKS.feedback} target="_blank" rel="noreferrer">
              Give feedback <ArrowUpRight aria-hidden />
            </a>
          </nav>
        </div>
        <a className={`micro ${styles.top}`} href="#top">
          Back to top <ArrowUp aria-hidden />
        </a>
      </div>
      <p className={styles.notice}>
        Not for US persons: Robinhood stock tokens are offered only to non-US persons, and Strike is not
        available to anyone in the United States. Strike is unaudited, experimental software running on test
        networks. Nothing here is investment advice.
      </p>
    </footer>
  );
}
