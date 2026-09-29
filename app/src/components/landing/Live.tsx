import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { explorerUrl } from "@/lib/chains";
import { fmtNy, shortAddr } from "@/lib/format";
import { LIVE_EVENTS, LIVE_EVENTS_CHAIN_ID } from "@/lib/testnetEvents";
import styles from "./landing.module.css";

/** Today's real on-chain events on Robinhood Chain testnet, each linked to its transaction on Blockscout. */
export function Live() {
  return (
    <section id="live" className={`theme-paper-2 ${styles.live}`} aria-labelledby="live-title">
      <div className={`gutter ${styles.rail}`}>
        <div className={styles.railLabel}>
          <span className="index">05</span>
          <span className="micro">Live on testnet</span>
        </div>
        <div className={styles.railBody}>
          <Reveal as="h2" id="live-title" className="display-h2">
            Live on Robinhood Chain testnet
          </Reveal>
          <Reveal as="p" className="body" delay={0.1}>
            The first epoch runs on chain {LIVE_EVENTS_CHAIN_ID} now. Each step below is a transaction you can
            check on Blockscout.
          </Reveal>
          <ol className={styles.liveList}>
            {LIVE_EVENTS.map((e, i) => {
              const href = explorerUrl(LIVE_EVENTS_CHAIN_ID, "tx", e.tx);
              return (
                <Reveal as="li" key={e.tx} className={styles.liveItem} delay={i * 0.07}>
                  <span className="index">{String(i + 1).padStart(2, "0")}</span>
                  <div className={styles.liveMain}>
                    <span className={`micro ${styles.liveEvent}`} data-tone={e.tone}>
                      {e.event}
                    </span>
                    <strong className="h3">{e.title}</strong>
                    <p>{e.text}</p>
                    <span className={`mono ${styles.liveMeta}`}>
                      {fmtNy(e.time)} ·{" "}
                      {href ? (
                        <a href={href} target="_blank" rel="noreferrer" className="text-link">
                          Tx {shortAddr(e.tx)} <ArrowUpRight size={12} aria-hidden />
                        </a>
                      ) : (
                        shortAddr(e.tx)
                      )}
                    </span>
                  </div>
                </Reveal>
              );
            })}
          </ol>
          <Link href="/app" className={`micro text-link ${styles.liveCta}`}>
            See the vaults live <ArrowUpRight size={12} aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
