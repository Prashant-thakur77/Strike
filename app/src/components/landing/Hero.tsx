import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";
import { FitText } from "@/components/ui/FitText";
import { PayoffVisual } from "./PayoffVisual";
import styles from "./landing.module.css";

/** Full-height paper hero: justified display headline, and a covered-call payoff chart in clear space beneath it. */
export function Hero() {
  return (
    <section className={`theme-paper ${styles.hero}`} aria-labelledby="hero-title">
      <h1 id="hero-title" className="sr-only">
        Strike: stock tokens that pay every week
      </h1>
      <div className={styles.heroType} aria-hidden>
        <FitText
          className={styles.linesWide}
          lines={["Stock tokens", "that pay", "every week"]}
          estimates={[10.9, 16.3, 13.1]}
        />
        <FitText
          className={styles.linesNarrow}
          lines={["Stock", "tokens", "that pay", "every week"]}
          estimates={[25, 21.5, 16.5, 13.4]}
        />
      </div>
      <div className={styles.heroFoot}>
        <p className={styles.heroPitch}>
          Weekly options vaults for Robinhood Chain stock tokens. Premium paid in USDG, strikes picked by AI
          agents the contract keeps inside a mandate.
        </p>
        <PayoffVisual />
        <Link href="/app" className={`pill ${styles.heroCta}`}>
          Open app <ArrowRight aria-hidden />
        </Link>
      </div>
      <div className={styles.heroMeta}>
        {/* Each name keeps its separator, so a wrapped line never starts with "·". */}
        <span className="micro">
          <span style={{ whiteSpace: "nowrap" }}>Robinhood Chain ·</span>{" "}
          <span style={{ whiteSpace: "nowrap" }}>USDG ·</span>{" "}
          <span style={{ whiteSpace: "nowrap" }}>Arbitrum Stylus</span>
        </span>
        <a href="#problem" className={`micro ${styles.scrollCue}`}>
          Scroll to explore <ArrowDown aria-hidden />
        </a>
      </div>
    </section>
  );
}
