import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { GovernanceJson } from "../src/lib/governance";
import { acknowledge, horizontalOverflow } from "./helpers";

// /app/governance: who holds each privileged role, what each role can do, the last admin actions and the staged path.
// The page tests answer /api/governance from fixtures recorded from the live route on 3 October (one copy edited to
// carry an unknown holder). The last test calls the built route, which reads the chains (skipped when unreachable).
// The pure logic (holders from logs, labels, the cache) is in units.spec.ts.

const fixture = (chainId: number) =>
  JSON.parse(
    readFileSync(join(__dirname, "fixtures", "governance", `${chainId}.json`), "utf8"),
  ) as GovernanceJson;

const STRANGER = "0x000000000000000000000000000000000000dEaD";

/** The 46630 fixture with an address nobody can name added to v2's FeeManager DEPOSITOR_ROLE. */
function withUnknown(): GovernanceJson {
  const g = fixture(46630);
  const dep = g.deployments[0]!;
  const fee = dep.contracts.find((c) => c.name === "FeeManager")!;
  fee.roles
    .find((r) => r.role === "DEPOSITOR_ROLE")!
    .holders.push({
      address: STRANGER,
      label: "Unknown holder",
      kind: "unknown",
      grantTx: `0x${"ab".repeat(32)}`,
      grantBlock: 128_000_000,
    });
  dep.unknown.push({
    contractName: "FeeManager",
    address: fee.address,
    role: "DEPOSITOR_ROLE",
    holder: STRANGER,
  });
  return g;
}

async function serve(page: Page, body: (chainId: number) => GovernanceJson = fixture) {
  await page.route("**/api/governance?**", (route) => {
    const chain = Number(new URL(route.request().url()).searchParams.get("chain"));
    return route.fulfill({ json: body(chain) });
  });
}

