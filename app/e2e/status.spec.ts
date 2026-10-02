import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { MirrorAuditJson } from "../src/lib/mirrorAudit";
import {
  LAG_GRACE,
  SCHEDULES,
  STALE_AFTER,
  chainTone,
  feedVerdict,
  nextSlot,
  scheduleState,
  scheduleVerdict,
  type ChainStatusJson,
  type FeedStatusJson,
  type StatusJson,
} from "../src/lib/status";
import { acknowledge, horizontalOverflow, settle } from "./helpers";

// The liveness card at the top of /app/proof ("Running by itself"). The first group tests its judgments without a
// network: the feed thresholds, the schedule switches read from GitHub's run list, and that the schedules it
// describes are the ones in .github/workflows. The second renders the card from a fixture of /api/status with the
// viewer's clock pinned. The last calls the built route against the live chains (skipped when unreachable).
// Set STATUS_SHOTS=<dir> to save the card as <project>-status.png.

const ROOT = resolve(__dirname, "..", "..");
const pure = () => test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");
const at = (iso: string) => Date.parse(iso) / 1000;
const NOW = at("2026-10-05T14:00:00Z"); // a Monday, in session
const H = 3600;

function feed(
  symbol: string,
  age: number,
  mainnetAge: number | null,
  over: Partial<FeedStatusJson> = {},
): FeedStatusJson {
  return {
    symbol,
    feed: `0x${Buffer.from(symbol).toString("hex").padEnd(40, "0")}`,
    roundId: "16",
    price: "356.68",
    updatedAt: NOW - age,
    maxPriceAge: 25 * H,
    mainnetFeed: mainnetAge === null ? null : "0x4A1166a659A55625345e9515b32adECea5547C38",
    mainnet:
      mainnetAge === null
        ? null
        : { roundId: "18446744073709553056", price: "370.705", updatedAt: NOW - mainnetAge },
    mirrored: mainnetAge === null ? null : NOW - age >= NOW - mainnetAge,
    ...over,
  };
}

