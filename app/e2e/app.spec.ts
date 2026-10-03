import { expect, test, type Page } from "@playwright/test";
import { seriesPhase, settlementWait, type SettlementWaitInput } from "../src/lib/lifecycle";
import { fmtUtc } from "../src/lib/marketHours";
import { acknowledge, horizontalOverflow } from "./helpers";
import {
  PHASE_SELECTORS,
  feedStatus,
  livePhase,
  patchEthCalls,
  quoteAt,
  vaultPhase,
  type LivePhase,
} from "./lifecycle";

// App pages against the live Robinhood Chain testnet deployment (skipped when its RPC is unreachable), plus the
// page-numbering rule, which needs no chain.

const RPC = process.env.E2E_RPC_46630 ?? "https://rpc.testnet.chain.robinhood.com";
const CALL_VAULT = "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e";
const CALL_EM = "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99";
/** The v2 call vault's series of 2 October (four $369.86 calls, expiry 20:00 UTC), as epochs(vault) gave it. */
const CALL_SERIES = 8614008145645214741184698995285385951692715470493509368088435356950067027964n;
const CALL_EXPIRY = 1790971200;
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";

/** v3's TSLA cash-secured-put vault on Arbitrum Sepolia (contracts/deployments/421614-vaults.json). */
const ARB_PUT_VAULT = "0x02B701210aA006CEAbd389dBc32af0047B1B9bbe";

