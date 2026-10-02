import { expect, test, type Page } from "@playwright/test";
import type { MirrorAudit, MirrorFeedAudit, MirrorRoundCheck } from "@strike/sdk";
import {
  MIRROR_CHAIN_NAMES,
  MIRROR_ERROR_TTL_MS,
  MIRROR_TTL_MS,
  MirrorAuditCache,
  type MirrorAuditJson,
  formatAnswer,
  headline,
  mirrorBadge,
  parseMirrorChain,
  toMirrorAuditJson,
  verifyCommand,
} from "../src/lib/mirrorAudit";
import { acknowledge, horizontalOverflow } from "./helpers";

// The price mirror audit in the app. The first group tests the route's logic (src/lib/mirrorAudit.ts) without a
// network: the JSON it serves, its cache, the badge text. The second renders the "Price mirror audit" section of
// /app/proof and the vault badge with /api/mirror-audit answered from a fixture. The last calls the built route,
// which audits the live chains (skipped when their RPCs are unreachable).

const pure = () => test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
const PHASE1 = 1n << 64n;
const T0 = 1_790_700_000n;

/** A round as the SDK returns it: `status` against mainnet round `agg` of phase 1 (or none). */
function round(id: number, answer: bigint, at: bigint, status: MirrorRoundCheck["status"], agg?: bigint) {
  return {
    roundId: BigInt(id),
    answer,
    updatedAt: at,
    pushTx: `0x${id.toString(16).padStart(64, "0")}` as const,
    pushBlock: 1000n + BigInt(id),
    status,
    mainnet:
      agg === undefined
        ? null
        : {
            roundId: PHASE1 + agg,
            phase: 1,
            aggregatorRound: agg,
            answer: status === "answer-differs" ? answer - 1n : answer,
            updatedAt: at,
          },
  } satisfies MirrorRoundCheck;
}

/** A 46630-shaped audit: TSLA with the deploy seed and 15 keeper rounds, NFLX unchecked; optionally a tampered round. */
function sdkAudit(tamper = false): MirrorAudit {
  const rounds: MirrorRoundCheck[] = [round(1, 369_00000000n, T0 - 70_000n, "deploy-seed")];
  for (let i = 2; i <= 16; i++) {
    const tampered = tamper && i === 9;
    rounds.push(
      round(
        i,
        35_000_000_000n + BigInt(i) * 1_000_000n,
        T0 + BigInt(i) * 1440n,
        tampered ? "answer-differs" : "match",
        1388n + BigInt(i),
      ),
    );
  }
  const counts = {
    match: tamper ? 14 : 15,
    "no-mainnet-round": 0,
    "answer-differs": tamper ? 1 : 0,
    "future-timestamp": 0,
  };
  const gap = {
    fromRound: 2n,
    toRound: 3n,
    from: T0 + 2880n,
    to: T0 + 80_497n,
    seconds: 77_617n,
    mainnetRoundsBetween: 13,
  };
  const tsla: MirrorFeedAudit = {
    symbol: "TSLA",
    testnetFeed: "0x5476cb08769f406dE95F6171AcC1F5FE88431230",
    mainnetFeed: "0x4A1166a659A55625345e9515b32adECea5547C38",
    testnetDecimals: 8,
    mainnetDecimals: 8,
    mainnetDescription: "RHTSLA / USD",
    latestRound: 16n,
    fromRound: 1n,
    toRound: 16n,
    rounds,
    counts,
    seed: rounds[0]!,
    mainnetRoundsInWindow: 41,
    mainnetRoundsAfterLastPush: 1,
    largestGap: gap,
    unverifiable: null,
  };
  const nflx: MirrorFeedAudit = {
    ...tsla,
    symbol: "NFLX",
    testnetFeed: "0xc7e34AC0E39663b580Fe044c04F2b7aa7949b30D",
    mainnetFeed: null,
    mainnetDecimals: null,
    mainnetDescription: null,
    latestRound: 1n,
    toRound: 1n,
    rounds: [round(1, 1200_00000000n, T0 - 70_000n, "unchecked")],
    counts: { match: 0, "no-mainnet-round": 0, "answer-differs": 0, "future-timestamp": 0 },
    seed: null,
    mainnetRoundsInWindow: 0,
    mainnetRoundsAfterLastPush: 0,
    largestGap: null,
    unverifiable: "Chainlink publishes no NFLX feed on Robinhood Chain mainnet",
  };
  return {
    chainId: 46630,
    mainnetChainId: 4663,
    mainnetBlock: 78_221_452n,
    mainnetTime: 1_790_943_139n,
    testnetBlock: 127_590_299n,
    testnetTime: 1_790_943_136n,
    feeds: [nflx, tsla],
    oracleFeeds: [
      {
        version: "v2",
        stockOracle: "0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89",
        symbol: "TSLA",
        token: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E",
        feed: "0x5476cb08769f406dE95F6171AcC1F5FE88431230",
        expected: "0x5476cb08769f406dE95F6171AcC1F5FE88431230",
        same: true,
      },
    ],
    managerOracles: [
      {
        version: "v2",
        epochManager: "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99",
        oracle: "0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89",
        expected: "0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89",
        same: true,
      },
    ],
    summary: {
      rounds: 15,
      matched: counts.match,
      mismatched: 15 - counts.match,
      counts,
      unverifiable: [{ symbol: "NFLX", rounds: 1, reason: nflx.unverifiable! }],
      seeds: [{ symbol: "TSLA", roundId: 1n, answer: 369_00000000n, updatedAt: T0 - 70_000n }],
      largestGap: { ...gap, symbol: "TSLA" },
    },
    ok: !tamper,
  };
}