test.describe("liveness judgments", () => {
  test("the card describes the same schedules and switches as the workflow files", () => {
    pure();
    for (const s of SCHEDULES) {
      const yml = readFileSync(join(ROOT, ".github", "workflows", s.workflow), "utf8");
      const crons = [...yml.matchAll(/^\s*-\s*cron:\s*"([^"]+)"/gm)].map((m) => m[1]);
      expect(crons, s.workflow).toEqual(s.crons.map((c) => c.cron));
      expect(yml, s.workflow).toContain(`if: \${{ vars.${s.gate} == 'true' }}`);
    }
  });

  test("feeds: in step, behind mainnet, stale on a trading day, and no mainnet feed", () => {
    pure();
    const inStep = feedVerdict(feed("TSLA", 10 * 60, 10 * 60), NOW, true);
    expect(inStep).toMatchObject({ tone: "good", label: "In step" });
    // A mainnet print waiting less than the grace is the keeper's next run, not a lag.
    expect(feedVerdict(feed("TSLA", 2 * H, LAG_GRACE - 60), NOW, true)).toMatchObject({ tone: "good" });
    const behind = feedVerdict(feed("AMD", 3 * H, 2 * H), NOW, true);
    expect(behind).toMatchObject({ tone: "warn", label: "Behind mainnet" });
    expect(behind.detail).toContain("not mirrored after 2h 00m");
    const stale = feedVerdict(feed("PLTR", 30 * H, H), NOW, true);
    expect(stale).toMatchObject({ tone: "bad", label: "Stale" });
    expect(stale.detail).toContain("Last mirrored 1d 6h ago, past 26 h on a trading day");
    expect(stale.detail).toContain("older than 25 h (StalePrice)");
    // The same age on a weekend, with mainnet quiet too: in step, not stale.
    const weekend = feedVerdict(feed("TSLA", 40 * H, 40 * H), NOW, false);
    expect(weekend).toMatchObject({ tone: "good", label: "In step" });
    expect(weekend.detail).toContain("no session today");
    expect(STALE_AFTER).toBe(26 * H);
    expect(feedVerdict(feed("NFLX", 100 * H, null), NOW, true)).toMatchObject({
      tone: "neutral",
      label: "No mainnet feed",
    });
    expect(feedVerdict(feed("TSLA", 0, 0, { error: "HTTP 503" }), NOW, true)).toMatchObject({ tone: "bad" });
  });

  test("schedules: a skipped scheduled run means switched off; none yet; GitHub unreadable", () => {
    pure();
    const keeper = SCHEDULES.find((s) => s.workflow === "keeper.yml")!;
    const agent = SCHEDULES.find((s) => s.workflow === "agent.yml")!;
    const runs = [
      {
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        created_at: "2026-10-05T13:58:00Z",
        html_url: "u1",
      },
      {
        event: "schedule",
        status: "completed",
        conclusion: "skipped",
        created_at: "2026-10-05T13:37:35Z",
        html_url: "u2",
      },
    ];
    const off = { name: keeper.name, ...scheduleState("keeper.yml", runs) };
    expect(off).toMatchObject({ state: "off", lastScheduled: { url: "u2" }, lastManual: { url: "u1" } });
    const v = scheduleVerdict(off, keeper, NOW);
    expect(v).toMatchObject({ tone: "warn", label: "Switched off" });
    expect(v.detail).toBe(
      "The last scheduled run (Mon 5 Oct, 13:37 UTC) was skipped: its switch, the repository variable KEEPER_ENABLED, is not 'true'. Run by hand until the scheduled jobs are switched on.",
    );
    const on = { name: keeper.name, ...scheduleState("keeper.yml", [{ ...runs[1], conclusion: "success" }]) };
    expect(scheduleVerdict(on, keeper, NOW)).toMatchObject({ tone: "good", label: "On" });
    const failed = {
      name: keeper.name,
      ...scheduleState("keeper.yml", [{ ...runs[1], conclusion: "failure" }]),
    };
    expect(scheduleVerdict(failed, keeper, NOW)).toMatchObject({ tone: "bad", label: "On, last run failed" });
    const none = { name: agent.name, ...scheduleState("agent.yml", []) };
    expect(none.state).toBe("none");
    expect(scheduleVerdict(none, agent, NOW).detail).toContain("the next slot is Mon 5 Oct, 15:00 UTC");
    const unknown = { name: agent.name, ...scheduleState("agent.yml", null, "HTTP 403, rate limit") };
    expect(scheduleVerdict(unknown, agent, NOW)).toMatchObject({ tone: "neutral", label: "Unknown" });
    expect(scheduleVerdict(unknown, agent, NOW).detail).toContain("(HTTP 403, rate limit)");
  });

  test("next slots of the two cron shapes", () => {
    pure();
    const keeper = SCHEDULES.find((s) => s.workflow === "keeper.yml")!;
    const agent = SCHEDULES.find((s) => s.workflow === "agent.yml")!;
    expect(nextSlot(keeper, at("2026-10-05T14:03:10Z"))).toBe(at("2026-10-05T14:10:00Z"));
    expect(nextSlot(agent, at("2026-10-05T15:00:00Z"))).toBe(at("2026-10-09T21:15:00Z"));
    expect(nextSlot(agent, at("2026-10-09T22:00:00Z"))).toBe(at("2026-10-12T15:00:00Z"));
  });
});

/* ------------------------------------------------------------------ the card, from a fixture */

const SETTLE_TX = `0x${"5e".repeat(32)}`;
const ABORT_TX = "0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7";

function chain46630(): ChainStatusJson {
  return {
    chainId: 46630,
    chainName: "Robinhood Chain testnet",
    explorer: "https://explorer.testnet.chain.robinhood.com",
    blockTime: NOW,
    tradingDay: true,
    marketOpen: true,
    feeds: [
      feed("AMD", 3 * H, 2 * H),
      feed("NFLX", 100 * H, null),
      feed("PLTR", 30 * H, H),
      feed("TSLA", 10 * 60, 10 * 60),
    ],
    deployments: [
      {
        version: "v2",
        epochManager: "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99",
        vaults: [
          {
            address: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
            symbol: "sTSLA-CC",
            isCall: true,
            state: 2,
            epoch: "2",
            expiry: at("2026-10-09T20:00:00Z"),
            lastSettlement: {
              epoch: "1",
              kind: "settled",
              tx: SETTLE_TX,
              time: at("2026-10-02T20:41:00Z"),
              price: "$371.20",
            },
          },
          {
            address: "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7",
            symbol: "sTSLA-CSP",
            isCall: false,
            state: 0,
            epoch: "1",
            expiry: null,
            lastSettlement: {
              epoch: "1",
              kind: "aborted",
              tx: ABORT_TX,
              time: at("2026-09-29T20:44:16Z"),
              price: null,
            },
          },
        ],
      },
    ],
    errors: [],
  };
}

