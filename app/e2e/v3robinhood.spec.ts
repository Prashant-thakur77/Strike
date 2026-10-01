import { expect, test } from "@playwright/test";
import { acknowledge, horizontalOverflow } from "./helpers";

// v3 next to v2 on Robinhood Chain testnet (46630). The SDK lists both deployments (`deploymentsFor`): the vault list
// shows the v3 vaults with a version tag next to v2's, the v3 covered-call vault page reads everything through its
// own EpochManager (found from the vault's `manager()`): this week's series ($369.36, the Claude-planned epoch of
// 1 October), the risk panel through v3's RiskLens and "Why this strike" with the record anchored in v3's
// DecisionLog. The agents page lists agent #1 of both registries, labelled by version. Skips when the RPC is down.

const RPC = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";
const V3_CALL = "0x478E7BC3C3aB07fdd104e4765F178977adEe6285";
const V3_PUT = "0x1bc73c1B28F520E57982FAe6127477190FA53690";
const V2_CALL = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e";
const V2_PUT = "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7";
const A2_PUT = "0x8aEb1e0aC30Ff7829609954688B2aC649Ef26969";
const V3_EM = "0x256D4546486368dCb23E94758b4cb500c215929F";
const V3_LENS = "0xFDb8Ba33f4aAF1A699f1D5877E8ee5b6eDeDCc6D";

async function rpcUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: string };
    return Number(json.result) === 46630;
  } catch {
    return false;
  }
}

test.beforeEach(async () => {
  test.skip(!(await rpcUp()), "Robinhood Chain testnet RPC unreachable");
});

test("the vault list shows v3 and v2 vaults on Robinhood Chain testnet, tagged by version", async ({
  page,
}) => {
  await acknowledge(page);
  await page.goto("/app?chain=46630");
  const list = page.locator("#vault-list");
  const v3 = list.locator(`a[href="/app/vault/${V3_CALL}"]`);
  await expect(v3).toBeVisible({ timeout: 60_000 });
  await expect(v3).toHaveAttribute("data-version", "v3");
  await expect(v3.locator("[data-version='v3']")).toHaveText("v3");
  await expect(list.locator(`a[href="/app/vault/${V3_PUT}"]`)).toHaveAttribute("data-version", "v3");
  await expect(list.locator(`a[href="/app/vault/${V2_CALL}"]`)).toHaveAttribute("data-version", "v2");
  // One group per deployment, newest first, the default one named.
  const groups = list.locator("[data-version] > p");
  await expect(list.locator("> [data-version]")).toHaveCount(2);
  await expect(list.locator("> [data-version]").first()).toHaveAttribute("data-version", "v3");
  await expect(groups.last()).toContainText("the network's default deployment");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("each vault row names its symbol, agent and mandate, so two TSLA put vaults read apart", async ({
  page,
}) => {
  await acknowledge(page);
  await page.goto("/app?chain=46630");
  const list = page.locator("#vault-list");
  const a1 = list.locator(`a[href="/app/vault/${V2_PUT}"]`);
  const a2 = list.locator(`a[href="/app/vault/${A2_PUT}"]`);
  await expect(a1).toBeVisible({ timeout: 60_000 });
  await expect(a1.getByTestId("vault-row-meta")).toContainText("sTSLA-CSP · agent #1");
  await expect(a1).toHaveAttribute("aria-label", /sTSLA-CSP, agent #1 \(v2\)/);
  // Agent #2's put vault, created from the app's "Run your own agent" form with a tighter mandate.
  await expect(a2.getByTestId("vault-row-meta")).toContainText("sTSLA-CSP-A2 · agent #2");
  await expect(a2.getByTestId("vault-row-mandate")).toHaveText(
    "Mandate: delta 0.10–0.25 · premium ≥ 100% of fair · sells ≤ 50%",
  );
  await expect(list.locator(`a[href="/app/vault/${V3_PUT}"]`).getByTestId("vault-row-meta")).toContainText(
    "sTSLA-CSP · agent #1",
  );
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("the v3 covered-call vault page reads its own deployment: series, risk via RiskLens, why this strike", async ({
  page,
}) => {
  await acknowledge(page);
  await page.goto(`/app/vault/${V3_CALL}?chain=46630`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA", { timeout: 60_000 });
  await expect(page.getByText("There is no Strike vault at this address")).toHaveCount(0);
  await expect(page.locator("[data-version='v3']").first()).toBeVisible();

  // This week's option: the Claude-planned $369.36 call (or, once settled, the vault between epochs).
  const series = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "This week's option" }) });
  await expect(series).toBeVisible();
  const strike = series.getByText("$369.36").first();
  const between = series.getByText(/^(Waiting for the agent|No option on sale)\.$/).first();
  await expect(strike.or(between).first()).toBeVisible({ timeout: 60_000 });
  const live = await strike.isVisible();

  // Risk: through v3's RiskLens, bound to the vault's v3 EpochManager.
  const risk = page.locator("section#risk");
  await risk.scrollIntoViewIfNeeded();
  if (live) {
    const foot = risk.getByTestId("risk-source");
    await expect(foot).toBeVisible({ timeout: 60_000 });
    await expect(foot).toHaveAttribute("data-version", "v3");
    await expect(foot).toHaveAttribute("data-source", "riskLens");
    await expect(foot.locator(`a[href$="/address/${V3_LENS}" i]`)).toBeVisible();
    await expect(foot.locator(`a[href$="/address/${V3_EM}" i]`)).toBeVisible();
  }

  // Why this strike: Claude's record of 1 October, checked against its anchoring tx in v3's DecisionLog.
  const why = page.locator("section#why");
  await why.scrollIntoViewIfNeeded();
  const panel = why.getByTestId("why-panel");
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByTestId("why-planner")).toContainText(/Claude via (Claude Code CLI|API)/);
  await expect(panel.getByTestId("why-anchor-status")).toHaveText("hash matches");
  await expect(panel.getByTestId("why-anchor-via")).toContainText("anchored in tx 0x00e2");
  await expect(panel.getByTestId("why-anchor")).toContainText("v3 DecisionLog on Robinhood Chain testnet");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("the agents page lists agent #1 of both registries, labelled by version", async ({ page }) => {
  await acknowledge(page);
  await page.goto("/app/agents?chain=46630");
  const board = page.locator("table");
  await expect(board.getByText("v3 registry").first()).toBeVisible({ timeout: 60_000 });
  await expect(board.getByText("v2 registry").first()).toBeVisible();
  await expect(board.getByRole("button", { name: /about agent 1 \(v3 registry\)/ })).toHaveCount(1);
  await expect(board.getByRole("button", { name: /about agent 1 \(v2 registry\)/ })).toHaveCount(1);
  await expect(page.getByText(/registers with the v2 contracts, the network's default/)).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
