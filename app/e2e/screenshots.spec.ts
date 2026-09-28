import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { acknowledge, connectWallet, devnetUp, installMockWallet, revealAll, settle } from "./helpers";

// Captures every section of every page into screenshots/{desktop,mobile}/ by stepping through each page one
// viewport at a time (pinned sections included), plus a full-page image for the app pages.

const OUT = join(__dirname, "..", "screenshots");

function dir(project: string) {
  const d = join(OUT, project);
  mkdirSync(d, { recursive: true });
  return d;
}

async function frames(page: Page, out: string, name: string, step = 0.85) {
  const vh = page.viewportSize()!.height;
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  let n = 0;
  for (let y = 0; ; y += Math.round(vh * step)) {
    const top = Math.min(y, total - vh);
    await page.evaluate((t) => window.scrollTo({ top: t, behavior: "instant" as ScrollBehavior }), top);
    await settle(page, 1000);
    await page.screenshot({ path: join(out, `${name}-${String(++n).padStart(2, "0")}.png`) });
    if (top >= total - vh) break;
  }
}

async function fullPage(page: Page, out: string, name: string) {
  await revealAll(page);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
  await settle(page, 1300);
  await page.screenshot({ path: join(out, `${name}-full.png`), fullPage: true });
}

test("landing", async ({ page }, info) => {
  const out = dir(info.project.name);
  await page.goto("/");
  await settle(page, 2800); // hero payoff line draws in
  await page.screenshot({ path: join(out, "landing-00-hero.png") });
  await frames(page, out, "landing", 0.5);
});

test("landing mobile menu", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "mobile only");
  const out = dir(info.project.name);
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  await settle(page, 1200);
  await page.screenshot({ path: join(out, "landing-menu.png") });
});

test("eligibility notice", async ({ page }, info) => {
  const out = dir(info.project.name);
  await page.goto("/app?chain=46630");
  const gate = page.getByRole("dialog", { name: /not for us persons/i });
  await gate.waitFor();
  await settle(page, 1500);
  await page.screenshot({ path: join(out, "app-eligibility.png") });
  await gate.getByRole("checkbox").check();
  await settle(page, 500);
  await page.screenshot({ path: join(out, "app-eligibility-checked.png") });
});

test("not deployed", async ({ page }, info) => {
  const out = dir(info.project.name);
  await acknowledge(page);
  await page.goto("/app?chain=46630");
  await page.getByText(/Not deployed on/).waitFor();
  await settle(page, 1000);
  await page.screenshot({ path: join(out, "app-not-deployed.png") });
});

test("app pages", async ({ page }, info) => {
  test.skip(!(await devnetUp()), "needs a Strike devnet at E2E_RPC");
  const out = dir(info.project.name);
  const mobile = info.project.name === "mobile";
  await acknowledge(page);
  await installMockWallet(page);
  await page.goto("/app?chain=31337");
  await page.locator('a[href^="/app/vault/"]').first().waitFor();
  await connectWallet(page, mobile);
  await settle(page, 1500);
  await frames(page, out, "vaults");
  await fullPage(page, out, "vaults");

  const hrefs = await page
    .locator('a[href^="/app/vault/"]')
    .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("href")!))]);
  for (const [i, href] of hrefs.entries()) {
    await page.goto(href);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page
      .getByText("Settled epochs")
      .waitFor({ timeout: 20_000 })
      .catch(() => {});
    await settle(page, 1500);
    await frames(page, out, `vault-${i + 1}`);
    await fullPage(page, out, `vault-${i + 1}`);
  }

  await page.goto("/app/agents");
  await page.getByText("Leaderboard").first().waitFor();
  await page
    .getByText(/StrikeWrongSide/)
    .first()
    .waitFor();
  await settle(page, 1200);
  await frames(page, out, "agents");
  await fullPage(page, out, "agents");

  await page.goto("/app/faucet");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await settle(page, 1500);
  await frames(page, out, "faucet");
  await fullPage(page, out, "faucet");

  if (mobile) {
    await page.getByRole("button", { name: "Menu" }).click();
    await settle(page, 1200);
    await page.screenshot({ path: join(out, "app-menu.png") });
  }
});

test("buy panel modes", async ({ page }, info) => {
  test.skip(!(await devnetUp()), "needs a Strike devnet at E2E_RPC");
  const out = dir(info.project.name);
  await acknowledge(page);
  await installMockWallet(page);
  await page.goto("/app?chain=31337");
  const rows = page.locator('a[href^="/app/vault/"]');
  await rows.first().waitFor();
  await connectWallet(page, info.project.name === "mobile");
  const hrefs = await rows.evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("href")!))]);
  for (const href of hrefs) {
    await page.goto(href);
    const tabs = page.getByRole("tablist", { name: "How to size the buy" });
    await tabs.waitFor();
    await revealAll(page);
    const panel = tabs.locator("xpath=../..");
    const isPut = (await tabs.getByRole("tab", { name: "Protect my position" }).count()) > 0;
    const kind = isPut ? "put" : "call";
    const mode = isPut ? "protect" : "upside";
    // Element capture with the fixed nav and banner hidden, so they don't cover a panel taller than the viewport.
    const shoot = async (name: string) => {
      await settle(page, 1200);
      await page.evaluate((hide) => {
        for (const el of document.querySelectorAll<HTMLElement>("body *")) {
          const pos = getComputedStyle(el).position;
          if (pos === "fixed" || pos === "sticky") el.style.visibility = hide ? "hidden" : "";
        }
      }, true);
      await panel.screenshot({ path: join(out, `${name}.png`) });
      await page.evaluate(() => {
        for (const el of document.querySelectorAll<HTMLElement>("body *")) el.style.visibility = "";
      });
    };
    const figure = panel
      .getByText(isPut ? "Worst case at expiry" : "Profit at that price", { exact: true })
      .locator("xpath=following-sibling::dd[1]");

    await panel
      .getByText(/^[\d,.]+ USDG$/)
      .first()
      .waitFor();
    await panel.scrollIntoViewIfNeeded();
    await shoot(`buy-${kind}-amount`);

    // Defaults first (the wallet balance for puts, 100 USDG for calls; both use up the small demo series).
    await tabs.getByRole("tab", { name: isPut ? "Protect my position" : "Upside for a budget" }).click();
    await expect(figure).toHaveText(/^−?\$[\d,]+\.\d\d$/); // quoted and worked out
    await shoot(`buy-${kind}-${mode}-capped`);

    // Then an amount the series can fill.
    const field = panel.getByLabel(isPut ? /tokens you hold/ : /^Budget/);
    await field.fill(isPut ? "12" : "50");
    await expect(panel.getByText(isPut ? /^12 puts$/ : /^[\d,.]+ calls$/)).toBeVisible();
    await expect(panel.getByText(/^Capped/)).toHaveCount(0);
    await expect(figure).toHaveText(/^−?\$[\d,]+\.\d\d$/);
    await shoot(`buy-${kind}-${mode}`);
    await panel.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.evaluate(() => window.scrollBy(0, -130));
    await settle(page, 800);
    await page.screenshot({ path: join(out, `buy-${kind}-${mode}-viewport.png`) });
  }
});
