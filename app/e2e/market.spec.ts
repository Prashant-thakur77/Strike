import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  toFunctionSelector,
  type Hex,
} from "viem";
import {
  fmtCountdown,
  fmtLocal,
  fmtUtc,
  marketLine,
  sessionChange,
  type CalendarDay,
} from "../src/lib/marketHours";
import { isTradingDay, sessionOf } from "../src/lib/monitor";
import { acknowledge, horizontalOverflow, rpcTraffic, settle } from "./helpers";

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
const IS_OPEN = toFunctionSelector("isMarketOpen()");
const QUOTE_BUY = toFunctionSelector("quoteBuy(uint256,uint256)");
const STATUS = toFunctionSelector("status(address)");
const STALE_PRICE = toFunctionSelector("StalePrice(uint256,uint256)");
const GET_SERIES = toFunctionSelector("getSeries(uint256)");
/** `EpochManager.Series` is 16 static words; `sold` is the 11th. */
const SERIES_WORDS = 16;
const SOLD_WORD = 10;
const FALSE = encodeAbiParameters([{ type: "bool" }], [false]);

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

interface Rpc {
  id: number;
  method: string;
  params?: { data?: Hex; input?: Hex }[];
}
type Answer = { id: number; jsonrpc?: string; result?: Hex; error?: unknown };

/**
 * Pass the page's Robinhood Chain testnet reads through, answering `StockOracle.isMarketOpen()` with false (direct and
 * inside Multicall3 batches). With `stale`, also make the feed stale: `status(token)` says StalePrice and `quoteBuy`
 * reverts with StalePrice, as SafeStockFeed does once the last print is older than its limit. With `unsold`, every
 * series reads as nothing sold yet, so the buy panel shows even when this week's real series sold out.
 */
async function forceClosed(page: Page, { stale = false, unsold = false } = {}) {
  const touches = (d: string | undefined) =>
    !!d &&
    (d.includes(IS_OPEN.slice(2)) ||
      (unsold && d.includes(GET_SERIES.slice(2))) ||
      (stale && (d.includes(QUOTE_BUY.slice(2)) || d.includes(STATUS.slice(2)))));
  const patchCall = (data: Hex, result: Hex): Hex | "revert" => {
    if (data.startsWith(IS_OPEN)) return FALSE;
    if (unsold && data.startsWith(GET_SERIES) && result.length === 2 + 64 * SERIES_WORDS) {
      const words = result.slice(2).match(/.{64}/g)!;
      words[SOLD_WORD] = "0".repeat(64);
      return `0x${words.join("")}` as Hex;
    }
    if (stale && data.startsWith(QUOTE_BUY)) return "revert";
    if (stale && data.startsWith(STATUS) && result.length >= 2 + 64 * 3) {
      // Status.StalePrice, the same price, printed 27 hours ago (past the 25-hour limit).
      const printed = (Math.floor(Date.now() / 1000) - 27 * 3600).toString(16).padStart(64, "0");
      return `0x${"2".padStart(64, "0")}${result.slice(2 + 64, 2 + 128)}${printed}` as Hex;
    }
    return result;
  };
  await page.route(rpcTraffic(46630, TESTNET_RPC), async (route) => {
    const post = route.request().postData() ?? "";
    if (route.request().method() !== "POST" || !touches(post)) return route.continue();
    const body = JSON.parse(post) as Rpc | Rpc[];
    const calls = Array.isArray(body) ? body : [body];
    const res = await route.fetch();
    const json = (await res.json()) as Answer | Answer[];
    const answers = (Array.isArray(json) ? json : [json]).map((a): Answer => {
      const call = calls.find((c) => c.id === a.id);
      const data = call?.params?.[0]?.data ?? call?.params?.[0]?.input;
      if (!call || call.method !== "eth_call" || !data || !a.result) return a;
      if (data.startsWith(toFunctionSelector("aggregate3((address,bool,bytes)[])"))) {
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        if (decoded.functionName !== "aggregate3") return a;
        const args = decoded.args;
        const out = decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: a.result });
        const patched = out.map((r, i) => {
          const p = patchCall(args[0][i]!.callData, r.returnData);
          return p === "revert" ? { success: false, returnData: STALE_PRICE } : { ...r, returnData: p };
        });
        return {
          ...a,
          result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: patched }),
        };
      }
      const p = patchCall(data, a.result);
      if (p === "revert") {
        const { result: _drop, ...rest } = a;
        void _drop;
        return {
          ...rest,
          error: { code: 3, message: "execution reverted", data: `${STALE_PRICE}${"0".repeat(128)}` },
        };
      }
      return { ...a, result: p };
    });
    await route.fulfill({ response: res, json: Array.isArray(json) ? answers : answers[0] });
  });
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
      .or(page.getByText("Sold out."));
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
  await forceClosed(page, { unsold: true });
  const found = await findVault(page, "buy-panel");
  test.skip(!found, "no 46630 vault is selling a series right now");
  const buy = page.getByTestId("buy-panel");
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
  await forceClosed(page, { stale: true, unsold: true });
  await page.goto(`/app/vault/${found}?chain=46630`);
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

test("sold-out or selling series: the price steps call the live quote read-only while closed", async ({
  page,
}) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  await forceClosed(page);
  const found = await findVault(page, "price-note");
  test.skip(!found, "no 46630 vault is selling right now");
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
