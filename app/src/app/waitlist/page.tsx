import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Plus } from "lucide-react";
import { Footer } from "@/components/site/Footer";
import { SiteNav } from "@/components/site/SiteNav";
import { SectionHead } from "@/components/ui/SectionHead";
import { REPO_URL } from "@/lib/config";
import {
  BENEFITS,
  ELIGIBILITY,
  EVIDENCE,
  FACTS_DATE,
  FACTS_SOURCE,
  STAGES,
  STATUS_LABEL,
  TELEGRAM_BOT,
  TRY_TODAY,
  waitlistCta,
} from "@/lib/waitlist";
import landing from "@/components/landing/landing.module.css";
import styles from "./waitlist.module.css";

export const metadata: Metadata = {
  title: "Mainnet waitlist",
  description:
    "Join the waitlist for Strike on Robinhood Chain mainnet: one capped options vault after an external audit. Sign-up is the Strike team's own form; Strike's app stores no personal data.",
};

const NEW_TAB = <span className="sr-only"> (opens in a new tab)</span>;

/** /waitlist: Strike's mainnet launch page. Sign-up is the team's own form (D46); this page stores nothing. */
export default function WaitlistPage() {
  const cta = waitlistCta();
  const STATUS = [
    ["Testnets", `Live on ${EVIDENCE[0].value}`],
    ["External audit", "Not started"],
    ["Mainnet vault", "Not deployed"],
    ["Sign-up", cta.kind === "form" ? "Open" : "Opens shortly"],
  ] as const;

  return (
    <>
      <SiteNav />
      <main id="main">
        {/* Hero: the headline, the form button and the Telegram option, all above the fold on a phone. */}
        <section className={`theme-paper ${styles.hero}`} aria-labelledby="waitlist-title">
          <div className={`gutter ${styles.heroGrid}`}>
            <div className={styles.heroMain}>
              <span className="micro">
                <span className={styles.liveDot} aria-hidden />
                Mainnet waitlist
              </span>
              <h1 id="waitlist-title" className={styles.title}>
                Strike on Robinhood Chain <span className="outline-text">mainnet</span>
              </h1>
              <p className={styles.pitch}>
                Weekly covered calls and cash-secured puts on your stock tokens, paid in USDG, with AI agents
                picking the strike inside a mandate the contract enforces.
              </p>
              <div className={styles.actions}>
                <a
                  href={cta.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`pill ${styles.primary}`}
                  data-testid="waitlist-primary"
                  data-kind={cta.kind}
                >
                  {cta.label} <ArrowUpRight aria-hidden />
                  {NEW_TAB}
                </a>
                <p className={styles.note} data-testid="waitlist-note">
                  {cta.note}
                </p>
                <a
                  href={TELEGRAM_BOT}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`pill pill-ghost ${styles.secondary}`}
                >
                  Get launch alerts on Telegram <ArrowUpRight aria-hidden />
                  {NEW_TAB}
                </a>
              </div>
            </div>
            <aside className={styles.status} aria-labelledby="status-title">
              <h2 id="status-title" className="micro">
                Where it stands today
              </h2>
              <dl>
                {STATUS.map(([k, v]) => (
                  <div key={k} className={styles.statusRow}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <a href="#plan" className={`micro text-link ${styles.statusLink}`}>
                The plan <ArrowRight size={12} aria-hidden />
              </a>
            </aside>
          </div>
        </section>

        {/* 01: the staged plan, each stage marked as it is today, and the testnet evidence behind stage one. */}
        <section id="plan" className={`theme-paper-2 ${styles.section}`} aria-labelledby="plan-title">
          <div className="gutter">
            <SectionHead
              index="01"
              label="What launches first"
              right="No dates until they are fixed"
              hideRightOnMobile
            />
            <h2 id="plan-title" className={`display-h2 ${styles.h2}`}>
              Testnets first. Mainnet after an audit.
            </h2>
            <ol className={styles.stages}>
              {STAGES.map((s, i) => (
                <li key={s.title} className={styles.stage} data-status={s.status}>
                  <div className={styles.stageMeta}>
                    <span className="index">{String(i + 1).padStart(2, "0")}</span>
                    <span className={`micro ${styles.badge}`} data-status={s.status}>
                      <span className={styles.badgeDot} aria-hidden />
                      {STATUS_LABEL[s.status]}
                    </span>
                  </div>
                  <h3 className={`h3 ${styles.stageTitle}`}>{s.title}</h3>
                  <div className={styles.stageBody}>
                    <p>{s.text}</p>
                    {s.link.href.startsWith("/") ? (
                      <Link href={s.link.href} className="micro text-link">
                        {s.link.label} <ArrowRight size={12} aria-hidden />
                      </Link>
                    ) : (
                      <a
                        href={s.link.href}
                        className="micro text-link"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {s.link.label} <ArrowUpRight size={12} aria-hidden />
                        {NEW_TAB}
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ol>

            <h3 className={`micro ${styles.subhead}`}>The testnet evidence</h3>
            <dl className={styles.evidence}>
              {EVIDENCE.map((e) => (
                <div key={e.label} className={styles.stat}>
                  <dt className="micro">{e.label}</dt>
                  <dd>
                    <span className={styles.statValue}>{e.value}</span>
                    <span className={styles.statDetail}>{e.detail}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className={styles.source}>
              Measured by the command behind each count, in{" "}
              <a
                href={`${REPO_URL}/blob/main/${FACTS_SOURCE}`}
                className="text-link"
                target="_blank"
                rel="noopener noreferrer"
              >
                {FACTS_SOURCE}
                {NEW_TAB}
              </a>{" "}
              ({FACTS_DATE}). Addresses and transactions:{" "}
              <a
                href={`${REPO_URL}/blob/main/docs/DEPLOYMENTS.md`}
                className="text-link"
                target="_blank"
                rel="noopener noreferrer"
              >
                DEPLOYMENTS.md
                {NEW_TAB}
              </a>
              .
            </p>
          </div>
        </section>

        {/* 02: what the list gets you, and what it does not. */}
        <section id="benefits" className={`theme-paper ${styles.section}`} aria-labelledby="benefits-title">
          <div className="gutter">
            <SectionHead index="02" label="What joining gets you" />
            <h2 id="benefits-title" className={`display-h2 ${styles.h2}`}>
              First in, when it opens.
            </h2>
            <ul className={styles.benefits}>
              {BENEFITS.map((b, i) => (
                <li key={b.title} className={styles.benefit}>
                  <span className="index">{String(i + 1).padStart(2, "0")}</span>
                  <h3 className="h3">{b.title}</h3>
                  <p>{b.text}</p>
                </li>
              ))}
            </ul>
            <p className={styles.noYield}>
              <strong>No yield is promised.</strong> What a vault earns depends on each week&apos;s option
              sales and on the stock&apos;s price at expiry.
            </p>
          </div>
        </section>

        {/* 03: the testnet app, today, no sign-up needed. */}
        <section id="try" className={`theme-paper-2 ${styles.section}`} aria-labelledby="try-title">
          <div className="gutter">
            <SectionHead index="03" label="Try it today on testnet" right="No real funds" hideRightOnMobile />
            <h2 id="try-title" className={`display-h2 ${styles.h2}`}>
              Don&rsquo;t wait for mainnet.
            </h2>
            <ul className={`${landing.doors} ${styles.doors}`}>
              {TRY_TODAY.map((d, i) => (
                <li key={d.href}>
                  <Link href={d.href} className={landing.door}>
                    <span className={landing.doorTop}>
                      <span className="index">{String(i + 1).padStart(2, "0")}</span>
                      <span className={landing.doorArrow} aria-hidden>
                        <ArrowUpRight strokeWidth={1.5} />
                      </span>
                    </span>
                    <span className={`${landing.doorName} ${styles.doorName}`}>{d.name}</span>
                    <span className={landing.doorText}>{d.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 04: the Telegram bot, with a real screenshot of it. */}
        <section id="telegram" className={`theme-ink ${styles.section}`} aria-labelledby="telegram-title">
          <div className={`gutter ${styles.telegram}`}>
            <div className={styles.telegramBody}>
              <span className="micro">04 · Launch alerts</span>
              <h2 id="telegram-title" className={`display-h2 ${styles.h2}`}>
                Hear it on Telegram.
              </h2>
              <p className={styles.bodyText}>
                The Strike bot posts each epoch, proposal, rejection, sale and settlement, and answers
                read-only lookups like /vaults and /quote. It never asks for keys and cannot send
                transactions. No email needed: subscribe in the chat, and unsubscribe the same way.
              </p>
              <a
                href={TELEGRAM_BOT}
                target="_blank"
                rel="noopener noreferrer"
                className={`pill pill-accent ${styles.telegramCta}`}
              >
                Get launch alerts on Telegram <ArrowUpRight aria-hidden />
                {NEW_TAB}
              </a>
            </div>
            <figure className={styles.shot}>
              {/* A plain img with its size set, so it scales to the column without a layout shift. */}
              <img
                src="/telegram-bot.png"
                width={565}
                height={846}
                loading="lazy"
                decoding="async"
                alt="A Telegram chat with the Strike Alerts bot: its command list, a subscription confirmation, and its reply to /vaults listing three TSLA vaults with their epoch, value locked and live series."
              />
              <figcaption className="micro">Example: the bot answering /vaults</figcaption>
            </figure>
          </div>
        </section>

        {/* 05: questions, as native disclosure widgets (keyboard and screen-reader friendly without script). */}
        <section id="faq" className={`theme-paper ${styles.section}`} aria-labelledby="faq-title">
          <div className="gutter">
            <SectionHead index="05" label="Questions" />
            <h2 id="faq-title" className={`display-h2 ${styles.h2}`}>
              Before you sign up.
            </h2>
            <div className={styles.faq}>
              <details className={styles.qa}>
                <summary>
                  <span>Who can join?</span>
                  <Plus aria-hidden />
                </summary>
                <div className={styles.answer}>
                  <p>{ELIGIBILITY}</p>
                  <p>If that rules you out, please do not sign up.</p>
                </div>
              </details>
              <details className={styles.qa}>
                <summary>
                  <span>Where do my details go?</span>
                  <Plus aria-hidden />
                </summary>
                <div className={styles.answer}>
                  <p>
                    Only to the sign-up form, which the Strike team runs
                    {cta.provider ? ` on ${cta.provider}` : " on Google Forms or Tally"}. Strike&apos;s app
                    stores nothing: this page is a link to the form, and the app has no user database or
                    mailing list.
                  </p>
                  <p>We use your details only to contact you about the mainnet launch.</p>
                </div>
              </details>
              <details className={styles.qa}>
                <summary>
                  <span>Is Strike audited?</span>
                  <Plus aria-hidden />
                </summary>
                <div className={styles.answer}>
                  <p>
                    Not yet. An external audit comes before the mainnet vault, and it has not started:{" "}
                    <a href="#plan" className="text-link">
                      see the plan
                    </a>
                    . The internal reviews, the threat model and the test suites are public in the repository.
                  </p>
                </div>
              </details>
              <details className={styles.qa}>
                <summary>
                  <span>What are the risks?</span>
                  <Plus aria-hidden />
                </summary>
                <div className={styles.answer}>
                  <p>
                    Covered calls give up upside for income. If the stock rises past the strike, the vault
                    sells it at the strike; a cash-secured put can end up buying the stock above its market
                    price.
                  </p>
                  <p>
                    Options can lose money. Smart contracts can have bugs, and Strike has had no external
                    audit yet.
                  </p>
                </div>
              </details>
              <details className={styles.qa}>
                <summary>
                  <span>How do I get removed?</span>
                  <Plus aria-hidden />
                </summary>
                <div className={styles.answer}>
                  <p>
                    Reply to any message we send you, or email or message the team on Telegram, and we delete
                    your entry. No reason needed.
                  </p>
                </div>
              </details>
            </div>
          </div>
        </section>

        <section className={`theme-paper gutter ${styles.disclaimer}`} aria-labelledby="disclaimer-title">
          <h2 id="disclaimer-title" className="micro">
            Disclaimer
          </h2>
          <p>
            Strike is testnet software: unaudited and experimental. This page is not an offer to sell, or a
            solicitation to buy, any security, token or financial product, and nothing on it is financial
            advice. There is no guarantee that a mainnet vault will launch, or when.
          </p>
        </section>
      </main>
      <div className="theme-paper">
        <Footer />
      </div>
    </>
  );
}
