import { expect, test, type Page } from "@playwright/test";
import { placeLabel } from "../src/lib/payoff";
import { acknowledge, horizontalOverflow } from "./helpers";

// The mobile pass of 3 October (docs/testnet-epochs/2026-10-03-end-to-end-qa.md): every route at 360px (the smallest
// common phone width; the mobile project itself is 390px) without a horizontal scroll, wide tables as one card per
// row, chart labels inside the chart, 44px touch targets and no text under 11.5px. /waitlist has its own spec.

const ROUTES = [
  "/",
  "/app?chain=46630",
  "/app/vault/0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e?chain=46630",
  "/app/vault/0x478E7BC3C3aB07fdd104e4765F178977adEe6285?chain=46630",
  "/app/vault/0x5655659E18bf54ee0EF8f6A816E2e18D000F7311?chain=421614",
  "/app/decision/46630/2026-10-01-sTSLA-CC",
  "/app/decision/46630/2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run?dry=1",
  "/app/decision/46630/2026-10-01-sTSLA-CSP",
  "/app/agents?chain=46630",
  "/app/lessons",
  "/app/portfolio?chain=46630",
  "/app/playground",
  "/app/proof",
  "/app/faucet?chain=46630",
  "/app/backtest",
  "/app/monitor",
  "/app/glossary",
];

const DRY_RUN = "/app/decision/46630/2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run?dry=1";

const mobileOnly = () => test.skip(test.info().project.name !== "mobile", "phone widths: the mobile project");

async function settled(page: Page, route: string) {
  await page.goto(route);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500);
}

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

for (const route of ROUTES) {
  test(`360px: ${route} scrolls only vertically`, async ({ page }) => {
    mobileOnly();
    await page.setViewportSize({ width: 360, height: 780 });
    await settled(page, route);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
}

test("decision page: each market check is a card on a phone, every value labelled and on screen", async ({
  page,
}) => {
  mobileOnly();
  await page.setViewportSize({ width: 360, height: 780 });
  await settled(page, DRY_RUN);
  const table = page.getByRole("table", { name: "Market checks" });
  await expect(table).toBeVisible({ timeout: 45_000 });
  const rows = table.locator("tbody tr");
  expect(await rows.count()).toBeGreaterThan(3);
  await table.scrollIntoViewIfNeeded();
  const cells = await table.locator("tbody td").evaluateAll((tds) =>
    tds.map((td) => ({
      label: td.getAttribute("data-label"),
      right: td.getBoundingClientRect().right,
    })),
  );
  // Before: a 2,171px-wide table in a 316px scroller, the Result column out of sight.
  for (const c of cells) {
    expect(c.label).toMatch(/^(Code|Measured|Limit|Result)$/);
    expect(c.right).toBeLessThanOrEqual(360);
  }
  expect(cells.filter((c) => c.label === "Result")).toHaveLength(await rows.count());
});

test("payoff chart labels move to the side that fits", () => {
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
  // 360px phone, spot marker near the right edge: "Spot now $370.45" goes left of it.
  expect(placeLabel(250, "Spot now $370.45", "start", 316)).toEqual({ x: 244, anchor: "end" });
  // Room on the preferred side: unchanged.
  expect(placeLabel(100, "Spot now $370.45", "start", 640)).toEqual({ x: 106, anchor: "start" });
  // Room on neither side: the preferred side stays.
  expect(placeLabel(60, "Strike $342.91 and a long tail", "end", 120)).toEqual({ x: 54, anchor: "end" });
});

test("vault page: the payoff chart's labels stay inside the chart at 360px", async ({ page }) => {
  mobileOnly();
  await page.setViewportSize({ width: 360, height: 780 });
  // Agent #2's put vault sells until 9 October; after that the chart may be gone, and the test skips.
  await settled(page, "/app/vault/0x8aEb1e0aC30Ff7829609954688B2aC649Ef26969?chain=46630");
  const fig = page.getByRole("figure", { name: "Result at expiry, per option" });
  test.skip(
    !(await fig.isVisible({ timeout: 30_000 }).catch(() => false)),
    "no payoff chart on this vault now",
  );
  await fig.scrollIntoViewIfNeeded();
  const out = await fig
    .locator("svg")
    .first()
    .evaluate((svg) => {
      const box = svg.getBoundingClientRect();
      return [...svg.querySelectorAll("text")]
        .map((t) => ({ text: t.textContent, r: t.getBoundingClientRect() }))
        .filter(({ r }) => r.left < box.left - 1 || r.right > box.right + 1)
        .map(({ text }) => text);
    });
  expect(out).toEqual([]);
});

test("phone: controls are 44px to the touch and no text is under 11.5px", async ({ page }) => {
  mobileOnly();
  for (const route of ["/app/faucet?chain=46630", "/app/portfolio?chain=46630", "/app/lessons", DRY_RUN]) {
    await settled(page, route);
    const found = await page.evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const small: string[] = [];
      for (const el of document.querySelectorAll(
        "#main a, #main button, #main select, #main input, #main summary",
      )) {
        if (!visible(el) || el.closest("[aria-hidden=true]")) continue;
        const s = getComputedStyle(el);
        // Words inside a sentence (glossary terms, inline links) are exempt, as in WCAG 2.5.8.
        const own = (el.textContent ?? "").trim().length;
        const around = (el.parentElement?.textContent ?? "").trim().length;
        if (s.display === "inline" || around > own + 12) continue;
        if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) continue;
        const after = getComputedStyle(el, "::after");
        if (after.position === "absolute" && parseFloat(after.height) >= 44) continue;
        if (el.getBoundingClientRect().height < 44)
          small.push(`${el.tagName} "${(el.textContent ?? "").trim().slice(0, 30)}"`);
      }
      const tiny: string[] = [];
      const walker = document.createTreeWalker(
        document.querySelector("#main") ?? document.body,
        NodeFilter.SHOW_TEXT,
      );
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!n.textContent?.trim() || !el || !visible(el) || el.closest("svg, .sr-only, [aria-hidden=true]"))
          continue;
        if (parseFloat(getComputedStyle(el).fontSize) < 11.5) tiny.push(n.textContent.trim().slice(0, 30));
      }
      return { small, tiny };
    });
    expect(found.small, `${route}: controls under 44px`).toEqual([]);
    expect(found.tiny, `${route}: text under 11.5px`).toEqual([]);
  }
});
