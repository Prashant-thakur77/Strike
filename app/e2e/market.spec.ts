import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  fmtCountdown,
  fmtLocal,
  fmtUtc,
  marketLine,
  sessionChange,
  type CalendarDay,
} from "../src/lib/marketHours";
import { isTradingDay, sessionOf } from "../src/lib/monitor";
import { acknowledge, horizontalOverflow, settle } from "./helpers";
import {
  PHASE_SELECTORS,
  feedStatus,
  marketClosed,
  patchEthCalls,
  quoteAt,
  quoteReverts,
  unsold,
  vaultPhase,
  type CallPatch,
} from "./lifecycle";

// NYSE hours where they bite. `openEpoch` and `buy` revert with MarketClosed outside a session, so the buy panel, the
// idle vault, the playground and the vault list say whether the market is open and when it reopens, read from the
// deployment's MarketCalendar (isTradingDay, sessionOf). The first group tests the wording without a network. The
// page tests read the live chain and turn the oracle's isMarketOpen() to false in the RPC answers, so the closed
// state shows whatever the hour; the expected reopening is computed from the calendar's TypeScript copy
// (src/lib/monitor.ts, a mirror of NyseTime and the deployed holiday list), which the page never uses.
// Set MARKET_SHOTS=<dir> to save the states as <project>-market-*.png.

/** Save the part of the page `el` covers (with a margin) to MARKET_SHOTS, when set. */
async function shot(page: Page, el: Locator, name: string) {
  const dir = process.env.MARKET_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
  await settle(page, 600);
  const box = (await el.boundingBox())!;
  await page.screenshot({
    path: join(dir, `${test.info().project.name}-market-${name}.png`),
    fullPage: true,
    clip: { x: 0, y: Math.max(0, box.y - 24), width: page.viewportSize()!.width, height: box.height + 48 },
  });
}

const pure = () => test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
const DAY = 86_400;
const at = (iso: string) => Date.parse(iso) / 1000;
/** Calendar answers for `n` days from `ts`'s day, as MarketCalendar gives them (holidays from the copy). */
const daysFrom = (ts: number, n = 14): CalendarDay[] =>
  Array.from({ length: n }, (_, i) => {
    const day = Math.floor(ts / DAY) + i;
    return { day, trading: isTradingDay(day), ...sessionOf(day) };
  });

test.describe("market hours wording", () => {
  test("open: the close of the session now is in", () => {
    pure();
    const now = at("2026-10-02T15:00:00Z"); // Friday, in session
    const c = sessionChange(now, true, daysFrom(now));
    expect(c).toEqual({ closesAt: at("2026-10-02T20:00:00Z"), opensAt: null, nextClose: null });
    const line = marketLine({ open: true, now, ...c }, "buy", { timeZone: "Asia/Singapore" });
    expect(line.headline).toBe("NYSE open until Fri 2 Oct, 20:00 UTC.");
    expect(line.local).toBe("Sat 3 Oct, 04:00 GMT+8");
    expect(line.countdown).toBe("closes in 5h 00m");
  });

  test("closed over the weekend: Monday's open, in UTC and in the viewer's zone", () => {
    pure();
    const now = at("2026-10-03T12:00:00Z"); // Saturday
    const c = sessionChange(now, false, daysFrom(now));
    expect(c.opensAt).toBe(at("2026-10-05T13:30:00Z"));
    expect(c.nextClose).toBe(at("2026-10-05T20:00:00Z"));
    const buy = marketLine({ open: false, now, ...c }, "buy", { timeZone: "Asia/Singapore" });
    expect(buy.headline).toBe("NYSE closed. Buying reopens Mon 5 Oct, 13:30 UTC.");
    expect(buy.local).toBe("Mon 5 Oct, 21:30 GMT+8");
    expect(buy.countdown).toBe("in 2d 1h");
    const open = marketLine({ open: false, now, ...c }, "open", { timeZone: "America/New_York" });
    expect(open.headline).toBe("NYSE closed. Epochs can open again Mon 5 Oct, 13:30 UTC.");
    expect(open.local).toBe("Mon 5 Oct, 09:30 GMT-4");
    // A viewer on UTC gets no second time.
    expect(marketLine({ open: false, now, ...c }, "buy", { timeZone: "UTC" }).local).toBeNull();
  });

  test("closed on a weekday evening: the next morning's session", () => {
    pure();
    const now = at("2026-10-06T21:00:00Z"); // Tuesday after the close (05:00 Wednesday in Singapore)
    const c = sessionChange(now, false, daysFrom(now));
    expect(fmtUtc(c.opensAt!)).toBe("Wed 7 Oct, 13:30 UTC");
    expect(fmtLocal(c.opensAt!, "Asia/Singapore")).toBe("Wed 7 Oct, 21:30 GMT+8");
  });

  test("a holiday and a half day come from the calendar's answers, not a fixed schedule", () => {
    pure();
    // Thanksgiving 2026 (Thu 26 Nov) is closed; Fri 27 Nov closes at 13:00 New York (18:00 UTC, standard time).
    const wed = at("2026-11-25T22:00:00Z");
    const c = sessionChange(wed, false, daysFrom(wed));
    expect(fmtUtc(c.opensAt!)).toBe("Fri 27 Nov, 14:30 UTC");
    expect(fmtUtc(c.nextClose!)).toBe("Fri 27 Nov, 18:00 UTC");
    // The same days with Friday marked a holiday too: the answer moves to Monday.
    const days = daysFrom(wed).map((d) =>
      fmtUtc(d.day * DAY).startsWith("Fri 27 Nov") ? { ...d, trading: false } : d,
    );
    expect(fmtUtc(sessionChange(wed, false, days).opensAt!)).toBe("Mon 30 Nov, 14:30 UTC");
    // Nothing within the days given: say so rather than guess.
    const none = sessionChange(wed, false, days.slice(0, 2));
    expect(none).toEqual({ closesAt: null, opensAt: null, nextClose: null });
    expect(marketLine({ open: false, now: wed, ...none }, "buy").headline).toBe(
      "NYSE closed. The on-chain calendar has no session in the next 14 days.",
    );
  });

  test("countdowns", () => {
    pure();
    expect(fmtCountdown(30)).toBe("under a minute");
    expect(fmtCountdown(12 * 60 + 5)).toBe("12m");
    expect(fmtCountdown(3 * 3600 + 5 * 60)).toBe("3h 05m");
    expect(fmtCountdown(2 * DAY + 22 * 3600 + 59 * 60)).toBe("2d 22h");
  });
});

