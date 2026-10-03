import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  BENEFITS,
  ELIGIBILITY,
  EVIDENCE,
  STAGES,
  STATUS_LABEL,
  PRIVACY,
  TELEGRAM_BOT,
  TELEGRAM_BOT_HANDLE,
  TRY_TODAY,
} from "../src/lib/waitlist";
import { horizontalOverflow } from "./helpers";

// /waitlist, the mainnet waitlist (D46). The sign-up form is inline (#join, waitlist-form.spec.ts tests it step by
// step; waitlist-api.spec.ts tests the route's logic), with a privacy notice beside it; the hero's button scrolls to it.
// Mobile first: no horizontal scroll at 360, 390 and 414 px, the hero's button above the fold, 44px tap targets and
// 16px body text.

const config = JSON.parse(readFileSync(join(__dirname, "..", "..", "strike.config.json"), "utf8")) as {
  services: { telegramBot: string };
};
const facts = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "docs", "evidence", "facts.json"), "utf8"),
) as { totals: { testsAndProofs: number }; coverage: { lines: number }; threats: number };

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

test("renders every section: hero, plan, benefits, try it, Telegram, questions and the disclaimer", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto("/waitlist");
  await expect(page).toHaveTitle(/^Mainnet waitlist · Strike$/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /Robinhood Chain mainnet/,
  );
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Strike on Robinhood Chain mainnet");
  await expect(page.getByRole("link", { name: /Get launch alerts on Telegram/ }).first()).toHaveAttribute(
    "href",
    TELEGRAM_BOT,
  );

  // The staged plan: every stage, in order, with its status as text (not colour alone).
  const stages = page.locator("#plan ol > li");
  await expect(stages).toHaveCount(STAGES.length);
  for (const [i, s] of STAGES.entries()) {
    await expect(stages.nth(i)).toHaveAttribute("data-status", s.status);
    await expect(stages.nth(i).getByRole("heading", { level: 3 })).toHaveText(s.title);
    await expect(stages.nth(i)).toContainText(STATUS_LABEL[s.status]);
  }
  await expect(page.locator("#plan")).toContainText("73");
  await expect(page.locator("#plan")).toContainText("no MirrorFeed");
  await expect(page.locator("#plan")).toContainText("has never been run");

  // The testnet evidence is facts.json's, not typed in.
  const evidence = page.locator("#plan dl");
  await expect(evidence).toContainText(facts.totals.testsAndProofs.toLocaleString("en-US"));
  await expect(evidence).toContainText(`${facts.coverage.lines}%`);
  await expect(evidence).toContainText(String(facts.threats));
  expect(EVIDENCE[0].value).toBe("2");

  for (const b of BENEFITS) await expect(page.locator("#benefits")).toContainText(b.title);
  await expect(page.locator("#benefits")).toContainText("No yield is promised");

  const doors = page.locator("#try ul a");
  await expect(doors).toHaveCount(TRY_TODAY.length);
  for (const [i, d] of TRY_TODAY.entries()) await expect(doors.nth(i)).toHaveAttribute("href", d.href);

  // The screenshot loads and fits its column.
  const shot = page.locator("#telegram figure img");
  await shot.scrollIntoViewIfNeeded();
  await expect(page.locator("#telegram figcaption")).toHaveText("Example: the bot answering /vaults");
  await expect
    .poll(() => shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBe(565);
  const box = (await shot.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await expect(page.locator("#faq details")).toHaveCount(5);
  await expect(page.getByRole("heading", { name: "Disclaimer" })).toBeAttached();
  await expect(page.locator("main")).toContainText("no guarantee that a mainnet vault will launch");
  expect(errors).toEqual([]);
});

test("the primary button goes to the form on the page, and the privacy notice sits beside it", async ({
  page,
}) => {
  await page.goto("/waitlist");
  const primary = page.getByTestId("waitlist-primary");
  await expect(primary).toHaveAttribute("href", "#join");
  await expect(primary).not.toHaveAttribute("target");
  await expect(primary).toHaveAccessibleName("Join the waitlist");
  await expect(page.getByTestId("waitlist-note")).toContainText(
    "We'll contact you when the first mainnet vault opens.",
  );
  const signup = page.locator('[aria-labelledby="status-title"] dl > div').filter({ hasText: "Sign-up" });
  await expect(signup.locator("dd")).toHaveText("Open");

  await primary.click();
  await expect(page).toHaveURL(/#join$/);
  await expect(page.locator("#join form")).toBeVisible();
  await expect(page.getByLabel("What's your email?")).toBeFocused();

  // The privacy notice: what, why, who, how long, removal.
  const notice = page.locator("#privacy");
  await expect(notice.getByRole("heading", { name: "Privacy notice" })).toBeAttached();
  await expect(notice.locator("dt")).toHaveText(PRIVACY.map((p) => p.term));
  await expect(notice).toContainText("Only the Strike team");
  await expect(notice).toContainText("launch plus 12 months");
  await expect(notice).toContainText(`message ${TELEGRAM_BOT_HANDLE} on Telegram`);
  expect(TELEGRAM_BOT_HANDLE).toBe(`@${config.services.telegramBot.split("/").pop()}`);
});

test("the questions open and close from the keyboard, and the eligibility answer is the footer's sentence", async ({
  page,
}) => {
  await page.goto("/waitlist");
  const who = page.locator("#faq details").first();
  const summary = who.locator("summary");
  await expect(summary).toHaveText("Who can join?");
  await expect(who).not.toHaveAttribute("open");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(who).toHaveAttribute("open");
  await expect(who.getByText(ELIGIBILITY)).toBeVisible();
  // Word for word what the site footer says.
  await expect(page.locator("footer")).toContainText(ELIGIBILITY);
  await page.keyboard.press("Enter");
  await expect(who).not.toHaveAttribute("open");

  for (const q of [
    "Where do my details go?",
    "Is Strike audited?",
    "What are the risks?",
    "How do I get removed?",
  ]) {
    const item = page.locator("#faq details").filter({ hasText: q });
    await item.locator("summary").click();
    await expect(item).toHaveAttribute("open");
  }
  await expect(page.locator("#faq")).toContainText("only the team, holding the private key, can read it");
  await expect(page.locator("#faq")).toContainText(`message ${TELEGRAM_BOT_HANDLE} on Telegram`);
  await expect(page.locator("#faq")).toContainText("Covered calls give up upside for income.");
  await expect(page.locator("#faq")).toContainText("Not yet.");
});

test("the landing page and the footer link to the waitlist", async ({ page }) => {
  await page.goto("/");
  const cta = page.locator("main").getByRole("link", { name: "Join the mainnet waitlist" });
  await expect(cta.first()).toHaveAttribute("href", "/waitlist");
  await expect(page.getByRole("navigation", { name: "Pages" }).first()).toContainText("Mainnet waitlist");
  await cta.first().scrollIntoViewIfNeeded();
  await cta.first().click();
  await expect(page).toHaveURL(/\/waitlist$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Strike on Robinhood Chain mainnet");
});

for (const width of [360, 390, 414]) {
  test(`phone width ${width}px: no horizontal scroll, the button above the fold, 44px targets, 16px text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/waitlist");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // The headline and the primary button are on the first screen, without scrolling.
    const primary = page.getByTestId("waitlist-primary");
    const b = (await primary.boundingBox())!;
    expect(b.y + b.height).toBeLessThanOrEqual(844);
    await expect(page.getByRole("heading", { level: 1 })).toBeInViewport();

    // Every link, summary and button in the page's content is at least 44px tall (text links through their
    // ::after hit area).
    const small = await page.locator("main").evaluate((main) => {
      const out: string[] = [];
      for (const el of main.querySelectorAll<HTMLElement>("a, summary, button")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const after = getComputedStyle(el, "::after");
        const hit = Math.max(r.height, after.content !== "none" ? parseFloat(after.height) || 0 : 0);
        if (hit < 44) out.push(`${el.textContent?.trim().slice(0, 40)} (${Math.round(hit)}px)`);
      }
      return out;
    });
    expect(small).toEqual([]);

    // Body copy is at least 16px.
    const tiny = await page
      .locator("main")
      .evaluate((main) =>
        [...main.querySelectorAll<HTMLElement>("p, dd, li > p")]
          .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16)
          .map((el) => el.textContent?.trim().slice(0, 40)),
      );
    expect(tiny).toEqual([]);

    // The plan's stages stack: one column, each as wide as the content.
    const widths = await page
      .locator("#plan ol > li")
      .evaluateAll((lis) => lis.map((li) => Math.round(li.getBoundingClientRect().width)));
    expect(new Set(widths).size).toBe(1);

    // After scrolling the whole page, still nothing wider than the screen.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}
