import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { RPC, acknowledge, connectWallet, devnetUp, horizontalOverflow, installMockWallet } from "./helpers";

const emAbi = parseAbi([
  "function allVaults(uint256) view returns (address)",
  "function epochs(address) view returns (uint8 state, uint64 openedAt, uint256 seriesId)",
]);
const tokenAbi = parseAbi([
  "function underlying() view returns (address)",
  "function uiMultiplier() view returns (uint256)",
]);

/** The local EpochManager, from the SDK's generated deployments map. */
function localEpochManager(): Address {
  const src = readFileSync(join(__dirname, "..", "..", "sdk", "src", "deployments.generated.ts"), "utf8");
  const m = src.match(/"31337":\s*\{[\s\S]*?"epochManager":\s*"(0x[0-9a-fA-F]{40})"/);
  if (!m) throw new Error("no 31337 deployment in the SDK map");
  return m[1] as Address;
}

// Smoke: every page renders, logs no console errors, and has no horizontal overflow at phone width.
// The app's first-visit eligibility notice is acknowledged up front here; eligibility.spec.ts covers the notice.
test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function scrollThrough(page: Page) {
  await page.evaluate(async () => {
    const step = window.innerHeight;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
}

const STATIC_PAGES = [
  { path: "/", heading: /stock tokens that pay every week/i },
  { path: "/app?chain=46630", heading: /vaults/i },
  { path: "/app/agents?chain=46630", heading: /agents/i },
  { path: "/app/faucet?chain=46630", heading: /faucet/i },
];

for (const p of STATIC_PAGES) {
  test(`renders ${p.path}`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(p.path);
    await expect(page.getByRole("heading", { level: 1, name: p.heading })).toBeAttached();
    await expect(page.getByRole("note", { name: "Risk notice" })).toBeVisible();
    await scrollThrough(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("honours prefers-reduced-motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  // The manifesto is fully inked and the closing panels are stacked instead of pinned.
  await expect(page.locator('[data-on="false"]')).toHaveCount(0);
  const cta = page.getByRole("link", { name: /Open the app/ });
  await cta.scrollIntoViewIfNeeded();
  await expect(cta).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.querySelector("[data-reveal]")!).opacity)).toBe(
    "1",
  );
});

test("shows the not-deployed state on a network without contracts", async ({ page }) => {
  // Robinhood Chain mainnet: in the network menu, no deployment in the SDK map yet.
  await page.goto("/app?chain=4663");
  await expect(page.getByText("Not deployed on Robinhood Chain yet.")).toBeVisible();
});

test("mobile menu opens and closes", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "the menu toggle only shows on phones");
  await page.goto("/");
  await page.getByRole("button", { name: "Menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: /Open app/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Menu" }).click();
  await dialog.getByRole("link", { name: /Safety/ }).click();
  await expect(dialog).toBeHidden();
});

