import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHead } from "@/components/ui/SectionHead";
import { explorerUrl } from "@/lib/chains";
import { shortAddr } from "@/lib/format";
import styles from "./landing.module.css";

type Line = { t: string; kind?: "ok" | "bad" | "dim" | "cmd" };

/** Robinhood Chain testnet, where the 2026-09-29 run below happened (docs/testnet-epochs/2026-09-29.md). */
const RUN_CHAIN = 46630;

const CARDS: {
  tone: "call" | "put";
  index: string;
  title: string;
  event: string;
  tx: string;
  lines: Line[];
}[] = [
  {
    tone: "call",
    index: "01",
    title: "Inside the mandate",
    event: "SeriesProposed",
    tx: "0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4",
    lines: [
      { t: "proposeByDelta(sTSLA-CC, Δ 0.20, Oct 2)", kind: "cmd" },
      { t: "spot $352.45 · K $369.86 · fair $2.13", kind: "dim" },
      { t: "✓ |delta| 0.20 inside 0.10 – 0.35", kind: "ok" },
      { t: "✓ price 100% ≥ 95% of fair value", kind: "ok" },
      { t: "✓ size 4 of 5 ≤ 80% of capacity", kind: "ok" },
      { t: "✓ tenor 3.1 days, inside 1 – 8", kind: "ok" },
      { t: "→ on sale · agent #1: 1 accepted", kind: "cmd" },
    ],
  },
  {
    tone: "put",
    index: "02",
    title: "Outside the mandate",
    event: "ProposalRejected",
    tx: "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0",
    lines: [
      { t: "proposeSeries(sTSLA-CSP, K=$352.44)", kind: "cmd" },
      { t: "spot $352.45 · at the money", kind: "dim" },
      { t: "✗ |delta| 0.4887 outside 0.10 – 0.35", kind: "bad" },
      { t: "ProposalRejected(DeltaOutOfBand)", kind: "dim" },
      { t: "slash(agent #1): 10 USDG → depositors", kind: "bad" },
      { t: "bond 60 → 50 USDG · strikes 1 / 3", kind: "bad" },
      { t: "→ still active · suspended at 3 / 3", kind: "cmd" },
    ],
  },
];

export function Agents() {
  return (
    <section id="agents" className={`theme-ink ${styles.agents}`} aria-labelledby="agents-title">
      <div className="gutter">
        <SectionHead
          index="04"
          label="Agents & mandates"
          right="AgentRegistry · MandateGuard"
          hideRightOnMobile
        />
        <div className={styles.split}>
          <Reveal as="h2" id="agents-title" className={`display-project ${styles.agentsTitle}`}>
            Agents propose. The contract decides.
          </Reveal>
          <Reveal as="p" className="lead" delay={0.12}>
            Every vault has one agent and a mandate fixed at creation. The agent only proposes and never
            touches funds. A proposal outside the mandate is rejected on-chain, and the agent&apos;s USDG bond
            is slashed to the vault&apos;s depositors.
          </Reveal>
        </div>
        <div className={styles.cards}>
          {CARDS.map((c) => (
            <article key={c.index} className={styles.card}>
              <div className={styles.cardTop}>
                <span className="index">{c.index}</span>
                <span className="micro">{c.title}</span>
                <span className={`micro ${styles.cardEvent}`}>{c.event}</span>
              </div>
              <Reveal variant="wipe" className={`${styles.media} ${styles[`media_${c.tone}`]}`}>
                <span className={styles.ghost} aria-hidden>
                  {c.index}
                </span>
                <div
                  className={styles.terminal}
                  role="img"
                  aria-label={`${c.title}: ${c.lines.map((l) => l.t).join(". ")}`}
                >
                  <div className={styles.termBar} aria-hidden>
                    <i />
                    <i />
                    <i />
                    <span>Agent #1 · ERC-8004 #114</span>
                  </div>
                  <ol className={styles.termLines} aria-hidden>
                    {c.lines.map((l, i) => (
                      <Reveal
                        as="li"
                        key={l.t}
                        variant="fade"
                        delay={0.35 + i * 0.12}
                        className={styles[`t_${l.kind ?? "plain"}`]}
                      >
                        {l.t}
                      </Reveal>
                    ))}
                  </ol>
                </div>
                <a
                  className={styles.mediaPill}
                  href={explorerUrl(RUN_CHAIN, "tx", c.tx) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${c.event} transaction ${c.tx} on Blockscout`}
                >
                  Tx {shortAddr(c.tx)} <ArrowUpRight aria-hidden />
                </a>
              </Reveal>
            </article>
          ))}
        </div>
        <p className={`micro micro-muted ${styles.cardsNote}`}>
          Both proposals are from one live run on Robinhood Chain testnet, 2026-09-29, by agent #1 (ERC-8004
          identity #114).
        </p>
        <div className={styles.scope}>
          <span className="micro">The mandate</span>
          <span className={styles.scopeList}>
            Delta band · Minimum price vs Black-Scholes fair value · Minimum yield · Maximum share of the
            vault sold · Tenor limits · USDG bond, slashed per rejection · Suspended at three strikes
          </span>
          <Link href="/app/agents" className="micro text-link">
            Leaderboard <ArrowUpRight size={12} aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}
