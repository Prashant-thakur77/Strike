import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHead } from "@/components/ui/SectionHead";
import styles from "./landing.module.css";

type Line = { t: string; kind?: "ok" | "bad" | "dim" | "cmd" };

const CARDS: {
  tone: "call" | "put";
  index: string;
  title: string;
  event: string;
  cta: string;
  lines: Line[];
}[] = [
  {
    tone: "call",
    index: "01",
    title: "Inside the mandate",
    event: "SeriesProposed",
    cta: "Series goes on sale",
    lines: [
      { t: "proposeSeries(TSLA-CC, K=$407, Fri 16:00, 59, 100%)", kind: "cmd" },
      { t: "spot $381.12 · fair value $2.31 · Δ 0.22", kind: "dim" },
      { t: "✓ delta 0.22 inside 0.10 – 0.35", kind: "ok" },
      { t: "✓ price 100% ≥ 95% of fair value", kind: "ok" },
      { t: "✓ size 59 ≤ 80% of capacity", kind: "ok" },
      { t: "✓ expiry is an NYSE close, 4.3 days out", kind: "ok" },
      { t: "→ series live · buyers pay USDG", kind: "cmd" },
    ],
  },
  {
    tone: "put",
    index: "02",
    title: "Outside the mandate",
    event: "ProposalRejected",
    cta: "Bond pays depositors",
    lines: [
      { t: "proposeSeries(TSLA-CSP, K=$391, Fri 16:00, 5, 100%)", kind: "cmd" },
      { t: "spot $381.12 · put strike above spot", kind: "dim" },
      { t: "✗ StrikeWrongSide: in the money", kind: "bad" },
      { t: "ProposalRejected(reason = 4) — no revert", kind: "dim" },
      { t: "slash(agent 3): 10 USDG → vault depositors", kind: "bad" },
      { t: "strikes 3 / 3 → agent suspended", kind: "bad" },
      { t: "→ curator hands the vault to another agent", kind: "cmd" },
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
                    <span>EpochManager</span>
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
                <span className={styles.mediaPill}>
                  {c.cta} <ArrowRight aria-hidden />
                </span>
              </Reveal>
            </article>
          ))}
        </div>
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
