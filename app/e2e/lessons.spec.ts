import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { LESSONS, commitUrl, evidenceHref, fileUrl, lessonCounts, txUrl } from "../src/lib/lessons";
import { acknowledge, horizontalOverflow } from "./helpers";

// /app/lessons: what went wrong in the live runs (docs/evidence/lessons.json). First the data, without a browser: every
// lesson has evidence, a commit and a guard, every cited file and commit exists in this checkout, and every transaction
// names its chain and block (scripts/check-claims.mjs then checks it on chain). Then the page renders each lesson with
// working links, and /app/proof links to it.

const REPO = join(__dirname, "..", "..");
const SHALLOW =
  execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: REPO, encoding: "utf8" }).trim() ===
  "true";

test.describe("lessons data", () => {
  test.skip(({ isMobile }) => isMobile, "data checks run once, on desktop");

  test("every lesson is complete and every reference resolves in this checkout", () => {
    expect(LESSONS.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const l of LESSONS) {
      expect(ids.has(l.id), `duplicate id ${l.id}`).toBe(false);
      ids.add(l.id);
      expect(l.date, l.id).toMatch(/^2026-\d{2}-\d{2}$/);
      expect(["fixed", "mitigated", "open"]).toContain(l.status);
      for (const field of [l.title, l.happened, l.changed])
        expect(field.trim().length, l.id).toBeGreaterThan(20);
      expect(l.evidence.length, `${l.id}: evidence`).toBeGreaterThan(0);
      expect(l.commits.length, `${l.id}: commits`).toBeGreaterThan(0);
      expect(l.tests.length, `${l.id}: guarding tests`).toBeGreaterThan(0);
      for (const e of l.evidence) {
        expect(evidenceHref(e), `${l.id}: ${e.label}`).not.toBeNull();
        if (e.tx) {
          expect(e.tx, e.label).toMatch(/^0x[0-9a-f]{64}$/);
          expect(Number.isInteger(e.block) && e.block! > 0, `${e.label}: block`).toBe(true);
          expect(txUrl(e), e.label).toMatch(new RegExp(`/tx/${e.tx}$`));
        }
        if (e.path) expect(existsSync(join(REPO, e.path)), e.path).toBe(true);
      }
      for (const t of l.tests) expect(existsSync(join(REPO, t)), t).toBe(true);
      // CI checks out one commit deep, so the history may be absent: there the hashes are checked for form only, and
      // scripts/check-links.mjs resolves them in a full clone.
      for (const sha of l.commits) {
        expect(sha, l.id).toMatch(/^[0-9a-f]{7,40}$/);
        if (!SHALLOW)
          execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: REPO, stdio: "ignore" });
      }
    }
  });

  test("the summary counts come from the data", () => {
    const c = lessonCounts();
    expect(c.total).toBe(LESSONS.length);
    expect(c.fixed + c.open).toBe(c.total);
    const txs = new Set(LESSONS.flatMap((l) => l.evidence.flatMap((e) => (e.tx ? [e.tx] : []))));
    expect(c.txs).toBe(txs.size);
    expect(c.untested).toBe(LESSONS.filter((l) => l.testNote).length);
  });
});

test.describe("lessons page", () => {
  test.beforeEach(async ({ page }) => {
    await acknowledge(page);
  });

  test("lists every lesson with its status, evidence, commits and guarding tests", async ({ page }) => {
    await page.goto("/app/lessons");
    await expect(page.getByRole("heading", { level: 1, name: "Lessons" })).toBeVisible();
    const items = page.getByTestId("lesson");
    await expect(items).toHaveCount(LESSONS.length);
    for (const [i, l] of LESSONS.entries()) {
      const item = items.nth(i);
      await expect(item.getByRole("heading", { level: 2 })).toHaveText(l.title);
      await expect(item.getByTestId("lesson-status")).toHaveAttribute("data-status", l.status);
      await expect(item.getByTestId("lesson-evidence")).toHaveCount(l.evidence.length);
      for (const e of l.evidence)
        await expect(item.getByRole("link", { name: e.label })).toHaveAttribute("href", evidenceHref(e)!);
      for (const sha of l.commits)
        await expect(item.getByRole("link", { name: sha })).toHaveAttribute("href", commitUrl(sha));
      for (const t of l.tests)
        await expect(item.getByRole("link", { name: t, exact: true })).toHaveAttribute("href", fileUrl(t));
    }
    const c = lessonCounts();
    await expect(page.getByRole("region", { name: "Key figures" })).toContainText(`${c.total}`);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("the proof page links to the lessons, and the lessons lead on to the proof", async ({ page }) => {
    await page.goto("/app/proof");
    await page.getByTestId("proof-lessons-link").click();
    await expect(page).toHaveURL(/\/app\/lessons$/);
    await expect(page.getByTestId("page-purpose")).toContainText("what went wrong");
    await expect(page.getByTestId("next-step")).toHaveAttribute("href", "/app/proof");
  });
});
