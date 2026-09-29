import { expect, test } from "@playwright/test";
import {
  CORPORATE_ACTION_GRACE,
  MAX_PRICE_AGE,
  daysFromCivil,
  isDst,
  isMarketOpen,
  marketState,
  safeStockStatus,
  sessionOf,
  toWad,
  type FeedConfig,
  type TokenReads,
} from "../src/lib/monitor";
import { acknowledge, horizontalOverflow } from "./helpers";

// Pure unit tests for the monitor's copy of SafeStockFeed.status() and the NYSE calendar. The cases mirror
// contracts/test/oracle/StockOracle.t.sol and contracts/test/oracle/MarketCalendar.t.sol, with the same constants.

const MONDAY = 1_791_208_800n; // 2026-10-05 14:00 UTC
const HOUR = 3600;
const DAY_S = 86_400;
const TEST_CFG: FeedConfig = { maxPriceAge: HOUR, corporateActionGrace: DAY_S }; // MAX_AGE, GRACE in the tests
const E18 = 10n ** 18n;

/** MockStockToken + MockAggregator(8) after `setUp()`: multiplier 1.0, nothing paused, $250 printed at MONDAY. */
function tsla(over: Partial<TokenReads> = {}): TokenReads {
  return {
    paused: false,
    oraclePaused: false,
    uiMultiplier: E18,
    newUIMultiplier: E18,
    effectiveAt: 0n,
    feedDecimals: 8,
    round: {
      roundId: 1n,
      answer: 250n * 10n ** 8n,
      startedAt: MONDAY,
      updatedAt: MONDAY,
      answeredInRound: 1n,
    },
    ...over,
  };
}

/** A new round printed at `at` (MockAggregator.push / set). */
function printed(answer: bigint, at: bigint): TokenReads["round"] {
  return { roundId: 2n, answer, startedAt: at, updatedAt: at, answeredInRound: 2n };
}

const pureOnly = () =>
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");

