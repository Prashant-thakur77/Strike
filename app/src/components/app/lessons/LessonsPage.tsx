import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  LESSONS,
  LESSONS_SOURCE,
  STATUS_LABEL,
  chainName,
  commitUrl,
  evidenceHref,
  fileUrl,
  fmtLessonDate,
  lessonCounts,
  type Lesson,
} from "@/lib/lessons";
import { MetaStrip } from "../MetaStrip";
import { PageHero } from "../PageHero";
import styles from "./lessons.module.css";

function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-link">
      {children} <ArrowUpRight size={11} aria-hidden />
    </a>
  );
}

/** What went wrong in Strike's live runs, each with its evidence, the change it led to and what now guards it. */
export function LessonsPage() {
  const c = lessonCounts();
  return (
    <>
      <PageHero
        label="Lessons"
        title="Lessons"
        lead={
          <p className="lead">
            Every entry happened on a public testnet, in CI or in a rehearsal on a fork. Each one links to its
            evidence, the commit that changed something and the test that now guards it. The list lives in{" "}
            <Out href={fileUrl(LESSONS_SOURCE)}>{LESSONS_SOURCE}</Out>; a script checks every cited
            transaction on its chain and every file and commit in the repository.
          </p>
        }
      />
      <MetaStrip
        cells={[
          { label: "Lessons", value: String(c.total), sub: `${c.fixed} fixed · ${c.open} not yet` },
          { label: "Transactions cited", value: String(c.txs), sub: "each checked on its chain" },
          { label: "Commits", value: String(c.commits), sub: "the changes they led to" },
          {
            label: "Guarding tests",
            value: String(c.tests),
            sub: c.untested
              ? `${c.untested} lesson without a unit test, said below`
              : "one or more per lesson",
          },
        ]}
      />
      <ol className={`gutter ${styles.list}`} aria-label="Lessons, oldest first" data-testid="lessons">
        {LESSONS.map((l, i) => (
          <LessonItem key={l.id} lesson={l} index={i} />
        ))}
      </ol>
    </>
  );
}

function LessonItem({ lesson: l, index }: { lesson: Lesson; index: number }) {
  return (
    <li className={styles.lesson} id={l.id} data-testid="lesson">
      <div className={styles.head}>
        <span className="index">{String(index + 1).padStart(2, "0")}</span>
        <time className="micro micro-muted" dateTime={l.date}>
          {fmtLessonDate(l.date)}
        </time>
        <span className={styles.status} data-status={l.status} data-testid="lesson-status">
          {STATUS_LABEL[l.status]}
        </span>
      </div>
      <div className={styles.body}>
        <h2 className={`h3 ${styles.title}`}>{l.title}</h2>
        <div className={styles.part}>
          <span className="micro micro-muted">What happened</span>
          <p>{l.happened}</p>
        </div>
        <div className={styles.part}>
          <span className="micro micro-muted">Evidence</span>
          <ul className={styles.links} aria-label="Evidence">
            {l.evidence.map((e) => {
              const href = evidenceHref(e);
              const where = e.tx && e.chainId ? ` (${chainName(e.chainId)}, block ${e.block})` : "";
              return (
                <li key={e.label} data-testid="lesson-evidence">
                  {href ? <Out href={href}>{e.label}</Out> : e.label}
                  <span className={styles.note}>{where}</span>
                </li>
              );
            })}
          </ul>
        </div>
        <div className={styles.part}>
          <span className="micro micro-muted">What we changed</span>
          <p>{l.changed}</p>
          <ul className={styles.links} aria-label="Commits">
            {l.commits.map((sha) => (
              <li key={sha}>
                <Out href={commitUrl(sha)}>
                  <span className="mono">{sha}</span>
                </Out>
              </li>
            ))}
          </ul>
        </div>
        <div className={styles.part}>
          <span className="micro micro-muted">Guarded by</span>
          <ul className={styles.links} aria-label="Guarding tests">
            {l.tests.map((t) => (
              <li key={t}>
                <Out href={fileUrl(t)}>
                  <span className="mono">{t}</span>
                </Out>
              </li>
            ))}
          </ul>
          {l.testNote ? <p className={styles.note}>{l.testNote}</p> : null}
        </div>
      </div>
    </li>
  );
}
