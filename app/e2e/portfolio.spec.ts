import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import {
  buildAgents,
  buildOptions,
  fromIndexer,
  modelOddsBeyond,
  priceAt,
  replayVault,
  sortActivity,
  totalsOf,
  valueSeries,
} from "../src/lib/portfolioLedger";
import {
  buildPortfolio,
  opportunities,
  type HoldingInput,
  type PortfolioJson,
} from "../src/lib/portfolioView";
import {
  ACCT,
  agentFixture,
  callFixture,
  depositsFixture,
  optionFixture,
  queuedFixture,
} from "./fixtures/portfolio";
import { acknowledge, horizontalOverflow } from "./helpers";

// /app/portfolio and GET /api/portfolio: one wallet across every Strike deployment. The arithmetic on hand-made
// histories (e2e/fixtures/portfolio.ts: deposits, a settled epoch, a pending one, a queued deposit, an option
// holder, an agent, nothing at all), the page on those fixtures through a mocked API, and the real API for a team
// QA wallet on Robinhood Chain testnet, cross-checked against balanceOf read here from the public RPC.

const RPC = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";
const REPO = join(__dirname, "..", "..");
/** QA test wallet 1 (docs/testnet-epochs/2026-10-03-end-to-end-qa.md): 5 USDG into the v3 put vault, 2 back. */
const QA1 = "0x7767ca2d944A91e6ae896f85cACA4DfDE1810044";
const QA1_DEPOSIT_TX = "0xaef908d7e4126a3b8f5bbbe08bf1123323ade5e0c6fedcc65246664bda62767c";

type Part = {
  logs: Parameters<typeof replayVault>[1];
  input: Parameters<typeof replayVault>[0];
  now: number;
};

function portfolio(
  vaults: Part[],
  now: number,
  extra: {
    option?: ReturnType<typeof optionFixture>;
    agent?: ReturnType<typeof agentFixture>;
    holdings?: HoldingInput[];
  } = {},
): PortfolioJson {
  const replays = vaults.map((v) => replayVault(v.input, v.logs, ACCT, v.now));
  const positions = replays.map((r) => r.position).filter((p) => p.touched);
  const totals = totalsOf(positions);
  const opt = extra.option
    ? buildOptions([extra.option.input], extra.option.logs, ACCT, now)
    : { options: [], activity: [] };
  return buildPortfolio({
    address: ACCT,
    now,
    generatedAt: new Date(now * 1000).toISOString(),
    source: "rpc",
    chains: [{ key: "46630-v3", chainId: 46630, label: "Robinhood Chain testnet", ok: true, source: "rpc" }],
    positions,
    totals,
    chart: valueSeries(replays, now, totals),
    markers: replays.flatMap((r) => r.markers),
    activity: sortActivity([...replays.flatMap((r) => r.activity), ...opt.activity]),
    options: opt.options,
    optionRaw: extra.option?.raw ?? {},
    agents: extra.agent ? buildAgents([extra.agent.input], extra.agent.logs, ACCT) : [],
    holdings: extra.holdings ?? [],
    nextOpen: {},
    managers: extra.option?.managers ?? {},
  });
}

const near = (a: number, b: number, digits = 6) => expect(a).toBeCloseTo(b, digits);