test.describe("SafeStockFeed.status()", () => {
  test("test_status: every verdict, in the contract's order", () => {
    pureOnly();
    let s = safeStockStatus(tsla(), MONDAY, TEST_CFG);
    expect(s.verdict).toBe("Ok");
    expect(s.priceWad).toBe(250n * E18);

    const later = MONDAY + BigInt(HOUR) + 1n;
    s = safeStockStatus(tsla(), later, TEST_CFG);
    expect(s.verdict).toBe("StalePrice");
    expect(s.priceWad).toBe(250n * E18); // status() still reports the stale price

    const zero = tsla({ round: printed(0n, later) });
    expect(safeStockStatus(zero, later, TEST_CFG).verdict).toBe("InvalidPrice");

    const scheduled = { ...zero, newUIMultiplier: 2n * E18, effectiveAt: later + BigInt(DAY_S) };
    expect(safeStockStatus(scheduled, later, TEST_CFG).verdict).toBe("CorporateActionPending");

    const feedPaused = { ...scheduled, oraclePaused: true };
    expect(safeStockStatus(feedPaused, later, TEST_CFG).verdict).toBe("FeedPaused");

    const tokenPaused = { ...feedPaused, paused: true };
    s = safeStockStatus(tokenPaused, later, TEST_CFG);
    expect(s.verdict).toBe("TokenPaused");
    expect(s.priceWad).toBe(0n);
  });

  test("testFuzz_staleness: stale only strictly past maxPriceAge", () => {
    pureOnly();
    for (const age of [0, 1, HOUR - 1, HOUR, HOUR + 1, 3 * DAY_S, 10 * DAY_S]) {
      const v = safeStockStatus(tsla(), MONDAY + BigInt(age), TEST_CFG).verdict;
      expect(v, `age ${age}`).toBe(age > HOUR ? "StalePrice" : "Ok");
    }
  });

  test("test_revert_invalidPrice: zero, negative and future-dated answers", () => {
    pureOnly();
    expect(safeStockStatus(tsla({ round: printed(0n, MONDAY) }), MONDAY, TEST_CFG).verdict).toBe(
      "InvalidPrice",
    );
    expect(safeStockStatus(tsla({ round: printed(-1n, MONDAY) }), MONDAY, TEST_CFG).verdict).toBe(
      "InvalidPrice",
    );
    const future = tsla({ round: printed(250n * 10n ** 8n, MONDAY + 1n) });
    expect(safeStockStatus(future, MONDAY, TEST_CFG).verdict).toBe("InvalidPrice");
  });

  test("test_testnetTokenWithoutOraclePauseStillWorks: a missing flag means not paused", () => {
    pureOnly();
    // MockStockTokenNoOraclePause: oraclePaused() and the ERC-8056 getters all revert.
    const testnet = tsla({
      oraclePaused: null,
      uiMultiplier: null,
      newUIMultiplier: null,
      effectiveAt: null,
    });
    const s = safeStockStatus(testnet, MONDAY, TEST_CFG);
    expect(s.verdict).toBe("Ok");
    expect(s.priceWad).toBe(250n * E18);
    expect(safeStockStatus(tsla({ paused: null }), MONDAY, TEST_CFG).verdict).toBe("Ok");
  });

  test("a token missing only one ERC-8056 getter is never pending (corporateAction needs all three)", () => {
    pureOnly();
    const r = tsla({ newUIMultiplier: 2n * E18, effectiveAt: null });
    expect(safeStockStatus(r, MONDAY, TEST_CFG).verdict).toBe("Ok");
  });

  test("test_corporateAction_blocksFromAnnouncementUntilGraceAfterEffect", () => {
    pureOnly();
    const effective = MONDAY + 2n * BigInt(DAY_S);
    const announced = tsla({ newUIMultiplier: 4n * E18, effectiveAt: effective }); // 4:1 split
    expect(safeStockStatus(announced, MONDAY, TEST_CFG).verdict).toBe("CorporateActionPending");

    const applied = { ...announced, uiMultiplier: 4n * E18, round: printed(250n * 10n ** 8n, effective) };
    expect(safeStockStatus(applied, effective, TEST_CFG).verdict).toBe("CorporateActionPending");
    const almost = effective + BigInt(DAY_S) - 1n;
    expect(
      safeStockStatus({ ...applied, round: printed(250n * 10n ** 8n, almost) }, almost, TEST_CFG).verdict,
    ).toBe("CorporateActionPending");

    const after = effective + BigInt(DAY_S);
    const s = safeStockStatus({ ...applied, round: printed(250n * 10n ** 8n, after) }, after, TEST_CFG);
    expect(s.verdict).toBe("Ok");
    expect(s.priceWad).toBe(250n * E18);
  });

  test("test_multiplierIsNeverAppliedToFeedPrice", () => {
    pureOnly();
    // A 5% stock dividend, effective at MONDAY; checked one grace period later. Feed = $250/share × 1.05.
    const at = MONDAY + BigInt(DAY_S);
    const r = tsla({
      uiMultiplier: 1_050000000000000000n,
      newUIMultiplier: 1_050000000000000000n,
      effectiveAt: MONDAY,
      round: printed(26_250_000_000n, at),
    });
    const s = safeStockStatus(r, at, TEST_CFG);
    expect(s.verdict).toBe("Ok");
    expect(s.priceWad).toBe(262_500000000000000000n); // not 275.625 (= × 1.05 again)
  });

  test("feed read failures: status() would revert, unless a pause or corporate action trips first", () => {
    pureOnly();
    expect(safeStockStatus(tsla({ round: null }), MONDAY, TEST_CFG).verdict).toBe("FeedUnreadable");
    expect(safeStockStatus(tsla({ round: null, paused: true }), MONDAY, TEST_CFG).verdict).toBe(
      "TokenPaused",
    );
  });

  test("mainnet config and NVDA as read on 2026-09-29: multiplier 1.000775, change long settled", () => {
    pureOnly();
    expect(MAX_PRICE_AGE).toBe(25 * HOUR);
    expect(CORPORATE_ACTION_GRACE).toBe(DAY_S);
    const now = 1_790_706_485n;
    const nvda = tsla({
      uiMultiplier: 1_000775159164630595n,
      newUIMultiplier: 1_000775159164630595n,
      effectiveAt: 1_788_998_430n,
      round: printed(22_817_673_628n, 1_790_704_599n),
    });
    const s = safeStockStatus(nvda, now);
    expect(s.verdict).toBe("Ok");
    expect(s.priceWad).toBe(toWad(22_817_673_628n, 8));
    // A weekend gap (Friday 20:00 ET to Sunday 20:00 ET, 48 h) is past the 25 h limit.
    expect(safeStockStatus(nvda, 1_790_704_599n + 48n * 3600n).verdict).toBe("StalePrice");
  });

  test("toWad scales both ways", () => {
    pureOnly();
    expect(toWad(250n * 10n ** 8n, 8)).toBe(250n * E18);
    expect(toWad(5n, 18)).toBe(5n);
    expect(toWad(1234n * 10n ** 20n, 20)).toBe(1234n * E18);
  });
});

