import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { acknowledge, horizontalOverflow, settle } from "./helpers";

// The Risk panel on the live TSLA covered-call vault (Robinhood Chain testnet, 46630): greeks, the stress test and
// the footnote come from the v3 Stylus risk engine. Skips when the testnet RPC is unreachable. Set RISK_SHOTS=<dir>
// to save the panel as desktop-vault-risk.png / mobile-vault-risk.png.

const TESTNET_RPC = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";
const VAULT = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e";
const ENGINE = "0x61158d98c6c2b7ccb22755a098d0da2bbcf2a4ec";

async function testnetUp(): Promise<boolean> {
  try {
    const res = await fetch(TESTNET_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: string };
    return json.result !== undefined && Number(json.result) === 46630;
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await testnetUp()), "Robinhood Chain testnet RPC unreachable");
  await acknowledge(page);
});

test("vault risk panel: live greeks and stress test from the Stylus risk engine", async ({ page }, info) => {
  await page.goto(`/app/vault/${VAULT}?chain=46630`);
  const rail = page.locator("section#risk");
  await expect(rail).toBeVisible({ timeout: 60_000 });
  await rail.scrollIntoViewIfNeeded();

  const noSeries = rail.getByText("No live series.");
  const panel = rail.getByTestId("risk-panel");
  await expect(panel.or(noSeries)).toBeVisible({ timeout: 60_000 });
  test.skip(await noSeries.isVisible(), "the vault has no live series (between epochs)");

  // Four greeks with a number and a plain-words line each.
  for (const [greek, line] of [
    ["delta", /the vault loses about \$\d+\.\d{2} for every \$1 TSLA (rises|falls)/i],
    ["gamma", /losses speed up/i],
    ["vega", /volatility point/i],
    ["theta", /time decay earns the vault about \$\d+\.\d{2} a day/i],
  ] as const) {
    const cell = panel.locator(`[data-greek="${greek}"]`);
    await expect(cell).toContainText(/[−+]?\d+\.\d{2}/);
    await expect(cell).toContainText(line);
  }

  // The stress-test chart and its table twin, with the worst case and the collateral stated.
  const figure = panel.getByRole("figure");
  await expect(figure.locator("svg")).toBeVisible();
  await expect(figure).toContainText(/Worst case on this grid|No move on this grid/);
  await expect(figure).toContainText(/TSLA locked/);
  await panel.getByRole("button", { name: "Table" }).click();
  const rows = panel.getByTestId("risk-table").locator("tbody tr");
  await expect(rows).toHaveCount(13);
  await expect(rows.first()).toContainText("−30%");
  await expect(rows.last()).toContainText("+30%");
  await panel.getByRole("button", { name: "Chart" }).click();

  // Which contract computed it.
  const foot = panel.getByText(/Computed live by the Stylus \(Rust\) risk engine/);
  await expect(foot).toContainText("v3 risk engine reading a v2 series");
  await expect(panel.locator(`a[href$="/address/${ENGINE}" i]`)).toBeVisible();

  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  const dir = process.env.RISK_SHOTS;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await settle(page, 800);
    await rail.screenshot({ path: join(dir, `${info.project.name}-vault-risk.png`) });
  }
});
