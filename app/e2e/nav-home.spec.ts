import { expect, test } from "@playwright/test";
// SDK-free modules: Playwright's CommonJS loader can require them.
import { NAV, TABS, isGroup, navRoutes } from "../src/lib/nav";
import { fitsProfile } from "../src/lib/profile";
import { SHOWCASE_DECISION } from "../src/lib/tour";
import { acknowledge, connectWallet, devnetUp, horizontalOverflow, installMockWallet } from "./helpers";

// The simpler app (D53): five top-level places, the /app home for a newcomer (three ways in, a plain vault list, an
// optional profile matched to on-chain mandates) and for a returning wallet (its vaults first), the phone's tab bar,
// and the vault page leading with the action while its expert sections fold behind labelled summaries.

const CALL_VAULT_46630 = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e";

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test("the nav has five top-level places and every page it reaches answers", async ({ request }) => {
  test.skip(test.info().project.name !== "desktop", "HTTP checks run once");
  expect(NAV.map((e) => e.label)).toEqual(["Vaults", "Portfolio", "Agents", "Proof", "Learn"]);
  // Every app page that used to be in the nav or footer still has a place in it.
  const routes = navRoutes();
  for (const path of [
    "/app",
    "/app/portfolio",
    "/app/agents",
    "/app/proof",
    "/app/monitor",
    "/app/lessons",
    "/app/playground",
    "/app/backtest",
    "/app/glossary",
    "/app/faucet",
    "/waitlist",
  ]) {
    expect(routes, path).toContain(path);
  }
  for (const path of routes) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
  }
});

test("desktop: a group opens on click, marks the current page, and closes on Escape", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "the inline nav is desktop-only");
  await page.goto("/app/backtest");
  const nav = page.getByRole("navigation", { name: "App" });
  const learn = nav.getByRole("button", { name: "Learn" });
  // The group holding the page is marked even while closed.
  await expect(learn).toHaveAttribute("data-current", "true");
  await expect(learn).toHaveAttribute("aria-expanded", "false");
  await learn.click();
  await expect(learn).toHaveAttribute("aria-expanded", "true");
  const panel = page.locator("#nav-learn");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("link", { name: /^Backtest/ })).toHaveAttribute("aria-current", "page");
  // Every link in the panel says what the page is for.
  const group = NAV.find((e) => isGroup(e) && e.label === "Learn");
  expect(group && isGroup(group) && group.links.every((l) => !!l.note)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(learn).toBeFocused();
  // Keyboard: open with Enter, Tab into the links, follow one.
  const proof = nav.getByRole("button", { name: "Proof" });
  await proof.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator("#nav-proof a").first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/proof$/);
  await expect(page.locator("#nav-proof")).toBeHidden();
  await expect(proof).toHaveAttribute("data-current", "true");
  // A click outside closes an open group.
  await proof.click();
  await expect(page.locator("#nav-proof")).toBeVisible();
  await page.mouse.click(5, 600);
  await expect(page.locator("#nav-proof")).toBeHidden();
});