test.describe("mirror audit route logic", () => {
  test("parses ?chain=: the two mirrored testnets, 46630 by default, anything else a 400", () => {
    pure();
    expect(parseMirrorChain(null)).toEqual({ chainId: 46630 });
    expect(parseMirrorChain("421614")).toEqual({ chainId: 421614 });
    for (const bad of ["4663", "31337", "abc", "46630.0", "-1"])
      expect(parseMirrorChain(bad)).toHaveProperty("error");
  });

  test("serves the SDK's audit as JSON: strings for big numbers, prices with decimals, mismatches listed", () => {
    pure();
    const ok = toMirrorAuditJson(sdkAudit());
    expect(JSON.parse(JSON.stringify(ok))).toEqual(ok); // no bigint left
    expect(ok).toMatchObject({
      chainId: 46630,
      chainName: "Robinhood Chain testnet",
      ok: true,
      rounds: 15,
      matched: 15,
    });
    expect(ok.checkedAt).toBe("2026-10-02T12:12:19.000Z");
    expect(ok.command).toBe("node scripts/verify-mirror.mjs --chain 46630");
    expect(ok.seeds).toEqual([
      { symbol: "TSLA", roundId: "1", price: "369", updatedAt: Number(T0 - 70_000n) },
    ]);
    expect(ok.mismatches).toEqual([]);
    const tsla = ok.feeds.find((f) => f.symbol === "TSLA")!;
    expect(tsla).toMatchObject({ checked: 15, matched: 15, mainnetPrints: 41, mainnetPrintsSince: 1 });
    expect(tsla.rounds[1]).toMatchObject({ roundId: "2", price: "350.02", mainnetRound: "1:1390" });
    expect(tsla.rounds[1]!.mainnetRoundId).toBe((PHASE1 + 1390n).toString());
    expect(ok.feeds.find((f) => f.symbol === "NFLX")).toMatchObject({
      checked: 0,
      unverifiable: /no NFLX feed/,
    });

    const bad = toMirrorAuditJson(sdkAudit(true));
    expect(bad).toMatchObject({ ok: false, matched: 14, mismatched: 1 });
    expect(bad.mismatches).toHaveLength(1);
    expect(bad.mismatches[0]).toMatchObject({
      symbol: "TSLA",
      roundId: "9",
      status: "answer-differs",
      price: "350.09",
      mainnetPrice: "350.08999999",
    });
  });

  test("runs one audit per chain per 10 minutes, shares a run between concurrent requests, retries a failure sooner", async () => {
    pure();
    let now = 1_000_000;
    let runs = 0;
    let fail = false;
    const cache = new MirrorAuditCache(
      async () => {
        runs++;
        await new Promise((r) => setTimeout(r, 5));
        if (fail) throw new Error("HTTP 403\nmore detail");
        return sdkAudit();
      },
      () => now,
    );
    const [a, b] = await Promise.all([cache.get(46630), cache.get(46630)]);
    expect(runs).toBe(1);
    expect(a.value?.matched).toBe(15);
    expect(b.value).toEqual(a.value);
    now += MIRROR_TTL_MS - 1;
    expect((await cache.get(46630)).cached).toBe(true);
    expect(runs).toBe(1);
    await cache.get(421614);
    expect(runs).toBe(2); // another chain, another run
    now += 2;
    fail = true;
    const err = await cache.get(46630);
    expect(err).toMatchObject({ value: undefined, error: "HTTP 403", cached: false });
    expect(runs).toBe(3);
    now += MIRROR_ERROR_TTL_MS - 1;
    expect((await cache.get(46630)).error).toBe("HTTP 403");
    expect(runs).toBe(3);
    now += 2;
    fail = false;
    expect((await cache.get(46630)).value?.ok).toBe(true);
    expect(runs).toBe(4);
  });

  test("words the vault badge and the headline", () => {
    pure();
    const ok = toMirrorAuditJson(sdkAudit());
    expect(headline(ok)).toBe("15 of 15 rounds match Robinhood Chain mainnet Chainlink");
    expect(mirrorBadge(ok, "TSLA")).toMatchObject({
      ok: true,
      text: "Price checked against mainnet Chainlink ✓ (15 of 15 rounds)",
    });
    expect(mirrorBadge(ok, "tsla")?.ok).toBe(true);
    expect(mirrorBadge(ok, "NFLX")).toMatchObject({
      ok: false,
      text: "Price not checkable against mainnet Chainlink (1 round)",
    });
    expect(mirrorBadge(ok, "AAPL")).toBeNull();
    const bad = toMirrorAuditJson(sdkAudit(true));
    expect(mirrorBadge(bad, "TSLA")).toMatchObject({
      ok: false,
      text: "Price mirror audit: 1 of 15 rounds do not match mainnet Chainlink",
    });
    expect(formatAnswer(35_766_999_999n, 8)).toBe("357.66999999");
  });
});