const row = (page: Page, contract: string, role: string) =>
  page.locator(`[data-testid="gov-role-row"][data-contract="${contract}"][data-role="${role}"]`);

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test("governance: every role of the v2 contracts with its confirmed holders, labelled", async ({ page }) => {
  await serve(page);
  await page.goto("/app/governance");
  await expect(page.getByRole("heading", { level: 1, name: /admin keys/i })).toBeVisible();
  await expect(page).toHaveTitle(/Governance/);
  const holders = page.getByTestId("gov-holders");
  await expect(holders).toHaveAttribute("data-deployment", "46630-v2");

  // 13 contracts: 7 core, 5 MirrorFeeds, the UsdgDrip; 24 role rows.
  await expect(page.getByTestId("gov-role-row")).toHaveCount(24);
  const admin = row(page, "EpochManager", "DEFAULT_ADMIN_ROLE");
  await expect(admin.getByTestId("gov-holder")).toHaveCount(1);
  await expect(admin.getByTestId("gov-holder")).toContainText("Deployer");
  await expect(admin.getByTestId("gov-holder")).toHaveAttribute("data-kind", "deployer");
  await expect(admin.getByRole("link", { name: /block 125,880,728/ })).toHaveAttribute(
    "href",
    /^https:\/\/explorer\.testnet\.chain\.robinhood\.com\/tx\/0x/,
  );
  // Contracts hold the wiring roles; the CI keeper key holds KEEPER_ROLE on the mirrored feeds only.
  await expect(row(page, "EpochManager", "FACTORY_ROLE")).toContainText("VaultFactory v2");
  await expect(row(page, "AgentRegistry", "SLASHER_ROLE")).toContainText("EpochManager v2");
  const tsla = row(page, "TSLA MirrorFeed", "KEEPER_ROLE").getByTestId("gov-holder");
  await expect(tsla).toHaveCount(2);
  await expect(tsla.filter({ hasText: "CI keeper key" })).toHaveAttribute("data-kind", "keeper");
  await expect(row(page, "NFLX MirrorFeed", "KEEPER_ROLE")).not.toContainText("CI keeper key");
  await expect(row(page, "EpochManager", "KEEPER_ROLE")).not.toContainText("CI keeper key");
  await expect(row(page, "UsdgDrip", "owner")).toContainText("Deployer");
  await expect(row(page, "MarketCalendar", "CALENDAR_ROLE")).toContainText("also v3");

  // No stranger anywhere.
  await expect(page.getByTestId("gov-all-known")).toBeVisible();
  await expect(page.getByTestId("gov-unknown")).toHaveCount(0);
  await expect(page.locator('[data-testid="gov-holder"][data-kind="unknown"]')).toHaveCount(0);

  // Arbitrum Sepolia: its own contracts, with the two TestStockTokens the deployer can mint.
  await page.getByRole("button", { name: "Arbitrum Sepolia v3" }).click();
  await expect(holders).toHaveAttribute("data-deployment", "421614-v3");
  await expect(row(page, "TSLA TestStockToken", "DEFAULT_ADMIN_ROLE")).toContainText("Deployer");
  await expect(row(page, "EpochManager", "FACTORY_ROLE")).toContainText("VaultFactory v3");
  await expect(
    row(page, "EpochManager", "DEFAULT_ADMIN_ROLE").getByRole("link", { name: /0xB8Ed/ }),
  ).toHaveAttribute("href", /^https:\/\/sepolia\.arbiscan\.io\/address\//);
});

test("governance: an unknown holder is flagged above the table and on its row", async ({ page }) => {
  await serve(page, (c) => (c === 46630 ? withUnknown() : fixture(c)));
  await page.goto("/app/governance");
  const warn = page.getByTestId("gov-unknown");
  await expect(warn).toBeVisible();
  await expect(warn).toContainText("1 unknown holder");
  await expect(warn).toContainText("46630-v2 · FeeManager · DEPOSITOR_ROLE");
  await expect(page.getByTestId("gov-all-known")).toHaveCount(0);
  const r = row(page, "FeeManager", "DEPOSITOR_ROLE");
  await expect(r).toHaveAttribute("data-unknown", "true");
  const stranger = r.locator('[data-testid="gov-holder"][data-kind="unknown"]');
  await expect(stranger).toContainText("Unknown holder");
  await expect(stranger.getByRole("link")).toHaveAttribute("href", new RegExp(`/address/${STRANGER}$`));
  await expect(page.getByRole("region", { name: "Key figures" })).toContainText(/Unknown holders\s*1/);
});

test("governance: what each role can and cannot do, from the roles table and the trust model", async ({
  page,
}) => {
  await serve(page);
  await page.goto("/app/governance#roles");
  const guardian = page.locator(
    '[data-testid="gov-role-info"][data-kind="EpochManager"][data-role="GUARDIAN_ROLE"]',
  );
  await expect(guardian).toContainText("Pause new epochs, proposals and buys");
  await expect(guardian).toContainText("Block settlement or idle withdrawals; take funds.");
  await expect(guardian.getByRole("link")).toHaveAttribute(
    "href",
    /docs\/audit-readiness\.md#roles-and-trust$/,
  );
  const oracle = page.locator('[data-testid="gov-role-info"][data-kind="StockOracle"]');
  await expect(oracle).toContainText("pointing the token at another feed (setFeed)");
});

test("governance: the last admin actions, newest first, with sender and transaction", async ({ page }) => {
  await serve(page);
  await page.goto("/app/governance#actions");
  const actions = page.getByTestId("gov-action");
  await expect(actions).toHaveCount(15);
  await expect(actions.first()).toContainText("Granted KEEPER_ROLE to CI keeper key");
  await expect(actions.first()).toContainText("Deployer");
  await expect(actions.first()).toContainText("2026-10-02 21:01 UTC");
  await expect(actions.first().getByRole("link")).toHaveAttribute(
    "href",
    "https://explorer.testnet.chain.robinhood.com/tx/0xdbae1bb9ba98081da3547e590a65e43a836da0ed99e3739b476f89b3857e3603",
  );
  await expect(page.locator('[data-testid="gov-action"][data-event="PricerSet"]').first()).toContainText(
    "Pricer set to Stylus pricer v2",
  );
});

test("governance: the staged path marks stage 0 as current and links each commitment's tests", async ({
  page,
}) => {
  await serve(page);
  await page.goto("/app/governance#staged");
  const stages = page.getByTestId("gov-stage");
  await expect(stages).toHaveCount(3);
  await expect(stages.nth(0)).toHaveAttribute("data-current", "true");
  await expect(stages.nth(0).getByTestId("gov-stage-current")).toHaveText("Current");
  await expect(stages.nth(1)).not.toHaveAttribute("data-current", /.*/);
  await expect(stages.nth(2)).not.toHaveAttribute("data-current", /.*/);
  await expect(page.getByTestId("gov-stage-current")).toHaveCount(1);
  await expect(stages.nth(1)).toContainText("73-day timelock");
  const bypass = stages.nth(1).getByRole("link", { name: "test_nobodyBypassesTheTimelock" });
  await expect(bypass).toHaveAttribute(
    "href",
    "https://github.com/Prashant-thakur77/Strike/blob/main/contracts/test/governance/AdminTimelock.t.sol#L126",
  );
  await expect(
    stages.nth(2).getByRole("link", { name: "test_stage2_renouncingTheOracleAndManagerAdminEndsTheGap" }),
  ).toBeVisible();
});

test("governance: a chain that cannot be read says so and offers a retry", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  await page.route("**/api/governance?**", (route) =>
    route.fulfill({ status: 502, json: { error: "Could not read the roles: rpc down" } }),
  );
  await page.goto("/app/governance");
  const err = page.getByTestId("gov-error");
  await expect(err).toContainText("rpc down", { timeout: 30_000 });
  await expect(err.getByRole("button", { name: /try again/i })).toBeVisible();
});