test.describe("NYSE calendar (NyseTime + MarketCalendar)", () => {
  const MON_OCT_5 = 20_731;
  const THANKSGIVING_2026 = 20_783;
  const DAY_AFTER_THANKSGIVING_2026 = 20_784;
  const FRIDAY_CLOSE = 1_791_576_000;

  test("test_isMarketOpen", () => {
    pureOnly();
    expect(daysFromCivil(2026, 10, 5)).toBe(MON_OCT_5);
    const { open, close } = sessionOf(MON_OCT_5);
    expect(open).toBe(MON_OCT_5 * DAY_S + 13 * HOUR + 30 * 60);
    expect(isMarketOpen(open - 1)).toBe(false);
    expect(isMarketOpen(open)).toBe(true);
    expect(isMarketOpen(close - 1)).toBe(true);
    expect(isMarketOpen(close)).toBe(false);
    expect(isMarketOpen(open + 5 * DAY_S)).toBe(false); // Saturday
    expect(isMarketOpen(open + 6 * DAY_S)).toBe(false); // Sunday
    expect(isMarketOpen(THANKSGIVING_2026 * DAY_S + 16 * HOUR)).toBe(false);
    expect(isMarketOpen(Number(MONDAY))).toBe(true); // StockOracleTest.test_viewsAndMarketHours
    expect(sessionOf(Math.floor(FRIDAY_CLOSE / DAY_S)).close).toBe(FRIDAY_CLOSE);
  });

  test("test_dstTransitions2026 and test_winterSessionIsOneHourLaterInUtc", () => {
    pureOnly();
    const mar8 = daysFromCivil(2026, 3, 8);
    expect(isDst(mar8 - 1)).toBe(false);
    expect(isDst(mar8)).toBe(true);
    const nov1 = daysFromCivil(2026, 11, 1);
    expect(isDst(nov1 - 1)).toBe(true);
    expect(isDst(nov1)).toBe(false);
    const dec7 = daysFromCivil(2026, 12, 7);
    expect(sessionOf(dec7)).toEqual({
      open: dec7 * DAY_S + 14 * HOUR + 30 * 60,
      close: dec7 * DAY_S + 21 * HOUR,
    });
  });

  test("test_earlyClose", () => {
    pureOnly();
    const { close } = sessionOf(DAY_AFTER_THANKSGIVING_2026);
    expect(close).toBe(DAY_AFTER_THANKSGIVING_2026 * DAY_S + 18 * HOUR); // 13:00 EST
    expect(isMarketOpen(close - 1)).toBe(true);
    expect(isMarketOpen(close + 1)).toBe(false);
  });

  test("marketState points at the next open or close", () => {
    pureOnly();
    const { open, close } = sessionOf(MON_OCT_5);
    expect(marketState(open + 60)).toEqual({ open: true, nextChange: close });
    expect(marketState(close)).toEqual({ open: false, nextChange: sessionOf(MON_OCT_5 + 1).open });
    // Friday after the close: next open is Monday.
    expect(marketState(FRIDAY_CLOSE).nextChange).toBe(sessionOf(MON_OCT_5 + 7).open);
  });
});

test.describe("page", () => {
  test("renders the monitor without horizontal scroll", async ({ page }) => {
    await acknowledge(page);
    await page.goto("/app/monitor");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Monitor");
    await expect(page.getByText("What each check protects against")).toBeVisible();
    // Live data needs mainnet; either the table or the error state must settle.
    await expect(
      page
        .getByRole("table", { name: "Stock-token safety checks" })
        .or(page.getByRole("alert").filter({ hasText: "Couldn't read mainnet" })),
    ).toBeVisible({ timeout: 45_000 });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
