import { expect, test } from "@playwright/test";
// SDK-free modules: Playwright's CommonJS loader can require them.
import { GLOSSARY } from "../src/lib/glossary";
import { START_HERE, TOUR } from "../src/lib/tour";
import { acknowledge } from "./helpers";

// First-visit navigation: where am I (nav active state, page purpose), where next ("Next:" links and the
// start-here path), and what does this word mean (glossary tooltips on hover, focus and tap).

const CALL_VAULT_46630 = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e";
const pathFor = (href: string) => (href === "/app/vault" ? `/app/vault/${CALL_VAULT_46630}` : href);

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test("the app nav marks the current page, and only that one", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the inline nav is desktop-only; the menu test covers phones");
  for (const [path, label] of [
    ["/app/backtest", "Backtest"],
    ["/app/glossary", null],
    ["/app/proof", "Proof"],
    [`/app/vault/${CALL_VAULT_46630}`, "Vaults"],
  ] as const) {
    await page.goto(path);
    const nav = page.getByRole("navigation", { name: "App" });
    const current = nav.locator('a[aria-current="page"]');
    if (label) {
      await expect(current).toHaveCount(1);
      await expect(current).toHaveText(label);
    } else {
      await expect(current).toHaveCount(0);
    }
  }
});

test("every app page says what it is for, and its Next link leads to a real page", async ({
  page,
  request,
}) => {
  for (const p of TOUR) {
    await page.goto(pathFor(p.href));
    await expect(page.getByTestId("page-purpose")).toHaveText(p.purpose);
    const next = page.getByTestId("next-step");
    await expect(next).toHaveAttribute("href", p.next.href);
    await expect(next).toContainText(p.next.label);
    const res = await request.get(p.next.href);
    expect(res.status(), `${p.href} → ${p.next.href}`).toBe(200);
  }
});

test("following Next from the vaults walks the whole tour and comes back", async ({ page }) => {
  await page.goto("/app");
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) {
    const href = await page.getByTestId("next-step").getAttribute("href");
    seen.push(href!);
    if (href === "/app") break;
    await page.getByTestId("next-step").click();
    await expect(page).toHaveURL((url) => url.pathname === href);
  }
  expect(seen).toEqual([
    "/app/playground",
    "/app/backtest",
    "/app/agents",
    "/app/monitor",
    "/app/proof",
    "/app/faucet",
    "/app",
  ]);
});

test("start here: four steps on the landing page and the vaults page", async ({ page }) => {
  for (const path of ["/", "/app"]) {
    await page.goto(path);
    const steps = page.getByRole("navigation", { name: "Start here" }).getByRole("link");
    await expect(steps).toHaveCount(START_HERE.length);
    for (const [i, s] of START_HERE.entries()) {
      await expect(steps.nth(i)).toContainText(s.label);
    }
  }
  // On the vaults page, step 1 points at the list below it.
  await expect(
    page.getByRole("navigation", { name: "Start here" }).getByRole("link").first(),
  ).toHaveAttribute("href", "#vault-list");
});

test("a glossary term shows its definition on keyboard focus, and Escape closes it", async ({ page }) => {
  await page.goto("/app/backtest");
  const term = page.locator('[data-term="impliedVol"]');
  await expect(term).toHaveAccessibleDescription(GLOSSARY.impliedVol.def);
  await term.focus();
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(GLOSSARY.impliedVol.def);
  // Inside the viewport, whatever the width.
  const box = (await tip.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
});

test("a glossary term opens on tap and closes on a second tap", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "touch");
  await page.goto("/app/backtest");
  const term = page.locator('[data-term="impliedVol"]');
  await term.tap();
  await expect(page.getByRole("tooltip")).toContainText(GLOSSARY.impliedVol.def);
  await term.tap();
  await expect(page.getByRole("tooltip")).toBeHidden();
});

test("the glossary page lists every term", async ({ page }) => {
  await page.goto("/app/glossary");
  for (const entry of Object.values(GLOSSARY)) {
    await expect(page.getByRole("term").filter({ hasText: entry.term }).first()).toBeAttached();
  }
});

test("mobile menu: marks the page, keeps focus inside, and gives it back on close", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "the menu replaces the nav on phones");
  await page.goto("/app/backtest");
  const toggle = page.getByRole("button", { name: "Menu" });
  await toggle.click();
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu).toBeVisible();
  await expect(menu.locator('a[aria-current="page"]')).toHaveText(/Backtest/);
  // Tab from the last control wraps to the first, and Shift+Tab back.
  const focusables = menu.locator("a[href], button:not([disabled]), select");
  await focusables.last().focus();
  await page.keyboard.press("Tab");
  await expect(focusables.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(focusables.last()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();
  // A link closes it and navigates.
  await toggle.click();
  await menu.getByRole("link", { name: /Proof/ }).click();
  await expect(page).toHaveURL(/\/app\/proof$/);
  await expect(menu).toBeHidden();
});

test("the footer links every page, the docs, GitHub and the judges' tour", async ({ page }) => {
  await page.goto("/app/faucet");
  const footer = page.getByRole("contentinfo");
  const pages = footer.getByRole("navigation", { name: "Pages" }).getByRole("link");
  await expect(pages).toHaveText([
    "Vaults",
    "Playground",
    "Backtest",
    "Agents",
    "Monitor",
    "Proof",
    "Faucet",
    "Portfolio",
    "Glossary",
    "Lessons",
    "Mainnet waitlist",
  ]);
  const project = footer.getByRole("navigation", { name: "Project links" });
  await expect(project.getByRole("link", { name: /Judges/ })).toHaveAttribute("href", /docs\/JUDGES\.md$/);
  await expect(project.getByRole("link", { name: /GitHub/ })).toBeVisible();
  await expect(project.getByRole("link", { name: /Docs/ })).toBeVisible();
});