test("governance: 360px, each role is a card and nothing scrolls sideways", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile", "phone widths: the mobile project");
  await serve(page, (c) => (c === 46630 ? withUnknown() : fixture(c)));
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto("/app/governance");
  await expect(page.getByTestId("gov-holders")).toBeVisible();
  const cells = await page
    .getByRole("table", { name: "Role holders, 46630-v2" })
    .locator("tbody td")
    .evaluateAll((tds) =>
      tds.map((td) => ({ label: td.getAttribute("data-label"), right: td.getBoundingClientRect().right })),
    );
  expect(cells.length).toBeGreaterThan(20);
  for (const c of cells) {
    expect(c.label).toMatch(/^(Role|Holder|Granted in)$/);
    expect(c.right).toBeLessThanOrEqual(360);
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("proof: the security section links the governance page", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  await page.goto("/app/proof#security");
  await expect(page.getByTestId("proof-governance-link")).toHaveAttribute("href", "/app/governance");
});

/* ------------------------------------------------------------------ the built route, live */

async function rpcUp(url: string, chainId: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    return Number(((await res.json()) as { result?: string }).result) === chainId;
  } catch {
    return false;
  }
}

test("GET /api/governance: 400 for another chain; live holders for all three deployments", async ({
  request,
}) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  const bad = await request.get("/api/governance?chain=4663");
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatch(/46630 or 421614/);

  const chains = [
    { id: 46630, rpc: "https://rpc.testnet.chain.robinhood.com", keys: ["46630-v2", "46630-v3"] },
    { id: 421614, rpc: "https://sepolia-rollup.arbitrum.io/rpc", keys: ["421614-v3"] },
  ];
  for (const c of chains) {
    test.skip(!(await rpcUp(c.rpc, c.id)), `chain ${c.id} RPC unreachable`);
    const res = await request.get(`/api/governance?chain=${c.id}`, { timeout: 90_000 });
    test.skip(res.status() === 502, `the route could not read chain ${c.id}: ${(await res.json()).error}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toMatch(/s-maxage=(600|60)\b/);
    const g = (await res.json()) as GovernanceJson;
    expect(g.chainId).toBe(c.id);
    expect(g.deployments.map((d) => d.key)).toEqual(c.keys);
    for (const d of g.deployments) {
      const role = (contract: string, r: string) =>
        d.contracts.find((x) => x.name === contract)!.roles.find((x) => x.role === r)!;
      // Every core contract has an admin, and the wiring roles sit with this deployment's own contracts.
      for (const name of [
        "EpochManager",
        "StockOracle",
        "AgentRegistry",
        "FeeManager",
        "OptionToken",
        "VaultFactory",
      ]) {
        expect(role(name, "DEFAULT_ADMIN_ROLE").holders.length, `${d.key} ${name}`).toBeGreaterThan(0);
      }
      const factory = d.contracts.find((x) => x.name === "VaultFactory")!.address.toLowerCase();
      expect(role("EpochManager", "FACTORY_ROLE").holders.map((h) => h.address.toLowerCase())).toContain(
        factory,
      );
      expect(role("AgentRegistry", "SLASHER_ROLE").holders.map((h) => h.kind)).toContain("contract");
      // Each holder is labelled, and the unknown list is exactly the holders the label book cannot name.
      const holders = d.contracts.flatMap((x) => x.roles.flatMap((r) => r.holders));
      for (const h of holders) expect(h.label.length).toBeGreaterThan(0);
      expect(d.unknown.length).toBe(holders.filter((h) => h.kind === "unknown").length);
      expect(d.warnings).toEqual([]);
      expect(d.actions.length).toBeGreaterThan(0);
      expect(d.head).toBeGreaterThan(d.deployBlock);
    }
  }
});