test.describe("portfolio arithmetic", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("deposits, a settled epoch, a withdrawal and a premium claim", () => {
    const f = depositsFixture();
    const { position: p, steps, activity } = replayVault(f.input, f.logs, ACCT, f.now);
    expect(p.check.ok).toBe(true);
    near(p.shares, 60);
    near(p.valueUsd, 60);
    near(p.depositedUsd, 100);
    near(p.withdrawnUsd, 40);
    near(p.premiumClaimed, 5);
    near(p.premiumEarned, 5);
    near(p.pnlUsd, 5);
    near(p.realisedUsd, 5);
    near(p.unrealisedUsd, 0);
    near(p.costBasisUsd, 60);
    expect(p.epochs).toHaveLength(1);
    expect(p.epochs[0]).toMatchObject({ epoch: 1, status: "settled", strike: 280, settlementPrice: 290 });
    near(p.epochs[0]!.premium!, 5);
    near(p.epochs[0]!.net!, 5);
    near(p.epochs[0]!.shareOfVault, 0.5);
    expect(activity.map((a) => a.kind)).toEqual(["deposit", "withdraw", "premium-claimed"]);
    expect(steps.at(-1)).toMatchObject({ t: 7100, assets: 60, premiumPending: 0, invested: 55 });
    const t = totalsOf([p]);
    near(t.pnlUsd, 5);
    near(t.pnlPct!, 0.05);
  });

  test("a settled covered-call epoch: payout at the settlement price, and holding the tokens to compare", () => {
    const f = callFixture();
    const { position: p } = replayVault(f.input, f.logs, ACCT, f.now);
    expect(p.check.ok).toBe(true);
    const e = p.epochs[0]!;
    near(e.premium!, 3);
    near(e.payoutAssets!, 0.5);
    near(e.payoutUsd!, 60);
    near(e.net!, -57);
    near(e.holdUsd!, 200, 4);
    near(p.depositedUsd, 1000);
    near(p.valueAssets, 9.5);
    near(p.valueUsd, 1140);
    near(p.pnlUsd, 143);
    near(p.pnlAssets, -0.5);
  });

  test("a pending epoch: expired and settling, or running with the model's odds", () => {
    const expired = callFixture({ expiry: 9000, now: 9500 });
    const a = replayVault(expired.input, expired.logs, ACCT, expired.now).position;
    expect(a.exposure?.phase).toBe("expired");
    expect(a.exposure?.modelProbItm).toBeNull();
    expect(a.epochs.at(-1)?.status).toBe("expired-settling");
    const pf = portfolio([expired], expired.now);
    expect(pf.actions.map((x) => x.kind)).toContain("settling");
    expect(pf.epochs[0]!.status).toBe("expired-settling");

    const running = callFixture({ expiry: 9000 + 7 * 86_400, now: 9000 });
    const b = replayVault(running.input, running.logs, ACCT, running.now).position;
    expect(b.epochs.at(-1)?.status).toBe("running");
    const x = b.exposure!;
    expect(x.phase).toBe("selling");
    near(x.shareOfVault, 1);
    near(x.collateralAtRisk, 2);
    near(x.collateralAtRiskUsd, 260);
    near(x.breakEven!, 132);
    expect(x.modelProbItm!).toBeGreaterThan(0);
    expect(x.modelProbItm!).toBeLessThan(1);
    expect(x.modelProbLoss!).toBeLessThan(x.modelProbItm!);
  });

  test("a queued deposit: shares from the settlement, premium the contract credits at the claim", () => {
    const f = queuedFixture();
    const { position: p } = replayVault(f.input, f.logs, ACCT, f.now);
    expect(p.check.ok).toBe(true);
    near(p.claimableDepositShares, 50);
    near(p.shares, 50);
    near(p.pendingPremium, 5);
    near(p.premiumClaimable, 0);
    expect(p.epochs.map((e) => e.epoch)).toEqual([2]);
    const pf = portfolio([f], f.now);
    const kinds = pf.actions.map((a) => a.kind);
    expect(kinds).toContain("claim-deposit");
    expect(kinds).not.toContain("claim-premium");
  });

  test("an option holder: settled in the money, redeemable, with a redeem action", () => {
    const o = optionFixture();
    const { options, activity } = buildOptions([o.input], o.logs, ACCT, 9000);
    expect(options).toHaveLength(1);
    const x = options[0]!;
    expect(x.state).toBe("paid");
    near(x.redeemable, 20);
    near(x.redeemableUsd, 20);
    near(x.premiumPaid, 10);
    near(x.netUsd!, 10);
    near(x.breakEven!, 277.5);
    expect(activity[0]!.kind).toBe("option-bought");
    const pf = portfolio([], 9000, { option: o });
    const redeem = pf.actions.find((a) => a.kind === "redeem-option")!;
    expect(redeem).toMatchObject({ tx: true, seriesId: "7", amountRaw: "4000000000000000000" });
    near(pf.optionTotals.netSettledUsd, 10);
  });

  test("an agent operator: bond, slashes and roles", () => {
    const g = agentFixture();
    const [a] = buildAgents([g.input], g.logs, ACCT);
    expect(a!.roles).toEqual(["owner", "payout"]);
    expect(a!.slashes).toBe(1);
    near(a!.slashedUsdg, 10);
    near(a!.bondPosted, 60);
    expect(buildAgents([g.input], g.logs, "0x00000000000000000000000000000000000000dd")).toHaveLength(0);
  });

  test("nothing at all: the empty state", () => {
    const f = depositsFixture();
    const input = { ...f.input, live: { ...f.input.live, balance: 0n } };
    expect(replayVault(input, [], ACCT, f.now).position.touched).toBe(false);
    const pf = portfolio([{ ...f, logs: [], input }], f.now);
    expect(pf.empty).toBe(true);
    expect(pf.positions).toHaveLength(0);
    expect(pf.chart).toHaveLength(0);
  });

  test("what the wallet could do: this week's numbers on its size", () => {
    const holdings: HoldingInput[] = [
      {
        chainId: 46630,
        deployment: "46630-v3",
        version: "v3",
        asset: "USDG",
        amount: 125,
        usd: 125,
        vaults: [
          {
            vault: "0x0000000000000000000000000000000000000001",
            symbol: "sTSLA-CSP",
            isCall: false,
            underlying: "TSLA",
            state: 2,
            locked: true,
            spot: 105,
            totalAssets: 1000,
            mandate: { maxDeltaBps: 3500, maxShareSoldBps: 8000 },
            series: {
              id: "7",
              strike: 100,
              expiry: 20_000,
              size: 8,
              sold: 4,
              premium: 8,
              fairValue: 2.5,
              premiumBps: 8000,
              delta: 0.2,
              settled: false,
            },
          },
        ],
      },
    ];
    const [o] = opportunities(holdings, {}, 10_000);
    // 125 USDG is 1.25 puts at $100; the series sells 8 of the vault's 10 options (80%); buyers paid $2 each.
    expect(o).toMatchObject({ status: "selling", queued: true, strike: 100, maxDeltaBps: 3500 });
    near(o!.premiumPerOption!, 2);
    near(o!.options!, 1.25);
    near(o!.premiumIfSoldOut!, 2);
    near(o!.premiumAtSales!, 1);
    near(o!.breakEven!, 98);
  });

  test("the indexer's rows, feed prices and the model's odds", () => {
    const row = {
      chainId: 46630,
      deployment: "46630-v3",
      blockNumber: 12,
      blockTime: "2026-10-01T14:46:00.000Z",
      txHash: "0xabc",
      logIndex: 3,
      address: "0xABCDEF0000000000000000000000000000000001",
      source: "mirrorFeed",
      event: "AnswerUpdated",
      args: { current: "37045000000", roundId: "1", updatedAt: "1790000000" },
    };
    const p = fromIndexer(row, 46630, "46630-v3");
    expect(p).toMatchObject({ source: "feed", block: 12, time: Date.parse("2026-10-01T14:46:00Z") / 1000 });
    expect(p!.address).toBe("0xabcdef0000000000000000000000000000000001");
    expect(fromIndexer({ ...row, source: "decisionLog" }, 46630, "46630-v3")).toBeNull();
    const pts = [
      { t: 10, price: 1 },
      { t: 20, price: 2 },
    ];
    expect([priceAt(pts, 5), priceAt(pts, 10), priceAt(pts, 19), priceAt(pts, 99)]).toEqual([1, 1, 1, 2]);
    near(modelOddsBeyond(true, 100, 100, 0.0001, 86_400)!, 0.5, 2);
    expect(modelOddsBeyond(true, 100, 150, 0.6, 7 * 86_400)!).toBeLessThan(0.05);
    expect(modelOddsBeyond(false, 100, 150, 0.6, 7 * 86_400)!).toBeGreaterThan(0.95);
    expect(modelOddsBeyond(true, 100, 100, 0.6, 0)).toBeNull();
  });
});

