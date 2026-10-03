import { expect, test, type Page } from "@playwright/test";
import { acknowledge, horizontalOverflow } from "./helpers";

// /app/backtest: the committed backtest (research/results) rendered from app/src/data/backtest. No chain needed.
// Expected figures are copied from research/results/tables.md (delta 0.20, premiumBps 1.00, premium held).

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

const stat = (page: Page, key: string) => page.locator(`[data-metric="${key}"] dd`).first();
const controls = (page: Page) => page.getByRole("region", { name: "Backtest settings" });

test("renders the backtest with headline figures, charts and caveats", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/app/backtest");
  await expect(page.getByRole("heading", { level: 1, name: /backtest/i })).toBeAttached();
  await expect(page.locator("#main header .index").first()).toHaveText("03");

  // Default: TSLA covered call, VRP 1.15.
  await expect(stat(page, "cagr")).toHaveText("23.1%");
  await expect(page.locator('[data-metric="cagr"]')).toContainText("Buy-and-hold 44.0%");
  await expect(stat(page, "vol")).toHaveText("33.7%");
  await expect(stat(page, "sharpe")).toHaveText("0.78");
  await expect(stat(page, "maxdd")).toHaveText("−46.3%");
  await expect(stat(page, "premium")).toHaveText("0.75%");
  await expect(stat(page, "assigned")).toHaveText("18.4%");

  for (const title of [/Growth of 1\.0/, /Weekly premium/, /Stress windows/, /By target delta/]) {
    await expect(page.getByRole("heading", { level: 3, name: title })).toBeVisible();
  }
  const caveats = page.getByRole("note", { name: "Backtest caveats" });
  await expect(caveats).toContainText("implied volatility is modelled");
  await expect(caveats).toContainText("Full fills are assumed");
  await expect(caveats).toContainText("Covered calls trail buy-and-hold in return but cut volatility");
  await expect(caveats.getByRole("link", { name: /docs\/backtest\.md/ })).toHaveAttribute(
    "href",
    "https://github.com/Prashant-thakur77/Strike/blob/main/docs/backtest.md",
  );
  await expect(caveats.getByRole("link", { name: /research\/backtest\.py/ })).toHaveAttribute(
    "href",
    "https://github.com/Prashant-thakur77/Strike/blob/main/research/backtest.py",
  );
  expect(errors).toEqual([]);
});

test("the controls change every figure", async ({ page }) => {
  await page.goto("/app/backtest");
  const c = controls(page);

  await c.getByRole("button", { name: "NVDA" }).click();
  await expect(c.getByRole("button", { name: "NVDA" })).toHaveAttribute("aria-pressed", "true");
  await expect(stat(page, "cagr")).toHaveText("38.6%");
  await expect(stat(page, "sharpe")).toHaveText("1.36");

  await c.getByRole("button", { name: "Cash-secured put" }).click();
  await expect(stat(page, "cagr")).toHaveText("3.7%");
  await expect(stat(page, "maxdd")).toHaveText("−7.1%");

  await c.getByRole("button", { name: "Realised volatility × 1.00" }).click();
  await expect(stat(page, "cagr")).toHaveText("0.5%");
  await expect(stat(page, "assigned")).toHaveText("18.6%");

  await c.getByRole("button", { name: "SPY" }).click();
  await c.getByRole("button", { name: "Covered call" }).click();
  await expect(stat(page, "cagr")).toHaveText("8.6%");
  await expect(stat(page, "premium")).toHaveText("0.18%");
  // The stress panels follow the selection too (tables.md: SPY covered call, VRP 1.00, 2020 crash −29.0% vs −31.8%).
  await expect(page.getByRole("img", { name: /2020 crash.*−29\.0%.*−31\.8%/ })).toBeVisible();
});

