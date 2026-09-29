import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ActivityFeed } from "@/components/app/activity/ActivityFeed";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHead } from "@/components/ui/SectionHead";
import styles from "./landing.module.css";

/** A black band with the live EpochManager feed on Robinhood Chain testnet, read from logs without a wallet. */
export function Live() {
  return (
    <section id="live" className={`theme-ink ${styles.live}`} aria-labelledby="live-title">
      <div className="gutter">
        <SectionHead index="06" label="Live on testnet" right="Robinhood Chain · 46630" hideRightOnMobile />
        <div className={styles.split}>
          <Reveal as="h2" id="live-title" className={`display-h2 ${styles.liveTitle}`}>
            Live on Robinhood Chain testnet
          </Reveal>
          <Reveal as="p" className="lead" delay={0.12}>
            The newest EpochManager events, read straight from the chain: epochs, proposals, rejections and
            sales. Each row links to its transaction on Blockscout.
          </Reveal>
        </div>
        <div className={styles.liveFeed}>
          <p className={`micro micro-muted ${styles.liveStatus}`}>
            <span className={styles.liveDot} aria-hidden />
            Newest first · refreshes every 30 s
          </p>
          <ActivityFeed limit={5} bare />
        </div>
        <div className={styles.liveLinks}>
          <Link href="/app/proof" className="micro text-link">
            Every claim with its evidence <ArrowUpRight size={12} aria-hidden />
          </Link>
          <Link href="/app" className="micro text-link">
            See the vaults <ArrowUpRight size={12} aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