test("app mobile menu has the network switcher and the wallet", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "the menu toggle only shows on phones");
  await page.goto("/app?chain=46630");
  await page.getByRole("button", { name: "Menu" }).click();
  const dialog = page.getByRole("dialog", { name: "Menu" });
  await expect(dialog).toBeVisible();
  const network = dialog.getByRole("combobox", { name: "Network" });
  await expect(network).toBeVisible();
  await expect(network).toHaveValue("46630");
  await expect(dialog.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test.describe("with a local devnet", () => {
  test.beforeEach(async () => {
    test.skip(!(await devnetUp()), "needs a Strike devnet at E2E_RPC");
  });

  test("vault list, detail, agents and faucet render live data", async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto("/app?chain=31337");
    const rows = page.locator('a[href^="/app/vault/"]');
    await expect(rows.first()).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    const href = (await rows.first().getAttribute("href"))!;
    await page.goto(href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Epoch timeline")).toBeVisible();
    await expect(page.getByText("Delta band")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Feedback" }).getByRole("link")).toHaveAttribute(
      "href",
      /issues\/new\?template=testnet-feedback\.yml$/,
    );
    // Per-share figures appear exactly when the stock token's ERC-8056 multiplier is not 1.0.
    const client = createPublicClient({ transport: http(RPC) });
    const stock = await client.readContract({
      address: href.split("/").pop() as Address,
      abi: tokenAbi,
      functionName: "underlying",
    });
    const multiplier = await client
      .readContract({ address: stock, abi: tokenAbi, functionName: "uiMultiplier" })
      .catch(() => 10n ** 18n);
    const perShare = page.getByText(/per share · multiplier \d/i);
    if (multiplier === 10n ** 18n) await expect(perShare).toHaveCount(0);
    else await expect(perShare.first()).toBeVisible();
    await scrollThrough(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.goto("/app/agents");
    await expect(page.getByText(/StrikeWrongSide/).first()).toBeVisible();
    await expect(page.locator("th", { hasText: "Track record" })).toBeAttached(); // thead is hidden on phones
    await expect(page.getByText(/\d+ epochs? settled/).first()).toBeVisible();
    await scrollThrough(page);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    await page.goto("/app/faucet");
    await expect(page.getByRole("heading", { name: "Stock tokens" })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });

  test("connects the injected wallet and shows the position", async ({ page }, info) => {
    await installMockWallet(page);
    await page.goto("/app?chain=31337");
    await page.locator('a[href^="/app/vault/"]').first().waitFor();
    await connectWallet(page, info.project.name === "mobile");
    await page.locator('a[href^="/app/vault/"]').first().click();
    await expect(page.getByText("Premium to claim")).toBeVisible();
    await expect(page.getByText("sTSLA-CC").or(page.getByText("sTSLA-CSP")).first()).toBeVisible();
  });

  test("buys one option through the mock wallet", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "one chain-mutating run is enough");
    await installMockWallet(page);
    await page.goto("/app?chain=31337");
    await page.locator('a[href^="/app/vault/"]').first().waitFor();
    await connectWallet(page, false);
    await page.locator('a[href^="/app/vault/"]').first().click();
    const buy = page.getByRole("button", { name: /^(Approve USDG & buy|Buy)$/ });
    await expect(buy).toBeVisible();
    await page.waitForTimeout(1500); // quote
    test.skip(await buy.isDisabled(), "market closed on the devnet clock");
    await buy.click();
    await expect(page.getByText("Buy options: done.")).toBeVisible({ timeout: 30_000 });
  });

  test("sizes a buy from the position (puts) or a budget (calls)", async ({ page }, info) => {
    const errors = watchErrors(page);
    await installMockWallet(page);
    await page.goto("/app?chain=31337");
    const rows = page.locator('a[href^="/app/vault/"]');
    await rows.first().waitFor();
    await connectWallet(page, info.project.name === "mobile");
    const hrefs = await rows.evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("href")!))]);
    const kinds: string[] = [];
    for (const href of hrefs) {
      await page.goto(href);
      const tabs = page.getByRole("tablist", { name: "How to size the buy" });
      await expect(tabs).toBeVisible();
      const panel = tabs.locator("xpath=../..");
      const amountTab = tabs.getByRole("tab", { name: "Amount" });
      await expect(amountTab).toHaveAttribute("aria-selected", "true"); // the expert mode stays the default
      const isPut = (await tabs.getByRole("tab", { name: "Protect my position" }).count()) > 0;
      kinds.push(isPut ? "put" : "call");
      let expected: number;
      if (isPut) {
        await tabs.getByRole("tab", { name: "Protect my position" }).click();
        const held = panel.getByLabel(/tokens you hold/);
        await expect(held).not.toHaveValue(""); // prefilled from the wallet's stock-token balance
        await expect(panel.getByText(/^[\d,.]+ puts$/)).toBeVisible();
        await expect(panel.getByText(/^[\d,.]+ USDG$/)).toBeVisible(); // quoted premium
        await expect(panel.getByText(/ × \$[\d,.]+ − premium$/)).toBeVisible();
        const text = (await panel.getByText(/^[\d,.]+ puts$/).textContent())!;
        expected = Number(text.replace(/[^\d.]/g, ""));
        expect(expected).toBeGreaterThan(0);
        expect(expected).toBeLessThanOrEqual(Number(await held.inputValue()));
      } else {
        await tabs.getByRole("tab", { name: "Upside for a budget" }).click();
        await panel.getByLabel(/^Budget/).fill("100");
        await expect(panel.getByText(/^[\d,.]+ calls$/)).toBeVisible();
        await expect(panel.getByText("Payout 10% above breakeven")).toBeVisible();
        const maxLoss = panel
          .getByText("Max loss", { exact: true })
          .locator("xpath=following-sibling::dd[1]");
        await expect(maxLoss).toHaveText(/^[\d,.]+ USDG$/);
        expect(Number((await maxLoss.textContent())!.replace(/[^\d.]/g, ""))).toBeLessThanOrEqual(100);
        const text = (await panel.getByText(/^[\d,.]+ calls$/).textContent())!;
        expected = Number(text.replace(/[^\d.]/g, ""));
        expect(expected).toBeGreaterThan(0);
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      await panel.getByRole("button", { name: /Use this amount/ }).click();
      // Back in the amount mode, with the sized amount filled in and quoted.
      await expect(amountTab).toHaveAttribute("aria-selected", "true");
      const filled = Number(await panel.getByLabel(/^Options/).inputValue());
      expect(filled).toBeCloseTo(expected, 3);
      await expect(panel.getByText(/^[\d,.]+ USDG$/).first()).toBeVisible();
    }
    expect(kinds.sort()).toEqual(["call", "put"]);
    expect(errors).toEqual([]);
  });

  test("serves ERC-1155 option metadata for a live series", async ({ request }) => {
    const em = localEpochManager();
    const client = createPublicClient({ transport: http(RPC) });
    const vault = await client.readContract({
      address: em,
      abi: emAbi,
      functionName: "allVaults",
      args: [0n],
    });
    const [, , seriesId] = await client.readContract({
      address: em,
      abi: emAbi,
      functionName: "epochs",
      args: [vault],
    });
    test.skip(seriesId === 0n, "no live series on the devnet");
    const hex = seriesId.toString(16).padStart(64, "0");

    const res = await request.get(`/api/option/${hex}.json?chainId=31337`);
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["cache-control"]).toContain("max-age=60");
    const meta = (await res.json()) as { name: string; image: string; attributes: { trait_type: string }[] };
    expect(meta.name).toMatch(/^TSLA \S+ (Call|Put) · \d+ \w{3} \d{4}$/);
    expect(meta.attributes.map((a) => a.trait_type)).toEqual(
      expect.arrayContaining([
        "Underlying",
        "Strike (USD)",
        "Expiry",
        "Type",
        "Vault",
        "Settled",
        "Settlement price (USD)",
      ]),
    );
    const img = await request.get(new URL(meta.image).pathname + new URL(meta.image).search);
    expect(img.headers()["content-type"]).toContain("image/svg+xml");

    expect((await request.get(`/api/option/not-hex.json?chainId=31337`)).status()).toBe(400);
    expect((await request.get(`/api/option/${"ab".repeat(32)}.json?chainId=31337`)).status()).toBe(404);
  });
});