test("tooltips appear on hover and on keyboard focus", async ({ page }) => {
  await page.goto("/app/backtest");
  const equity = page.locator("#bt-equity-body svg");
  await equity.scrollIntoViewIfNeeded();
  const box = (await equity.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  const tip = page.locator("#bt-equity-body").getByTestId("chart-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/\d{1,2} \w{3} 20\d\d/);
  await expect(tip).toContainText("Covered call");
  await expect(tip).toContainText("Buy-and-hold");
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();

  // Histogram: the bar under the pointer.
  const hist = page.locator("#bt-premium-body svg");
  await hist.scrollIntoViewIfNeeded();
  const hb = (await hist.boundingBox())!;
  await page.mouse.move(hb.x + hb.width * 0.3, hb.y + hb.height * 0.6);
  await expect(page.locator("#bt-premium-body").getByTestId("chart-tip")).toContainText(/of collateral/);

  // Keyboard: focus shows the last week, arrows step back.
  await equity.focus();
  await expect(tip).toContainText("25 Sep 2026");
  await page.keyboard.press("ArrowLeft");
  await expect(tip).toContainText("18 Sep 2026");
});

test("every chart has a table view", async ({ page }) => {
  await page.goto("/app/backtest");
  const equity = page.locator("figure", { has: page.locator("#bt-equity-body") });
  await equity.getByRole("button", { name: "Show as table" }).click();
  await expect(equity.getByRole("button", { name: "Show as chart" })).toHaveAttribute("aria-pressed", "true");
  // 403 weeks plus the opening point.
  await expect(equity.locator("tbody tr")).toHaveCount(404);
  await expect(equity.locator("tbody tr").first()).toContainText("7 Jan 2019");

  const stress = page.locator("figure", { has: page.locator("#bt-stress-body") });
  await stress.getByRole("button", { name: "Show as table" }).click();
  await expect(stress.getByRole("row", { name: /2020 crash/ })).toContainText("−36.8%");
  await expect(stress.getByRole("row", { name: /2020 crash/ })).toContainText("−46.6%");

  const delta = page.locator("figure", { has: page.locator("#bt-delta-body") });
  await delta.getByRole("button", { name: "Show as table" }).click();
  await expect(delta.getByRole("row", { name: /^0\.10/ })).toContainText("26.9%");
  await expect(delta.getByRole("row", { name: /Buy-and-hold/ })).toContainText("44.0%");

  const premium = page.locator("figure", { has: page.locator("#bt-premium-body") });
  await premium.getByRole("button", { name: "Show as table" }).click();
  const weeks = await premium.locator("tbody td:nth-child(2)").allTextContents();
  expect(weeks.reduce((a, w) => a + Number(w), 0)).toBe(403);

  await equity.getByRole("button", { name: "Show as chart" }).click();
  await expect(page.locator("#bt-equity-body svg")).toBeVisible();
});

test("no horizontal overflow, with charts and with tables", async ({ page }) => {
  await page.goto("/app/backtest");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  const toTable = page.getByRole("button", { name: "Show as table" });
  await expect(toTable).toHaveCount(4);
  // Each click renames its button, so always take the first one left.
  while ((await toTable.count()) > 0) await toTable.first().click();
  await expect(page.getByRole("button", { name: "Show as chart" })).toHaveCount(4);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  // Tables fit their column too: nothing scrolls sideways inside them.
  const sideways = await page.evaluate(
    () =>
      [...document.querySelectorAll("figure table")].filter(
        (t) => t.parentElement!.scrollWidth > t.parentElement!.clientWidth + 1,
      ).length,
  );
  expect(sideways).toBe(0);
});

test("the app nav lists Backtest under Learn, after the Playground", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the desktop nav");
  await page.goto("/app/backtest");
  const nav = page.getByRole("navigation", { name: "App" });
  await nav.getByRole("button", { name: "Learn" }).click();
  const links = await page
    .locator("#nav-learn a")
    .evaluateAll((els) => els.map((e) => e.querySelector("span")?.textContent ?? ""));
  const i = links.indexOf("Backtest");
  expect(links[i - 1]).toBe("Playground");
  // Scoped to the nav: the footer lists every page too.
  await expect(page.locator("#nav-learn").getByRole("link", { name: /^Backtest/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
});