/* ================================================================ the page, on fixtures */

async function mockApi(page: Page, body: PortfolioJson) {
  await page.route("**/api/portfolio?*", (route) => route.fulfill({ json: body }));
}

function fullFixture(): PortfolioJson {
  const d = depositsFixture();
  const c = callFixture({ expiry: 9000, now: 9500 });
  const q = queuedFixture();
  return portfolio([d, c, q], 9500, { option: optionFixture(), agent: agentFixture() });
}

test("without a wallet: says what it would show, offers a lookup and the examples", async ({ page }) => {
  await acknowledge(page);
  await page.goto("/app/portfolio?chain=46630");
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();
  await expect(page.getByTestId("portfolio-connect")).toContainText("Connect a wallet");
  await expect(page.getByTestId("page-purpose")).toContainText("across the vaults");
  await expect(page.getByTestId("portfolio-example")).toHaveCount(2);
  await expect(page.getByTestId("portfolio-lookup")).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("a malformed address in the lookup says so and loads nothing", async ({ page }) => {
  await acknowledge(page);
  await page.goto("/app/portfolio");
  await page.getByLabel("Address to view").fill("0x1234");
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByTestId("portfolio-lookup").getByRole("alert")).toContainText("not an address");
});

test("the dashboard on fixtures: figures, chart, positions, epochs, options, agent, actions", async ({
  page,
}, info) => {
  await acknowledge(page);
  await mockApi(page, fullFixture());
  await page.goto(`/app/portfolio?address=${QA1}`);
  await expect(page.getByTestId("portfolio")).toBeVisible();
  const figures = page.getByRole("region", { name: "Key figures" });
  await expect(figures).toContainText("Value now");
  await expect(figures).toContainText("Net P&L");
  await expect(figures).toContainText("Realised");
  await expect(page.getByTestId("portfolio-position")).toHaveCount(3);
  await expect(page.locator('[data-testid="portfolio-epoch"][data-status="expired-settling"]')).toHaveCount(
    1,
  );
  await expect(page.locator('[data-testid="portfolio-epoch"][data-status="settled"]')).toHaveCount(2);
  await expect(page.getByTestId("exposure-settling")).toContainText("Expired, settling");
  await expect(page.locator('[data-testid="portfolio-option"][data-state="paid"]')).toHaveCount(1);
  await expect(page.getByTestId("portfolio-agent")).toContainText("Agent #3");
  const actions = page.getByTestId("portfolio-action");
  await expect(actions.filter({ hasText: "Redeem 4 TSLA puts for 20 USDG" })).toHaveCount(1);
  await expect(actions.filter({ hasText: "Claim 50 shares" })).toHaveCount(1);
  await expect(actions.filter({ hasText: "waiting for its settlement price" })).toHaveCount(1);
  // Read-only: someone else's wallet gets no buttons.
  await expect(page.getByTestId("portfolio-actions")).toContainText("Connect this wallet to act");
  await expect(page.getByTestId("value-chart")).toBeVisible();
  await expect(page.getByTestId("epoch-bars")).toHaveAttribute("data-bars", "3");
  await page.getByRole("button", { name: "P&L", exact: true }).click();
  await expect(page.getByTestId("value-chart")).toContainText("P&L over time");
  await page.getByRole("button", { name: "1W", exact: true }).click();
  await expect(page.getByTestId("statement-csv")).toHaveAttribute(
    "href",
    `/api/statement?address=${ACCT}&format=csv`,
  );
  await expect(page.getByTestId("portfolio-reconciliation")).toContainText("3 of 3 positions");
  if (info.project.name === "mobile") {
    // The tables become labelled cards on phones.
    await expect(page.getByTestId("portfolio-position").first().locator("td").first()).toHaveAttribute(
      "data-label",
      "Shares",
    );
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("an empty wallet: what it would show, get started, and an example to open", async ({ page }) => {
  const f = depositsFixture();
  const input = { ...f.input, live: { ...f.input.live, balance: 0n } };
  await acknowledge(page);
  await mockApi(page, portfolio([{ ...f, logs: [], input }], f.now));
  await page.goto("/app/portfolio?address=0x00000000000000000000000000000000000000dd");
  const box = page.getByTestId("portfolio-empty");
  await expect(box).toContainText("Nothing in Strike for this wallet yet");
  await expect(box.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/app/faucet");
  await box.getByRole("button", { name: /Team QA test wallet 1/ }).click();
  await expect(page).toHaveURL(new RegExp(`address=${QA1}`));
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

/* ================================================================ the real API, a team QA wallet */

test("a team QA wallet on the live testnets: positions match balanceOf, the history checks out", async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name === "mobile", "one live read per run");
  const vault = JSON.parse(
    readFileSync(join(REPO, "contracts", "deployments", "46630-v3-vaults.json"), "utf8"),
  ).TSLA_cash_secured_put as Address;
  let shares: bigint;
  try {
    const client = createPublicClient({ transport: http(RPC) });
    shares = await client.readContract({
      address: vault,
      abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
      functionName: "balanceOf",
      args: [QA1],
    });
  } catch {
    test.skip(true, "Robinhood Chain testnet RPC unreachable");
    return;
  }
  const res = await request.get(`/api/portfolio?address=${QA1}`, { timeout: 120_000 });
  test.skip(res.status() === 502, "the server could not read the testnets");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as PortfolioJson;
  expect(body.chains.map((c) => c.key).sort()).toEqual(["421614-v3", "46630-v2", "46630-v3"]);
  const p = body.positions.find((x) => x.vault === vault.toLowerCase() && x.deployment === "46630-v3");
  expect(p, "QA wallet 1's v3 put vault position").toBeTruthy();
  expect(p!.shares).toBeCloseTo(Number(shares) / 1e6, 6);
  expect(p!.check.ok).toBe(true);
  expect(body.activity.some((a) => a.tx === QA1_DEPOSIT_TX && a.kind === "deposit")).toBe(true);

  const csv = await request.get(`/api/statement?address=${QA1}&format=csv`, { timeout: 120_000 });
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect(await csv.text()).toContain(QA1_DEPOSIT_TX);
  const bad = await request.get("/api/portfolio?address=0x12");
  expect(bad.status()).toBe(400);

  await acknowledge(page);
  await page.goto(`/app/portfolio?address=${QA1}`);
  await expect(page.getByTestId("portfolio")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("team-wallet")).toContainText("Team test wallet");
  await expect(page.locator(`[data-testid="portfolio-position"] a[href^="/app/vault/${vault}"]`)).toHaveCount(
    1,
  );
});