async function arbSepoliaUp(): Promise<boolean> {
  try {
    const res = await fetch(process.env.E2E_RPC_421614 ?? "https://sepolia-rollup.arbitrum.io/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    return ((await res.json()) as { result?: string }).result === "0x66eee";
  } catch {
    return false;
  }
}

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

test.describe("expired, waiting for settlement: the wording (no network)", () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== "desktop", "pure functions: one project is enough");
  });
  const base: SettlementWaitInput = {
    symbol: "TSLA",
    expiry: CALL_EXPIRY,
    sold: 4n * 10n ** 18n,
    lastPrintAt: CALL_EXPIRY - 269,
    lastPrice: 370.45,
    mirrored: true,
    reopensAt: Date.parse("2026-10-05T13:30:00Z") / 1000,
    saleCutoff: 3600,
    fmt: fmtUtc,
  };

  test("the phase comes from the state and the clock, not from the state alone", () => {
    const series = { expiry: BigInt(CALL_EXPIRY) };
    expect(seriesPhase({ state: 2, series }, CALL_EXPIRY - 1)).toBe("selling");
    expect(seriesPhase({ state: 2, series }, CALL_EXPIRY)).toBe("expired");
    expect(seriesPhase({ state: 1, series: null }, CALL_EXPIRY)).toBe("open");
    expect(seriesPhase({ state: 0, series: null }, CALL_EXPIRY)).toBe("idle");
  });

  test("no print after expiry over a weekend: the rule, the last print, why, and buying closed", () => {
    const w = settlementWait(base);
    expect(w.headline).toBe("Expired Fri 2 Oct, 20:00 UTC. Waiting for the settlement price.");
    expect(w.rule).toContain(
      "the first Chainlink TSLA print on Robinhood Chain mainnet at or after expiry, mirrored to this testnet by the keeper",
    );
    expect(w.lastPrint).toBe(
      "Last print: Fri 2 Oct, 19:55 UTC, $370.45. It came before expiry, so it is not the settlement price.",
    );
    expect(w.why).toContain("NYSE is closed until Mon 5 Oct, 13:30 UTC.");
    expect(w.buying).toBe(
      "Buying is closed: sales stopped 1 hour before expiry. Holders redeem once the series settles.",
    );
  });

  test("a print at or after expiry: settle can go now, still no price stated", () => {
    const w = settlementWait({ ...base, lastPrintAt: CALL_EXPIRY + 1800, lastPrice: 371.2 });
    expect(w.headline).toBe(
      "Expired Fri 2 Oct, 20:00 UTC. The settlement round is in; waiting for the settle transaction.",
    );
    expect(w.lastPrint).toContain("A round at or after expiry is in: Fri 2 Oct, 20:30 UTC.");
    expect(w.lastPrint).not.toContain("371.2");
    expect(w.why).toBeNull();
  });

  test("nothing sold: no price is needed; a chain without the mirror names no mainnet feed", () => {
    expect(settlementWait({ ...base, sold: 0n }).headline).toBe(
      "Expired Fri 2 Oct, 20:00 UTC. Nothing was sold, so it needs no settlement price.",
    );
    const local = settlementWait({ ...base, mirrored: false, reopensAt: null });
    expect(local.rule).toContain("the first TSLA price round at or after expiry");
    expect(local.rule).not.toContain("Chainlink");
    expect(local.why).toBeNull();
  });
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

  test("vault detail shows the state the vault is in now: selling, expired and settling, settled or open", async ({
    page,
  }) => {
    const phase = await livePhase(RPC, CALL_EM, CALL_VAULT);
    test.info().annotations.push({ type: "phase", description: phase });
    await page.goto(`/app/vault/${CALL_VAULT}?chain=46630`);
    await expectVaultPhase(page, phase, { live: true });
  });

  // The same page in each state on demand: the vault's reads are rewritten (lifecycle.ts), its own series of 2 October.
  for (const phase of ["selling", "expired", "settled", "open"] as const) {
    test(`vault detail, ${phase} (fixture)`, async ({ page }) => {
      if (phase !== "expired")
        test.skip(
          test.info().project.name !== "desktop",
          "the expired state runs on both; the rest on desktop",
        );
      const now = Math.floor(Date.now() / 1000);
      await patchEthCalls(page, 46630, RPC, PHASE_SELECTORS, [
        vaultPhase({ vault: CALL_VAULT, seriesId: CALL_SERIES, phase }),
        // Selling: a fresh print and a quote. Expired: the last print before expiry, as on 2 October (19:55:31).
        phase === "expired" ? feedStatus(2, CALL_EXPIRY - 269) : feedStatus(0, now - 600),
        quoteAt(2_440_240n),
      ]);
      await page.route("**/api/settlement-audit*", (r) =>
        r.fulfill({ json: settlementAuditFixture(CALL_VAULT, CALL_SERIES, CALL_EXPIRY) }),
      );
      await page.goto(`/app/vault/${CALL_VAULT}?chain=46630`);
      await expectVaultPhase(page, phase, { live: false });
    });
  }

  test("an address that is not a vault says so in the heading", async ({ page }) => {
    await page.goto(`/app/vault/0x000000000000000000000000000000000000dEaD?chain=46630`);
    const alert = page.locator("#main").getByRole("alert");
    await expect(alert.getByRole("heading", { name: "No Strike vault at this address." })).toBeVisible({
      timeout: 45_000,
    });
    await expect(alert).not.toContainText("Couldn't read this from the chain");
  });

  // QA of 3 October: v3's Arbitrum Sepolia vaults share their addresses with v1's (superseded) vaults on Robinhood
  // Chain testnet. Opened on the wrong network, such an address showed the v1 vault's empty state with a live deposit
  // form; and a decision page's vault link (?chain=421614) opened on Robinhood Chain testnet without a reload.
  test("a v3 Arbitrum Sepolia vault opened on Robinhood Chain testnet is not shown here, and the app offers the right network", async ({
    page,
  }) => {
    test.skip(!(await arbSepoliaUp()), "Arbitrum Sepolia RPC unreachable");
    await page.goto(`/app/vault/${ARB_PUT_VAULT}?chain=46630`);
    const alert = page.locator("#main").getByRole("alert");
    await expect(alert.getByRole("heading", { name: "No Strike vault at this address." })).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByRole("tab", { name: "Deposit" })).toHaveCount(0);
    const elsewhere = page.getByTestId("vault-elsewhere");
    await expect(elsewhere).toHaveAttribute("data-state", "found", { timeout: 45_000 });
    await expect(elsewhere).toContainText("It is a Strike vault on Arbitrum Sepolia.");
    await alert.getByRole("button", { name: "Switch to Arbitrum Sepolia" }).click();
    await expect(alert).toHaveCount(0, { timeout: 45_000 });
    await expect(page.getByText("Cash-secured put", { exact: true }).first()).toBeVisible();
    await expect(page.locator("#trace")).not.toContainText("Couldn't read the epoch trace", {
      timeout: 45_000,
    });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("a decision page's vault link opens the vault on the record's network", async ({ page }) => {
    test.skip(!(await arbSepoliaUp()), "Arbitrum Sepolia RPC unreachable");
    await page.goto("/app/decision/421614/2026-09-30-sTSLA-CSP");
    const link = page.locator(`a[href^="/app/vault/${ARB_PUT_VAULT}?chain=421614"]`).first();
    await expect(link).toBeVisible({ timeout: 45_000 });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/app/vault/${ARB_PUT_VAULT}`));
    await expect(page.getByText("Cash-secured put", { exact: true }).first()).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator("#main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/Epoch 1/).first()).toBeVisible();
    await expect(page.locator("#trace")).toContainText("Epoch 1 opened", { timeout: 45_000 });
    await expect(page.locator("#trace")).toContainText("2026-09-30");
  });

  test("agents show the ERC-8004 identity and reputation", async ({ page }) => {
    await page.goto("/app/agents?chain=46630");
    // v2 and v3 each have an agent #1 here (both linked to identity #114): the v2 registry's row.
    const toggle = page.getByRole("button", { name: /about agent 1 \(v2 registry\)/ });
    await expect(toggle).toBeVisible({ timeout: 45_000 });
    const group = page.locator("tbody").filter({ has: toggle });
    const chip = group.getByRole("link", { name: /ERC-8004 #114/ });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute(
      "href",
      `https://explorer.testnet.chain.robinhood.com/token/${IDENTITY_REGISTRY}/instance/114`,
    );
    // The toggle opens and closes the row's details.
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(group.getByRole("link", { name: /Registration file/ })).toHaveAttribute(
      "href",
      /docs\/agents\/strike-agent-1\.json$/,
    );
    await expect(group.getByRole("link", { name: /Reputation registry/ })).toHaveAttribute(
      "href",
      new RegExp(`/address/${REPUTATION_REGISTRY}$`),
    );
    await expect(group.getByText(/\d+ feedback posts?/)).toBeVisible();
    await expect(group.getByText(/No settled epochs yet|USDG/).first()).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(group.getByRole("link", { name: /Registration file/ })).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

/** What the mainnet check says while the first print after expiry has not come (as /api/settlement-audit words it). */
function settlementAuditFixture(vault: string, seriesId: bigint, expiry: number) {
  return {
    chainId: 46630,
    vault,
    version: "v2",
    ok: true,
    testnetTime: expiry + 3 * 3600,
    series: [
      {
        seriesId: seriesId.toString(),
        epoch: "1",
        symbol: "TSLA",
        expiry,
        settled: false,
        status: "not-printed",
        roundId: null,
        roundSource: null,
        recordTx: null,
        mainnetRoundId: null,
        mainnetPhase: null,
        mainnetAggregatorRound: null,
        sameAsMainnetSettlement: null,
        skippedMainnetRounds: 0,
        message:
          "Not settled yet; candidate round not yet printed (expired 2026-10-02 20:00 UTC; the feed's latest round 22 is from 2026-10-02 19:55 UTC). Mainnet has not printed after expiry either.",
      },
    ],
  };
}

/**
 * The vault page in `phase`. Selling: the payoff, how the price is set and a buy panel. Expired: the payoff against the
 * last print, the wait for the settlement price, buying closed, no price steps. Settled: between epochs (and, live,
 * the last settlement once there is one). Open: waiting for the agent. `live` loosens what only the fixtures fix (the
 * expiry time, the last print).
 */
async function expectVaultPhase(page: Page, phase: LivePhase, { live }: { live: boolean }) {
  await expect(page.getByRole("heading", { level: 1 })).toContainText("TSLA", { timeout: 45_000 });
  const series = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "This week's option" }) });
  const chart = page.getByRole("img", { name: "Result at expiry, per option" });
  const price = page.getByRole("region", { name: "How the buy price is set" });
  const wait = page.getByTestId("settlement-wait");
  const buy = page.getByTestId("buy-panel");

  if (phase === "selling") {
    await expect(chart).toBeVisible({ timeout: 45_000 });
    await expect(chart.locator("text", { hasText: /^Spot now \$[\d,.]+$/ })).toHaveCount(1);
    await expect(page.locator("figure", { has: chart }).locator("figcaption")).toContainText(/breakeven/);
    await expect(price).toContainText("Priced spot");
    await expect(price).toContainText(/\+ 0\.5%, against the buyer/);
    await expect(price).toContainText(/never below intrinsic value|raised to intrinsic value/);
    await expect(price).toContainText(/Live quote\s*\$[\d,.]+/, { timeout: 45_000 });
    await expect(series.getByTestId("series-clock")).toContainText(/^Expires in /);
    await expect(buy.or(series.getByText("Sold out."))).toBeVisible();
    await expect(wait).toHaveCount(0);
  } else if (phase === "expired") {
    await expect(wait).toBeVisible({ timeout: 45_000 });
    const headline = wait.getByTestId("settlement-wait-headline");
    if (live) await expect(headline).toContainText(/^Expired \w{3} \d{1,2} \w{3}, \d{2}:\d{2} UTC\./);
    else await expect(headline).toHaveText("Expired Fri 2 Oct, 20:00 UTC. Waiting for the settlement price.");
    await expect(wait).toContainText(
      "It settles at the first Chainlink TSLA print on Robinhood Chain mainnet at or after expiry",
    );
    await expect(wait).toContainText("InvalidSettlementRound");
    await expect(wait.getByTestId("settlement-wait-buying")).toContainText("Buying is closed");
    if (!live) {
      await expect(wait.getByTestId("settlement-wait-last")).toContainText(
        /^Last print: Fri 2 Oct, 19:55 UTC, \$[\d,.]+\. It came before expiry, so it is not the settlement price\.$/,
      );
      await expect(wait.getByTestId("settlement-wait-audit")).toContainText(
        "Mainnet has not printed after expiry either.",
      );
    }
    await expect(wait.getByRole("link", { name: /Trust model/ })).toHaveAttribute("href", /trust-model\.md/);
    await expect(wait.getByRole("link", { name: /Runbook/ })).toHaveAttribute("href", /operations\.md#2-/);
    // The payoff at expiry still reads: against the price buyers paid, with the last print marked, not "spot now".
    await expect(chart).toBeVisible();
    await expect(chart.locator("text", { hasText: /^Last print \$[\d,.]+$/ })).toHaveCount(1);
    await expect(chart.locator("text", { hasText: /^Spot now/ })).toHaveCount(0);
    await expect(page.getByTestId("payoff-settlement-note")).toContainText("first print at or after expiry");
    await expect(series.getByTestId("series-clock")).toContainText(/^Expired \w{3} \d{1,2} \w{3}/);
    // No price steps, no quote and no buy button for a series past expiry.
    await expect(price).toHaveCount(0);
    await expect(buy).toHaveCount(0);
    await expect(page.getByText("Expired, settling").first()).toBeVisible();
  } else {
    const prompt = phase === "open" ? "Waiting for the agent." : "No option on sale.";
    await expect(series.getByText(prompt, { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(chart).toHaveCount(0);
    await expect(buy).toHaveCount(0);
    await expect(wait).toHaveCount(0);
    if (phase === "settled" && live) {
      // Once the 2 October series has settled, the idle rail names its settlement price.
      await expect(series.getByTestId("last-settlement")).toContainText(/^Epoch \d+ settled /);
    }
  }
  if (phase === "selling" || phase === "expired") {
    await expect(chart.locator("text", { hasText: /^Strike \$[\d,.]+$/ })).toHaveCount(1);
    await expect(chart.locator("text", { hasText: /^(Breakeven|B\/E) \$[\d,.]+$/ })).toHaveCount(1);
    await expect(chart.locator("text", { hasText: "price at expiry (USD)" })).toHaveCount(1);
    await expect(page.getByText("Show as a table")).toBeAttached();
  }
  // The timeline's Idle step says what it was, not "—".
  const idle = page.locator("li", { has: page.locator("strong", { hasText: /^Idle$/ }) }).first();
  await expect(idle).toBeVisible();
  await expect(idle).not.toContainText("—");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
}
