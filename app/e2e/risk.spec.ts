import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { acknowledge, horizontalOverflow, settle } from "./helpers";

// The Risk panel on the live TSLA covered-call vaults: v2 on Robinhood Chain testnet (46630), where the SDK calls the
// v3 Stylus risk engine directly, and v3 on Arbitrum Sepolia (421614), where it reads RiskLens. The footnote must say
// which contracts computed the numbers, on which chain, and which version the series belongs to. Each case skips when
// its RPC is unreachable. Set RISK_SHOTS=<dir> to save the panel as <project>-vault-risk.png (46630) and
// <project>-vault-arbitrum-sepolia-risk.png (421614).

interface Case {
  chainId: number;
  chain: string;
  rpc: string;
  vault: string;
  engine: string;
  lens: string | null;
  epochManager: string;
  version: "v2" | "v3";
  shot: string;
}

const CASES: Case[] = [
  {
    chainId: 46630,
    chain: "Robinhood Chain testnet",
    rpc: process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com",
    vault: "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e",
    engine: "0x61158d98c6c2b7ccb22755a098d0da2bbcf2a4ec",
    lens: null,
    epochManager: "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99",
    version: "v2",
    shot: "vault-risk",
  },
  {
    chainId: 421614,
    chain: "Arbitrum Sepolia",
    rpc: process.env.E2E_ARB_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc",
    vault: "0x5655659E18bf54ee0EF8f6A816E2e18D000F7311",
    engine: "0x57cfa61b190c1e80d6e8b1549b8acf1bc505a531",
    lens: "0x94aC10fF1A71ceBfD825079aaf897858a9953ecE",
    epochManager: "0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0",
    version: "v3",
    shot: "vault-arbitrum-sepolia-risk",
  },
];

async function rpcUp(rpc: string, chainId: number): Promise<boolean> {
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { result?: string };
    return json.result !== undefined && Number(json.result) === chainId;
  } catch {
    return false;
  }
}

for (const c of CASES) {
  test(`vault risk panel on ${c.chain}: live greeks, stress test and where they came from (${c.version})`, async ({
    page,
  }, info) => {
    test.skip(!(await rpcUp(c.rpc, c.chainId)), `${c.chain} RPC unreachable`);
    await acknowledge(page);
    await page.goto(`/app/vault/${c.vault}?chain=${c.chainId}`);
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

    // Which contracts computed it, on which chain, for which version: derived, not a fixed sentence.
    const foot = panel.getByTestId("risk-source");
    await expect(foot).toHaveAttribute("data-chain", String(c.chainId));
    await expect(foot).toHaveAttribute("data-version", c.version);
    await expect(foot).toContainText(`Computed live on ${c.chain}`);
    await expect(foot).toContainText(`A ${c.version} series`);
    await expect(foot).not.toContainText(c.version === "v2" ? "A v3 series" : "A v2 series");
    await expect(foot.locator(`a[href$="/address/${c.engine}" i]`)).toBeVisible();
    await expect(foot.locator(`a[href$="/address/${c.epochManager}" i]`)).toBeVisible();
    await expect(foot).toContainText("Stylus (Rust) risk engine");
    if (c.lens) {
      await expect(foot).toHaveAttribute("data-source", "riskLens");
      await expect(foot).toContainText("through RiskLens (v3)");
      await expect(foot.locator(`a[href$="/address/${c.lens}" i]`)).toBeVisible();
    } else {
      await expect(foot).toHaveAttribute("data-source", "riskEngine");
      await expect(foot).toContainText("called directly");
      await expect(foot).not.toContainText("RiskLens (v3) at");
    }

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    const dir = process.env.RISK_SHOTS;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      await settle(page, 800);
      // A clip of the full page, so the sticky navigation does not cover the top of the rail.
      const box = (await rail.boundingBox())!;
      const scrollY = await page.evaluate(() => window.scrollY);
      await page.screenshot({
        path: join(dir, `${info.project.name}-${c.shot}.png`),
        fullPage: true,
        clip: { x: 0, y: box.y + scrollY - 16, width: page.viewportSize()!.width, height: box.height + 32 },
      });
    }
  });
}
