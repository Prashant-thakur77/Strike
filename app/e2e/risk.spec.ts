import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Address } from "viem";
import { acknowledge, horizontalOverflow, settle } from "./helpers";
import {
  PHASE_SELECTORS,
  SPOT,
  feedStatus,
  lastPrint,
  livePhase,
  patchEthCalls,
  spotWhenReverted,
  vaultPhase,
  type LivePhase,
} from "./lifecycle";

// The Risk panel on the live TSLA covered-call vaults, in whatever state the week is in (live), and in each state on
// demand (fixtures): v2 on Robinhood Chain testnet (46630), where the SDK calls the
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
  {
    // v3 next to v2 on Robinhood Chain testnet: read through the vault's own deployment (v3's RiskLens).
    chainId: 46630,
    chain: "Robinhood Chain testnet",
    rpc: process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com",
    vault: "0x478E7BC3C3aB07fdd104e4765F178977adEe6285",
    engine: "0x61158d98c6c2b7ccb22755a098d0da2bbcf2a4ec",
    lens: "0xFDb8Ba33f4aAF1A699f1D5877E8ee5b6eDeDCc6D",
    epochManager: "0x256D4546486368dCb23E94758b4cb500c215929F",
    version: "v3",
    shot: "vault-robinhood-v3-risk",
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

/** Four greeks with a number and a plain-words line each (a series before expiry). */
async function expectGreeks(panel: Locator) {
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
  await expect(panel.getByTestId("risk-expired")).toHaveCount(0);
}

/** Past expiry: no greeks (no time value is left), and why, in place of four zeros. */
async function expectExpired(panel: Locator) {
  await expect(panel).toHaveAttribute("data-expired", "true");
  await expect(panel.getByTestId("risk-expired")).toContainText("No greeks after expiry.");
  await expect(panel.getByTestId("risk-expired")).toContainText("the first print at or after expiry");
  await expect(panel.locator("[data-greek]")).toHaveCount(0);
  await expect(panel).toContainText(
    /Depositors' side, at expiry.*expired \w{3} \d{1,2} \w{3}, \d{2}:\d{2} UTC/,
  );
}

/** The stress test (chart and table) and the footnote naming the contracts, chain and version. */
async function expectStressAndSource(panel: Locator, c: Case, expired: boolean) {
  const figure = panel.getByRole("figure");
  await expect(figure.locator("svg")).toBeVisible();
  await expect(figure).toContainText(
    expired
      ? "Vault result at settlement by TSLA move from the last print"
      : "Vault result at expiry by TSLA move",
  );
  await expect(figure).toContainText(/Worst case on this grid|No move on this grid/);
  await expect(figure).toContainText(/TSLA locked/);
  await panel.getByRole("button", { name: "Table" }).click();
  const rows = panel.getByTestId("risk-table").locator("tbody tr");
  await expect(rows).toHaveCount(13);
  await expect(rows.first()).toContainText("−30%");
  await expect(rows.last()).toContainText("+30%");
  await expect(rows.nth(6)).toContainText(expired ? "last print" : "now");
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
}

/** The risk rail in `phase`: greeks while selling, the expired note after expiry, "No live series." otherwise. */
async function expectRiskPhase(page: Page, c: Case, phase: LivePhase) {
  const rail = page.locator("section#risk");
  await expect(rail).toBeVisible({ timeout: 60_000 });
  await rail.scrollIntoViewIfNeeded();
  const panel = rail.getByTestId("risk-panel");
  if (phase === "settled" || phase === "open") {
    await expect(rail.getByText("No live series.")).toBeVisible({ timeout: 60_000 });
    await expect(panel).toHaveCount(0);
  } else {
    await expect(panel).toBeVisible({ timeout: 60_000 });
    if (phase === "selling") await expectGreeks(panel);
    else await expectExpired(panel);
    await expectStressAndSource(panel, c, phase === "expired");
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
}

for (const c of CASES) {
  test(`vault risk panel on ${c.chain}, in the state the series is in now: greeks or why there are none, stress test, sources (${c.version}, ${c.shot})`, async ({
    page,
  }, info) => {
    test.skip(!(await rpcUp(c.rpc, c.chainId)), `${c.chain} RPC unreachable`);
    const phase = await livePhase(c.rpc, c.epochManager as Address, c.vault as Address);
    info.annotations.push({ type: "phase", description: phase });
    await acknowledge(page);
    // "Risk" is folded under "Details for experts"; a link to #risk opens it (D53).
    await page.goto(`/app/vault/${c.vault}?chain=${c.chainId}#risk`);
    await expectRiskPhase(page, c, phase);

    const dir = process.env.RISK_SHOTS;
    if (dir) {
      const rail = page.locator("section#risk");
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

// Each state on demand, on the v2 call vault (the SDK calls the Stylus engine directly there, so a fixture's expiry in
// the future gets real greeks from the engine at that tenor). Its series of 2 October; reads rewritten by lifecycle.ts.
const V2 = CASES[0]!;
const V2_SERIES = 8614008145645214741184698995285385951692715470493509368088435356950067027964n;
// v2's StockOracle and the TSLA stock token on 46630 (contracts/deployments/46630.json: stockOracle, stocks.TSLA.token).
const V2_ORACLE = "0x7bb3cAb211E7Ce51e37693E0155C77f477F8aB89";
const V2_TSLA = "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E";

for (const phase of ["selling", "expired", "settled", "open"] as const) {
  test(`vault risk panel, ${phase} (fixture, v2 on Robinhood Chain testnet)`, async ({ page }) => {
    if (phase !== "expired")
      test.skip(
        test.info().project.name !== "desktop",
        "the expired state runs on both; the rest on desktop",
      );
    test.skip(!(await rpcUp(V2.rpc, V2.chainId)), `${V2.chain} RPC unreachable`);
    await acknowledge(page);
    // The fixture reports a fresh print, so the spot must be one too, whatever the day (V2_TSLA, V2_ORACLE below).
    const price = await lastPrint(V2.rpc, V2_ORACLE, V2_TSLA);
    await patchEthCalls(
      page,
      V2.chainId,
      V2.rpc,
      [...PHASE_SELECTORS, SPOT],
      [
        vaultPhase({ vault: V2.vault as Address, seriesId: V2_SERIES, phase }),
        feedStatus(0, Math.floor(Date.now() / 1000) - 600),
        spotWhenReverted(price),
      ],
    );
    await page.goto(`/app/vault/${V2.vault}?chain=${V2.chainId}#risk`);
    await expectRiskPhase(page, V2, phase);
  });
}
