import { expect, test } from "@playwright/test";
import { acknowledge, horizontalOverflow } from "./helpers";

// App pages against the live Robinhood Chain testnet deployment (skipped when its RPC is unreachable), plus the
// page-numbering rule, which needs no chain.

const RPC = process.env.E2E_RPC_46630 ?? "https://rpc.testnet.chain.robinhood.com";
const CALL_VAULT = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

async function testnetUp(): Promise<boolean> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: string };
    return json.result === "0xb626";
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test("page heroes are numbered once each, in nav order", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  const routes = [
    ["/app?chain=46630", "01"],
    ["/app/playground", "02"],
    ["/app/backtest", "03"],
    ["/app/agents?chain=46630", "04"],
    ["/app/monitor", "05"],
    ["/app/proof", "06"],
    ["/app/faucet?chain=46630", "07"],
  ] as const;
  for (const [path, index] of routes) {
    await page.goto(path);
    await expect(page.locator("#main header .index").first(), path).toHaveText(index);
  }
});

test.describe("on Robinhood Chain testnet", () => {
  test.beforeEach(async () => {
    test.skip(!(await testnetUp()), `Robinhood Chain testnet RPC unreachable (${RPC})`);
  });

  test("vault list names each strategy and explains a missing APY", async ({ page }) => {
    await page.goto("/app?chain=46630");
    const rows = page.locator('a[href^="/app/vault/"]');
    await expect(rows.first()).toBeVisible({ timeout: 45_000 });
    await expect(page.getByText("Covered call", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Cash-secured put", { exact: true }).first()).toBeVisible();
    // Until an epoch settles there is no trailing APY: say when there will be one, not "—".
    const apy = rows.first().locator('[data-label="Premium APY"]');
    await expect(apy).not.toContainText("—");
    await expect(apy).toContainText(/after the first settlement|%/i);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("vault detail draws the payoff at expiry and explains the price", async ({ page }) => {
    await page.goto(`/app/vault/${CALL_VAULT}?chain=46630`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA", { timeout: 45_000 });
    const chart = page.getByRole("img", { name: "Result at expiry, per option" });
    test.skip((await page.getByText("No option on sale.").count()) > 0, "no live series right now");
    await expect(chart).toBeVisible({ timeout: 45_000 });
    await expect(chart.locator("text", { hasText: /^Strike \$[\d,.]+$/ })).toHaveCount(1);
    await expect(chart.locator("text", { hasText: /^(Breakeven|B\/E) \$[\d,.]+$/ })).toHaveCount(1);
    await expect(chart.locator("text", { hasText: /^Spot now \$[\d,.]+$/ })).toHaveCount(1);
    await expect(chart.locator("text", { hasText: "price at expiry (USD)" })).toHaveCount(1);
    // The text summary carries the same content for screen readers and a table view exists.
    await expect(page.locator("figcaption")).toContainText(/breakeven/);
    await expect(page.getByText("Show as a table")).toBeAttached();

    const price = page.getByRole("region", { name: "How the buy price is set" });
    await expect(price).toContainText("Priced spot");
    await expect(price).toContainText(/\+ 0\.5%, against the buyer/);
    await expect(price).toContainText(/never below intrinsic value|raised to intrinsic value/);
    await expect(price).toContainText(/Live quote\s*\$[\d,.]+/, { timeout: 45_000 });

    // The first epoch's Idle step says what it was, not "—".
    await expect(page.getByText("First deposits, before epoch 1")).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("an address that is not a vault says so in the heading", async ({ page }) => {
    await page.goto(`/app/vault/0x000000000000000000000000000000000000dEaD?chain=46630`);
    const alert = page.locator("#main").getByRole("alert");
    await expect(alert.getByRole("heading", { name: "No Strike vault at this address." })).toBeVisible({
      timeout: 45_000,
    });
    await expect(alert).not.toContainText("Couldn't read this from the chain");
  });

  test("agents show the ERC-8004 identity and reputation", async ({ page }) => {
    await page.goto("/app/agents?chain=46630");
    const chip = page.getByRole("link", { name: /ERC-8004 #114/ });
    await expect(chip).toBeVisible({ timeout: 45_000 });
    await expect(chip).toHaveAttribute(
      "href",
      `https://explorer.testnet.chain.robinhood.com/token/${IDENTITY_REGISTRY}/instance/114`,
    );
    // The top agent's row starts open; the toggle closes and reopens it.
    const toggle = page.getByRole("button", { name: /about agent 1/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("link", { name: /Registration file/ })).toHaveAttribute(
      "href",
      /docs\/agents\/strike-agent-1\.json$/,
    );
    await expect(page.getByRole("link", { name: /Reputation registry/ })).toHaveAttribute(
      "href",
      new RegExp(`/address/${REPUTATION_REGISTRY}$`),
    );
    await expect(page.getByText(/\d+ feedback posts?/)).toBeVisible();
    await expect(page.getByText(/No settled epochs yet|USDG/).first()).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("link", { name: /Registration file/ })).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