function fixture(): StatusJson {
  return {
    generatedAt: new Date((NOW - 120) * 1000).toISOString(),
    chains: [
      chain46630(),
      {
        ...chain46630(),
        chainId: 421614,
        chainName: "Arbitrum Sepolia",
        explorer: "https://sepolia.arbiscan.io",
        feeds: [feed("NVDA", 5 * 60, 5 * 60), feed("TSLA", 10 * 60, 10 * 60)],
        deployments: [
          {
            version: "v3",
            epochManager: "0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0",
            vaults: [
              {
                address: "0x5655659E18bf54ee0EF8f6A816E2e18D000F7311",
                symbol: "sTSLA-CC",
                isCall: true,
                state: 2,
                epoch: "1",
                expiry: at("2026-10-02T20:00:00Z"),
                lastSettlement: null,
              },
            ],
          },
        ],
      },
    ],
    schedules: [
      {
        name: "Testnet keeper",
        workflow: "keeper.yml",
        state: "off",
        lastScheduled: {
          event: "schedule",
          status: "completed",
          conclusion: "skipped",
          createdAt: "2026-10-05T13:37:35Z",
          url: "https://github.com/Prashant-thakur77/Strike/actions/runs/1",
        },
        lastManual: null,
      },
      { name: "Weekly agent", workflow: "agent.yml", state: "none", lastScheduled: null, lastManual: null },
    ],
  };
}

function auditFixture(chainId: number): MirrorAuditJson {
  return {
    chainId,
    chainName: chainId === 46630 ? "Robinhood Chain testnet" : "Arbitrum Sepolia",
    checkedAt: new Date(NOW * 1000).toISOString(),
    testnetBlock: "127600000",
    mainnetBlock: "78300000",
    ok: true,
    rounds: chainId === 46630 ? 66 : 23,
    matched: chainId === 46630 ? 66 : 23,
    mismatched: 0,
    counts: { match: 66, "no-mainnet-round": 0, "answer-differs": 0, "future-timestamp": 0 },
    unverifiable: [],
    seeds: [],
    largestGap: null,
    mismatches: [],
    oracleFeeds: [],
    managerOracles: [],
    feeds: [],
    command: `node scripts/verify-mirror.mjs --chain ${chainId}`,
  };
}

async function serve(page: Page, body: StatusJson) {
  await page.clock.setFixedTime(new Date(NOW * 1000));
  await page.route("**/api/status", (route) => route.fulfill({ json: body }));
  await page.route("**/api/mirror-audit?**", (route) => {
    const chain = Number(new URL(route.request().url()).searchParams.get("chain"));
    return route.fulfill({ json: auditFixture(chain) });
  });
}

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test("proof: the liveness card shows each chain's mirrored prices, epochs, settlements and schedules", async ({
  page,
}) => {
  await serve(page, fixture());
  await page.goto("/app/proof#status");
  const card = page.getByTestId("liveness");
  const rh = card.locator('[data-testid="liveness-chain"][data-chain="46630"]');
  await expect(rh).toHaveAttribute("data-tone", "bad");
  await expect(rh.getByTestId("liveness-chain-tone")).toHaveText("Stale");
  await expect(rh.getByTestId("liveness-age")).toHaveText("10m old");
  await expect(rh.locator('li[data-symbol="TSLA"]')).toContainText("In step");
  await expect(rh.locator('li[data-symbol="AMD"]')).toContainText("Behind mainnet");
  await expect(rh.locator('li[data-symbol="AMD"]')).toContainText("not mirrored after 2h 00m");
  await expect(rh.locator('li[data-symbol="PLTR"]')).toContainText("Stale");
  await expect(rh.locator('li[data-symbol="PLTR"]')).toContainText("past 26 h on a trading day");
  await expect(rh.locator('li[data-symbol="NFLX"]')).toContainText("No mainnet feed");

  const cc = rh.locator('li[data-vault="0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e"]');
  await expect(cc).toHaveAttribute("data-state", "Selling");
  await expect(cc.getByTestId("vault-expiry")).toHaveText("Expires Fri 9 Oct, 20:00 UTC");
  await expect(cc.getByTestId("vault-last-settlement")).toContainText(
    "Epoch 1 settled at $371.20, Fri 2 Oct, 20:41 UTC",
  );
  await expect(cc.getByRole("link", { name: "tx" })).toHaveAttribute(
    "href",
    `https://explorer.testnet.chain.robinhood.com/tx/${SETTLE_TX}`,
  );
  await expect(cc.getByRole("link", { name: "sTSLA-CC" })).toHaveAttribute(
    "href",
    "/app/vault/0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e?chain=46630",
  );
  const csp = rh.locator('li[data-vault="0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7"]');
  await expect(csp.getByTestId("vault-last-settlement")).toContainText("Epoch 1 aborted");
  await expect(rh.getByTestId("liveness-audit")).toContainText(
    "✓ 66 of 66 rounds match Robinhood Chain mainnet Chainlink",
  );
  await expect(rh.getByTestId("liveness-audit").getByRole("link")).toHaveAttribute("href", "#mirror");

  const arb = card.locator('[data-testid="liveness-chain"][data-chain="421614"]');
  await expect(arb).toHaveAttribute("data-tone", "good");
  await expect(arb.getByTestId("liveness-age")).toHaveText("5m old");
  // Expired and still selling: waiting for the settle transaction.
  await expect(arb.getByTestId("vault-expiry")).toHaveText(
    "Expired Fri 2 Oct, 20:00 UTC, waiting for settle",
  );
  await expect(arb.getByTestId("vault-last-settlement")).toHaveText("Never settled yet");

  const keeper = card.locator('[data-testid="liveness-schedule"][data-workflow="keeper.yml"]');
  await expect(keeper).toHaveAttribute("data-state", "off");
  await expect(keeper).toContainText("Switched off");
  await expect(keeper).toContainText("Run by hand until the scheduled jobs are switched on.");
  await expect(keeper.getByRole("link", { name: /last scheduled run/ })).toHaveAttribute(
    "href",
    "https://github.com/Prashant-thakur77/Strike/actions/runs/1",
  );
  const agent = card.locator('[data-testid="liveness-schedule"][data-workflow="agent.yml"]');
  await expect(agent).toContainText("No scheduled run yet");
  await expect(agent).toContainText("the next slot is Mon 5 Oct, 15:00 UTC");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  const dir = process.env.STATUS_SHOTS;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior }));
    await settle(page, 800);
    const rail = page.locator("#status");
    const box = (await rail.boundingBox())!;
    await page.screenshot({
      path: join(dir, `${test.info().project.name}-status.png`),
      fullPage: true,
      clip: { x: 0, y: box.y - 16, width: page.viewportSize()!.width, height: box.height + 32 },
    });
  }
});

