// What went wrong in Strike's live runs and what changed: docs/evidence/lessons.json, rendered at /app/lessons.
// scripts/check-claims.mjs checks every cited transaction on its chain and scripts/check-links.mjs every path and
// commit, so nothing here is typed in by hand without a check behind it.
//
// Data only (no SDK import), so the Playwright specs can load it as CommonJS.
import strikeConfig from "../../../strike.config.json";
import data from "../../../docs/evidence/lessons.json";

const REPO = strikeConfig.services.repository;

export type LessonStatus = "fixed" | "mitigated" | "open";

export interface LessonEvidence {
  label: string;
  /** A transaction, with the block it is in (check-claims compares both). */
  chainId?: number;
  tx?: string;
  block?: number;
  /** A file in this repository. */
  path?: string;
  /** Anything else, such as a CI run. */
  url?: string;
}

export interface Lesson {
  id: string;
  date: string;
  title: string;
  happened: string;
  evidence: LessonEvidence[];
  changed: string;
  commits: string[];
  tests: string[];
  /** Said when no automated test guards the change. */
  testNote?: string;
  status: LessonStatus;
}

export const LESSONS: readonly Lesson[] = data.lessons as Lesson[];
export const LESSONS_SOURCE = "docs/evidence/lessons.json";

export const STATUS_LABEL: Record<LessonStatus, string> = {
  fixed: "Fixed",
  mitigated: "Mitigated",
  open: "Open",
};

export const fileUrl = (path: string) =>
  `${REPO}/${path.endsWith("/") ? "tree" : "blob"}/main/${path.replace(/\/$/, "")}`;
export const commitUrl = (sha: string) => `${REPO}/commit/${sha}`;

const chains = strikeConfig.chains as unknown as Record<string, { name?: string; explorer?: string | null }>;

/** The explorer link for a cited transaction, or null for a chain with no explorer in strike.config.json. */
export function txUrl(e: LessonEvidence): string | null {
  const explorer = e.chainId ? chains[String(e.chainId)]?.explorer : undefined;
  return e.tx && explorer ? `${explorer.replace(/\/$/, "")}/tx/${e.tx}` : null;
}

export function chainName(chainId: number): string {
  return chains[String(chainId)]?.name ?? `chain ${chainId}`;
}

/** Where an evidence item points: a transaction, a file, or another page. */
export function evidenceHref(e: LessonEvidence): string | null {
  return txUrl(e) ?? (e.path ? fileUrl(e.path) : (e.url ?? null));
}

/** Counts for the summary strip, all from the data. */
export function lessonCounts(list: readonly Lesson[] = LESSONS) {
  return {
    total: list.length,
    fixed: list.filter((l) => l.status === "fixed").length,
    open: list.filter((l) => l.status !== "fixed").length,
    txs: new Set(list.flatMap((l) => l.evidence.flatMap((e) => (e.tx ? [e.tx.toLowerCase()] : [])))).size,
    commits: new Set(list.flatMap((l) => l.commits)).size,
    tests: new Set(list.flatMap((l) => l.tests)).size,
    untested: list.filter((l) => l.testNote).length,
  };
}

export const fmtLessonDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