/* ------------------------------------------------------------------ the page, from a fixture */

/** Answer /api/mirror-audit from the fixture; record the chains asked for. */
async function serveAudit(page: Page, body: (chain: number) => MirrorAuditJson) {
  const asked: number[] = [];
  await page.route("**/api/mirror-audit?**", async (route) => {
    const chain = Number(new URL(route.request().url()).searchParams.get("chain"));
    asked.push(chain);
    const b = body(chain);
    await route.fulfill({
      json: {
        ...b,
        chainId: chain,
        chainName: MIRROR_CHAIN_NAMES[chain as 46630],
        command: verifyCommand(chain),
      },
    });
  });
  return asked;
}

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test("proof: the price mirror audit section says what is trusted, verified and not caught", async ({
  page,
}) => {
  const asked = await serveAudit(page, () => toMirrorAuditJson(sdkAudit()));
  await page.goto("/app/proof#mirror");
  const section = page.locator("#mirror");
  await expect(section.getByRole("heading", { name: "Price mirror audit" })).toBeVisible();
  await expect(section.getByTestId("mirror-headline")).toHaveText(
    "✓ 15 of 15 rounds match Robinhood Chain mainnet Chainlink",
  );
  await expect(section.getByTestId("mirror-verdict")).toHaveAttribute("data-state", "ok");

  const trust = section.getByTestId("mirror-trust");
  await expect(trust.locator("dt")).toHaveText(["Trusted", "Verified", "Not caught"]);
  await expect(trust).toContainText("When the keeper pushes");
  await expect(trust).toContainText("same timestamp, same answer");
  await expect(trust).toContainText(
    "The largest gap between pushes is 21h 33m (TSLA round 2 to 3, 13 mainnet prints in between not mirrored)",
  );

  const feeds = section.getByTestId("mirror-feeds");
  await expect(feeds.locator('tr[data-symbol="TSLA"]')).toContainText("15 of 15");
  await expect(feeds.locator('tr[data-symbol="TSLA"]')).toContainText("15 of 41 · 1 since");
  await expect(feeds.locator('tr[data-symbol="NFLX"]')).toContainText("not checked");
  await expect(section.getByTestId("mirror-seeds")).toContainText("round 1 of TSLA (369) is the price");
  await expect(section).toContainText("Not checked: NFLX (1 round). Chainlink publishes no NFLX feed");
  await expect(section.getByLabel("Audit command")).toContainText(
    "node scripts/verify-mirror.mjs --chain 46630",
  );
  await expect(section.getByTestId("mirror-mismatches")).toHaveCount(0);
  await expect(section.getByTestId("mirror-oracles")).toContainText(
    "The StockOracle of each deployment reads these MirrorFeeds for every listed token (1 checked with feedConfig)",
  );

  // Every round, folded; a round number links to its push transaction on the testnet explorer.
  await section.getByText("Show every round").click();
  const tslaRounds = section.getByRole("table", { name: "TSLA rounds" });
  await expect(tslaRounds.locator("tbody tr")).toHaveCount(16);
  await expect(tslaRounds.locator('tr[data-status="deploy-seed"]')).toContainText(
    "Deploy seed, not a mainnet price",
  );
  await expect(tslaRounds.getByRole("link", { name: "2", exact: true })).toHaveAttribute(
    "href",
    `https://explorer.testnet.chain.robinhood.com/tx/0x${"2".padStart(64, "0")}`,
  );

  // The other testnet.
  await section.getByRole("button", { name: "Arbitrum Sepolia" }).click();
  await expect.poll(() => asked.includes(421614)).toBe(true);
  await expect(section.getByLabel("Audit command")).toContainText("--chain 421614");
  expect(asked[0]).toBe(46630);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("proof: a round that does not match turns the verdict red and is listed", async ({ page }) => {
  await serveAudit(page, () => toMirrorAuditJson(sdkAudit(true)));
  await page.goto("/app/proof#mirror");
  const section = page.locator("#mirror");
  await expect(section.getByTestId("mirror-verdict")).toHaveAttribute("data-state", "mismatch");
  await expect(section.getByTestId("mirror-headline")).toHaveText(
    "✗ 14 of 15 rounds match Robinhood Chain mainnet Chainlink",
  );
  const list = section.getByTestId("mirror-mismatches");
  await expect(list).toContainText("1 round that does not match");
  await expect(list).toContainText("TSLA round 9: 350.09 at");
  await expect(list).toContainText("Answer differs (mainnet 1:1397 printed 350.08999999)");
});

test("proof: an audit that cannot run says so and offers a retry", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  await page.route("**/api/mirror-audit?**", (route) =>
    route.fulfill({ status: 502, json: { error: "Could not run the price mirror audit: HTTP 403" } }),
  );
  await page.goto("/app/proof#mirror");
  const verdict = page.locator("#mirror").getByTestId("mirror-verdict");
  await expect(verdict).toHaveAttribute("data-state", "error", { timeout: 30_000 });
  await expect(verdict).toContainText(
    "Couldn't run the audit: Could not run the price mirror audit: HTTP 403",
  );
  await expect(verdict.getByRole("button", { name: /try again/i })).toBeVisible();
});

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

test("vault page: the spot price carries the audit's badge, linking to the proof section", async ({
  page,
}) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  await serveAudit(page, () => toMirrorAuditJson(sdkAudit()));
  await page.goto("/app/vault/0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e?chain=46630");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA", { timeout: 45_000 });
  const badge = page.getByTestId("mirror-badge");
  await expect(badge).toHaveText("Price checked against mainnet Chainlink ✓ (15 of 15 rounds)");
  await expect(badge).toHaveAttribute("href", "/app/proof#mirror");
  await expect(badge).toHaveAttribute("data-ok", "true");
});

/* ------------------------------------------------------------------ the built route, live */

test("GET /api/mirror-audit: 400 for a chain without mirrors; the live audit for 46630", async ({
  request,
}) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  const bad = await request.get("/api/mirror-audit?chain=4663");
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatch(/46630 or 421614/);

  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  const res = await request.get("/api/mirror-audit?chain=46630", { timeout: 90_000 });
  test.skip(res.status() === 502, `the route could not read the chains: ${(await res.json()).error}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("s-maxage=600");
  const a = (await res.json()) as MirrorAuditJson;
  expect(a.chainId).toBe(46630);
  expect(a.rounds).toBeGreaterThan(0);
  expect(a.ok).toBe(a.mismatched === 0);
  expect(a.matched + a.mismatched).toBe(a.rounds);
  expect(a.feeds.map((f) => f.symbol)).toEqual(
    expect.arrayContaining(["TSLA", "AMD", "AMZN", "PLTR", "NFLX"]),
  );
  const tsla = a.feeds.find((f) => f.symbol === "TSLA")!;
  expect(tsla.mainnetFeed).toBe("0x4A1166a659A55625345e9515b32adECea5547C38");
  expect(tsla.checked).toBeGreaterThanOrEqual(15);
});