test("proof: the liveness card says when /api/status cannot be read, with a retry", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  await page.route("**/api/status", (route) =>
    route.fulfill({ status: 502, json: { error: "Could not read the status: HTTP 503" } }),
  );
  await page.goto("/app/proof#status");
  const card = page.getByTestId("liveness");
  await expect(card.getByRole("alert")).toContainText(
    "Couldn't read the status: Could not read the status: HTTP 503",
    {
      timeout: 30_000,
    },
  );
  await expect(card.getByRole("button", { name: /try again/i })).toBeVisible();
});

test("the chain tone ignores feeds with nothing to mirror", () => {
  pure();
  const c = chain46630();
  c.feeds = [feed("NFLX", 100 * H, null), feed("TSLA", 60, 60)];
  expect(chainTone(c, NOW)).toBe("good");
});

/* ------------------------------------------------------------------ the built route, live */

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

test("GET /api/status: both testnets, every deployment's vaults, both schedules", async ({ request }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  const res = await request.get("/api/status", { timeout: 90_000 });
  test.skip(res.status() === 502, `the route could not read the chains: ${(await res.json()).error}`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toMatch(/s-maxage=(300|60)/);
  const s = (await res.json()) as StatusJson;
  expect(s.chains.map((c) => c.chainId)).toEqual([46630, 421614]);
  const rh = s.chains[0]!;
  expect(rh.errors).toEqual([]);
  expect(rh.deployments.map((d) => d.version)).toEqual(["v2", "v3"]);
  expect(rh.deployments[0]!.vaults.map((v) => v.address)).toEqual(
    expect.arrayContaining([
      "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
      "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7",
    ]),
  );
  // v2's put vault has closed at least one epoch (the 29 September abort that paid the slash to depositors).
  const csp = rh.deployments[0]!.vaults.find(
    (v) => v.address === "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7",
  )!;
  expect(csp.lastSettlement?.tx).toMatch(/^0x[0-9a-f]{64}$/);
  expect(Number(csp.lastSettlement?.epoch)).toBeGreaterThanOrEqual(1);
  const tsla = rh.feeds.find((f) => f.symbol === "TSLA")!;
  expect(tsla.mainnetFeed).toBe("0x4A1166a659A55625345e9515b32adECea5547C38");
  expect(tsla.maxPriceAge).toBe(25 * H);
  expect(tsla.updatedAt).toBeGreaterThan(0);
  expect(s.schedules.map((x) => x.workflow)).toEqual(["keeper.yml", "agent.yml"]);
});