test("newcomer: the home says what Strike is, offers three ways in and lists the vaults plainly", async ({
  page,
}) => {
  await page.goto("/app?chain=46630");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Vaults that pay you every week");
  const choices = page.getByRole("navigation", { name: "Start here" }).getByRole("link");
  await expect(choices).toHaveCount(3);
  await expect(choices.nth(0)).toHaveAttribute("href", "#vault-list");
  await expect(choices.nth(1)).toHaveAttribute("href", "/app/playground");
  await expect(choices.nth(2)).toHaveAttribute("href", SHOWCASE_DECISION);
  await expect(page.getByTestId("home-get-started")).toHaveAttribute("href", "/app/faucet#start");
  // The three choices sit in the first screen, on a phone too.
  const vh = page.viewportSize()!.height;
  const box = (await choices.nth(0).boundingBox())!;
  expect(box.y).toBeLessThan(vh);
  // Signed out, nobody's portfolio is shown.
  await expect(page.getByTestId("home-portfolio")).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("the risk profile filters by each vault's on-chain delta limit, and can be skipped", () => {
  test.skip(test.info().project.name !== "desktop", "pure logic runs once");
  const call = (max: number) => ({ isCall: true, mandate: { maxDeltaBps: max } });
  const put = (max: number) => ({ isCall: false, mandate: { maxDeltaBps: max } });
  expect(fitsProfile(call(3500), "all", "any")).toBe(true);
  expect(fitsProfile(put(3500), "stock", "any")).toBe(false);
  expect(fitsProfile(call(3500), "usdg", "any")).toBe(false);
  expect(fitsProfile(put(2500), "usdg", "little")).toBe(true);
  expect(fitsProfile(put(3500), "usdg", "little")).toBe(false);
  expect(fitsProfile(call(3500), "stock", "some")).toBe(true);
  expect(fitsProfile(call(3501), "stock", "some")).toBe(false);
});

test.describe("with a local devnet", () => {
  test.beforeEach(async () => {
    test.skip(!(await devnetUp()), "needs a Strike devnet at E2E_RPC");
  });

  test("the profile narrows the list, says how many fit, and Show all brings every vault back", async ({
    page,
  }) => {
    await page.goto("/app?chain=31337");
    const rows = page.getByTestId("vault-row");
    await expect(rows.first()).toBeVisible();
    const all = await rows.count();
    const profile = page.getByTestId("risk-profile");
    // Closed at first: the list comes before the questions, and skipping them needs nothing.
    await expect(profile).not.toHaveAttribute("open", "");
    await profile.getByText(/two optional questions/).click();
    await profile
      .getByRole("group", { name: "What do you hold?" })
      .getByRole("button", { name: "USDG" })
      .click();
    await expect(rows.filter({ hasText: "Covered call" })).toHaveCount(0);
    await expect(page.getByTestId("risk-profile-count")).toContainText(`of ${all} vaults fit`);
    // Each row states its own limit, read from the chain.
    await expect(rows.first().getByTestId("vault-row-cap")).toContainText(
      /can never sell above 0\.\d\d delta/,
    );
    await profile.getByRole("button", { name: "Show all" }).first().click();
    await expect(rows).toHaveCount(all);
  });

  test("returning wallet: its vaults come first on the home, with the way to the portfolio", async ({
    page,
  }, info) => {
    await installMockWallet(page);
    await page.goto("/app?chain=31337");
    await page.getByTestId("vault-row").first().waitFor();
    await connectWallet(page, info.project.name === "mobile");
    const mine = page.getByTestId("home-portfolio");
    await expect(mine).toBeVisible({ timeout: 30_000 });
    await expect(mine).toContainText("Premium to claim");
    await expect(page.getByTestId("home-portfolio-link")).toHaveAttribute("href", "/app/portfolio");
    // Above the three ways in.
    const a = (await mine.boundingBox())!;
    const b = (await page.getByTestId("home-choice").first().boundingBox())!;
    expect(a.y).toBeLessThan(b.y);
  });

  test("vault page: the action first; expert sections fold, open from a link and all at once", async ({
    page,
  }) => {
    await page.goto("/app?chain=31337");
    const href = (await page.getByTestId("vault-row").first().getAttribute("href"))!;
    await page.goto(href);
    await expect(page.getByTestId("week-call")).toBeVisible();
    // Deposit and this week's option come before the folded details.
    const deposit = (await page.getByRole("region", { name: /Deposit|Queue a deposit/ }).boundingBox())!;
    const details = (await page.getByTestId("vault-details").boundingBox())!;
    expect(deposit.y).toBeLessThan(details.y);
    for (const id of ["why", "risk", "trace"]) {
      await expect(page.getByTestId(`fold-${id}`)).not.toHaveAttribute("open", "");
    }
    // Typing an amount shows both endings of the week, wallet or not.
    await page.locator('input[inputmode="decimal"]').first().fill("1");
    await expect(page.getByTestId("your-week")).toBeVisible();
    // A link to a section opens it.
    await page.goto(`${href}#risk`);
    await expect(page.getByTestId("fold-risk")).toHaveAttribute("open", "");
    await expect(page.getByRole("region", { name: "Risk" })).toBeVisible();
    await page.getByRole("button", { name: "Open all" }).click();
    for (const id of ["why", "risk", "trace"]) {
      await expect(page.getByTestId(`fold-${id}`)).toHaveAttribute("open", "");
    }
    await page.getByRole("button", { name: "Close all" }).click();
    await expect(page.getByTestId("fold-trace")).not.toHaveAttribute("open", "");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test("phone: a bottom tab bar for the four main places, More opens the grouped menu", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile", "the tab bar is for phones");
  await page.goto("/app/agents");
  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("link")).toHaveText(TABS.map((t) => t.label));
  await expect(tabs.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");
  // Thumb-sized targets, at the bottom of the screen.
  const vh = page.viewportSize()!.height;
  for (const el of await tabs.locator("a, button").all()) {
    const b = (await el.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(44);
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.y + b.height).toBeGreaterThan(vh - 90);
  }
  await tabs.getByRole("button", { name: "More pages" }).click();
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu).toBeVisible();
  for (const g of ["Proof", "Learn"]) await expect(menu.getByRole("region", { name: g })).toBeVisible();
  await menu.getByRole("link", { name: "Backtest" }).click();
  await expect(page).toHaveURL(/\/app\/backtest$/);
  await expect(menu).toBeHidden();
  // The last thing on the page is not hidden under the bar.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const notice = page.getByRole("contentinfo").locator("p").last();
  const nb = (await notice.boundingBox())!;
  const bar = (await tabs.boundingBox())!;
  expect(nb.y + nb.height).toBeLessThanOrEqual(bar.y + 1);
  for (const w of [360, 390]) {
    await page.setViewportSize({ width: w, height: 800 });
    await page.goto(`/app/vault/${CALL_VAULT_46630}?chain=46630`);
    expect(await horizontalOverflow(page), `${w}px`).toBeLessThanOrEqual(0);
  }
});