/* ------------------------------------------------------------------ the pages, live, with the market forced closed */

const TESTNET_RPC = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";
async function testnetUp(): Promise<boolean> {
  try {
    const res = await fetch(TESTNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    return Number(((await res.json()) as { result?: string }).result) === 46630;
  } catch {
    return false;
  }
}

/** The v2 call vault and its series of 2 October: the fixtures below put it on sale whatever the week is doing. */
const CALL_VAULT = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e";
const CALL_SERIES = 8614008145645214741184698995285385951692715470493509368088435356950067027964n;

/**
 * Pass the page's Robinhood Chain testnet reads through, answering `StockOracle.isMarketOpen()` with false (direct and
 * inside Multicall3 batches), through lifecycle.ts. With `selling`, the v2 call vault's series is on sale (expiry three
 * days ahead), its feed fresh and `quoteBuy` answering, so the buy panel shows whatever state the week is in. With
 * `stale`, the feed is past its limit: `status(token)` says StalePrice (last print 27 hours ago) and `quoteBuy` reverts
 * with StalePrice, as SafeStockFeed does. With `unsold`, every series reads as nothing sold yet.
 */
async function forceClosed(page: Page, { stale = false, unsold: noneSold = false, selling = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const patches: CallPatch[] = [marketClosed];
  if (noneSold) patches.push(unsold);
  if (selling)
    patches.push(
      vaultPhase({ vault: CALL_VAULT, seriesId: CALL_SERIES, phase: "selling" }),
      feedStatus(0, now - 600),
      quoteAt(2_440_240n),
    );
  if (stale) patches.push(feedStatus(2, now - 27 * 3600), quoteReverts);
  await patchEthCalls(page, 46630, TESTNET_RPC, PHASE_SELECTORS, patches);
}

/** The next session open after the wall clock, from the calendar's TypeScript copy (the page reads the contract). */
function expectedReopen(): string {
  const now = Math.floor(Date.now() / 1000);
  return fmtUtc(sessionChange(now, false, daysFrom(now)).opensAt!);
}

test.use({ timezoneId: "Asia/Singapore" });

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

/** Every vault on 46630 (v2: call, put, agent #2's put; v3: call, put). Which ones are on sale changes weekly. */
const VAULTS_46630 = [
  "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
  "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7",
  "0x8aEb1e0aC30Ff7829609954688B2aC649Ef26969",
  "0x478E7BC3C3aB07fdd104e4765F178977adEe6285",
  "0x1bc73c1B28F520E57982FAe6127477190FA53690",
];

/** Open each vault until `testId` shows (a buy panel with options left, or the idle vault's market line). */
async function findVault(page: Page, testId: string): Promise<string | null> {
  for (const vault of VAULTS_46630) {
    await page.goto(`/app/vault/${vault}?chain=46630`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA", { timeout: 45_000 });
    // The series rail has loaded once it shows one of its states.
    const states = page
      .getByTestId(testId)
      .or(page.getByText(/^(No option on sale|Waiting for the agent)\.$/))
      .or(page.getByText("Sold out."))
      .or(page.getByTestId("settlement-wait"));
    await expect(states.first()).toBeVisible({ timeout: 45_000 });
    const shows = await page
      .getByTestId(testId)
      .first()
      .waitFor({ timeout: 10_000 })
      .then(
        () => true,
        () => false,
      );
    if (shows) return vault;
  }
  return null;
}

test("vault page: closed market names the reopening in UTC and Singapore time, from the chain's calendar", async ({
  page,
}) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  await forceClosed(page);
  const vault = await findVault(page, "market-hours");
  test.skip(!vault, "no 46630 vault is idle or selling with options left right now");
  const line = page.getByTestId("market-hours").first();
  await expect(line).toHaveAttribute("data-open", "false", { timeout: 30_000 });
  const reopen = expectedReopen();
  await expect(line.getByTestId("market-hours-headline")).toHaveText(
    new RegExp(`^NYSE closed\\. (Buying reopens|Epochs can open again) ${reopen}\\.$`),
  );
  // 13:30 UTC is 21:30 in Singapore (14:30 → 22:30 after 1 November).
  await expect(line.getByTestId("market-hours-local")).toHaveText(
    /^Your time: \w{3} \d{1,2} \w{3}, 2[12]:30 GMT\+8$/,
  );
  await expect(line.getByRole("link", { name: /MarketCalendar/ })).toHaveAttribute(
    "href",
    "https://explorer.testnet.chain.robinhood.com/address/0x214d21F4fCA2226091AF009B9F1BF1D3C63f95F4",
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shot(page, page.getByRole("region", { name: "This week's option" }), "vault-closed");
});

test("buy panel: closed market keeps a read-only quote; a stale feed explains why there is none", async ({
  page,
}) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  await forceClosed(page, { unsold: true, selling: true });
  await page.goto(`/app/vault/${CALL_VAULT}?chain=46630`);
  const buy = page.getByTestId("buy-panel");
  await expect(buy).toBeVisible({ timeout: 45_000 });
  await expect(buy.getByTestId("market-hours")).toHaveAttribute("data-open", "false");
  await expect(buy.getByText("Quote now (read-only)")).toBeVisible();
  await expect(buy.getByTestId("buy-quote")).toHaveText(/^[\d,.]+ USDG$/, { timeout: 30_000 });
  await expect(buy.getByText(/buy reverts with MarketClosed until the session above/)).toBeVisible();
  await expect(page.getByLabel("How the buy price is set")).toContainText(
    "quoteBuy for one option, read-only while the market is closed",
  );
  await shot(page, buy, "buy-closed");

  // The same page with the feed past its limit: no quote, and the reason.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await forceClosed(page, { stale: true, unsold: true, selling: true });
  await page.goto(`/app/vault/${CALL_VAULT}?chain=46630`);
  const buy2 = page.getByTestId("buy-panel");
  await expect(buy2.getByTestId("buy-quote")).toHaveText("No quote", { timeout: 60_000 });
  await expect(buy2.getByTestId("no-quote")).toContainText(
    "No live quote: quoteBuy reverts with StalePrice.",
  );
  await expect(buy2.getByTestId("no-quote")).toContainText(
    "past the oracle's limit (25 h on these deployments)",
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shot(page, buy2, "buy-stale");
});

test("a selling series: the price steps call the live quote read-only while closed", async ({ page }) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  await forceClosed(page, { selling: true });
  await page.goto(`/app/vault/${CALL_VAULT}?chain=46630`);
  await expect(page.getByTestId("price-note")).toContainText(
    "quoteBuy for one option, read-only while the market is closed",
    { timeout: 30_000 },
  );
});

test("playground and vault list: the NYSE cell says when the market reopens", async ({ page }) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  await forceClosed(page);
  const reopen = expectedReopen();
  await page.goto("/app/playground");
  const strip = page.getByRole("region", { name: "Key figures" });
  await expect(strip.getByText("Closed", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(strip.getByTestId("market-sub")).toContainText(`reopens ${reopen}`, { timeout: 30_000 });
  const note = page.getByTestId("market-hours");
  await expect(note).toHaveAttribute("data-open", "false");
  await expect(note.getByTestId("market-hours-headline")).toHaveText(
    `NYSE closed. Epochs can open again ${reopen}.`,
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  await shot(page, note, "playground-closed");

  await page.goto("/app?chain=46630");
  const list = page.getByRole("region", { name: "Key figures" });
  await expect(list.getByText("Closed", { exact: true })).toBeVisible({ timeout: 45_000 });
  await expect(list.getByTestId("market-sub")).toContainText(`reopens ${reopen}`);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("live: the market line matches the chain's own answer right now", async ({ page }) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  const vault = await findVault(page, "market-hours");
  test.skip(!vault, "no 46630 vault is idle or selling with options left right now");
  const line = page.getByTestId("market-hours").first();
  await expect(line).toHaveAttribute("data-open", /true|false/, { timeout: 45_000 });
  const open = (await line.getAttribute("data-open")) === "true";
  const now = Math.floor(Date.now() / 1000);
  const c = sessionChange(now, open, daysFrom(now));
  const when = fmtUtc((open ? c.closesAt : c.opensAt)!);
  await expect(line.getByTestId("market-hours-headline")).toContainText(when);
});
