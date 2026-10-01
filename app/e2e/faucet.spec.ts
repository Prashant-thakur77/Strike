import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  type Address,
} from "viem";
import { privateKeyToAddress, generatePrivateKey } from "viem/accounts";
import { foundry } from "viem/chains";
import { RPC, acknowledge, connectWallet, devnetUp, horizontalOverflow, installMockWallet } from "./helpers";

// Strike's test-USDG faucet (UsdgDrip). On a local devnet (Deploy, Seed and DeployUsdgDrip, as sdk/test/devnet.mjs
// runs them) a fresh, impersonated account drips 10 USDG through the mock wallet, sees its balance and the faucet
// change and the cooldown, and the decoded TooSoon when it drips twice; a vault page offers the drip to a wallet with
// less than 10 USDG. On Robinhood Chain testnet (read-only) the faucet page shows what is left in the live faucet.

const LIVE_RPC = process.env.E2E_RPC_46630 ?? "https://rpc.testnet.chain.robinhood.com";
const dripAbi = parseAbi([
  "function drip()",
  "function remaining() view returns (uint256)",
  "function nextDripAt(address) view returns (uint256)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** The local deployment's addresses from the SDK's generated map (as register.spec.ts reads them). */
function local(key: string): Address {
  const src = readFileSync(join(__dirname, "..", "..", "sdk", "src", "deployments.generated.ts"), "utf8");
  const block = src.match(/"31337":\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
  const m = block.match(new RegExp(`"${key}":\\s*"(0x[0-9a-fA-F]{40})"`));
  if (!m) throw new Error(`no 31337 ${key} in the SDK map`);
  return m[1] as Address;
}

const usd = (v: bigint) => (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pub = () => createPublicClient({ chain: foundry, transport: http(RPC) });

/** A never-used address with gas that anvil signs for (impersonated), so every run starts before any drip. */
async function freshAccount(): Promise<Address> {
  const account = privateKeyToAddress(generatePrivateKey());
  const t = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC) });
  await t.setBalance({ address: account, value: parseEther("1") });
  await t.impersonateAccount({ address: account });
  return account;
}

async function dripReady(): Promise<boolean> {
  if (!(await devnetUp())) return false;
  try {
    return (await pub().getCode({ address: local("usdgDrip") })) !== undefined;
  } catch {
    return false;
  }
}

const usdgBalance = (page: Page) => usdgRow(page).locator('[class*="balanceValue"]');
const usdgRow = (page: Page) =>
  page
    .getByRole("list", { name: "Test token balances" })
    .getByRole("listitem")
    .filter({ hasText: "Premiums, put collateral" });

test.beforeEach(async ({ page }) => {
  await acknowledge(page);
});

test.describe("with a local devnet", () => {
  test.beforeEach(async () => {
    test.skip(!(await dripReady()), "needs a Strike devnet with the USDG faucet at E2E_RPC");
  });

  test("drips 10 USDG and shows the new balance, the faucet and the cooldown", async ({ page }, info) => {
    const mobile = info.project.name === "mobile";
    const drip = local("usdgDrip");
    const account = await freshAccount();
    const before = await pub().readContract({ address: drip, abi: dripAbi, functionName: "remaining" });
    await installMockWallet(page, account);
    await page.goto("/app/faucet?chain=31337");
    await connectWallet(page, mobile);

    const remaining = page.getByTestId("drip-remaining");
    await expect(remaining).toHaveText(`${usd(before)} USDG left`);
    await expect(page.getByText("Testnet USDG has no value.")).toBeVisible();
    await expect(usdgBalance(page)).toHaveText("0 USDG");
    const get = usdgRow(page).getByRole("button", { name: "Get 10 test USDG" });
    await expect(get).toBeEnabled();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // Keyboard: focus the button and press Enter.
    await get.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Get 10 test USDG: done.")).toBeVisible({ timeout: 30_000 });
    await expect(usdgBalance(page)).toHaveText("10 USDG");
    expect(
      await pub().readContract({
        address: local("usdg"),
        abi: erc20,
        functionName: "balanceOf",
        args: [account],
      }),
    ).toBe(10_000_000n);
    await expect(remaining).toHaveText(`${usd(before - 10_000_000n)} USDG left`);
    await expect(usdgRow(page).getByRole("button", { name: /^Again at / })).toBeDisabled();
    await expect(usdgRow(page).getByText(/^Claimed\. Next 10 USDG for this wallet: /)).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("a second drip in the same day comes back as 'again at …'", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "one chain-mutating run is enough");
    const drip = local("usdgDrip");
    const account = await freshAccount();
    await installMockWallet(page, account);
    await page.goto("/app/faucet?chain=31337");
    await connectWallet(page, false);
    const get = usdgRow(page).getByRole("button", { name: "Get 10 test USDG" });
    await expect(get).toBeEnabled();
    // Drip from outside the page, so the page's button is still enabled when clicked.
    const wallet = createWalletClient({ account, chain: foundry, transport: http(RPC) });
    const hash = await wallet.writeContract({ address: drip, abi: dripAbi, functionName: "drip" });
    await pub().waitForTransactionReceipt({ hash });
    const next = await pub().readContract({
      address: drip,
      abi: dripAbi,
      functionName: "nextDripAt",
      args: [account],
    });
    expect(next).toBeGreaterThan(0n);
    await get.click();
    await expect(page.getByText(/^Get 10 test USDG failed: /)).toContainText(
      /already got its 10 USDG today: again at (\w{3} )?\d\d:\d\d\./,
    );
  });

  test("a vault page offers test USDG to a wallet with less than 10", async ({ page }, info) => {
    const account = await freshAccount();
    await installMockWallet(page, account);
    await page.goto(`/app/vault/${local("TSLA_cash_secured_put")}?chain=31337`);
    await connectWallet(page, info.project.name === "mobile");
    const nudge = page.getByRole("group", { name: "Test USDG" });
    await expect(nudge).toContainText("This wallet holds 0 USDG.");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    if (info.project.name !== "desktop") return;
    await nudge.getByRole("button", { name: "Get 10 test USDG" }).click();
    await expect(nudge.getByText("Get 10 test USDG: done.")).toBeVisible({ timeout: 30_000 });
    await expect(nudge).toContainText("next 10 test USDG");
  });
});

test.describe("on Robinhood Chain testnet", () => {
  test("the faucet page shows what is left in the live faucet", async ({ page }) => {
    const up = await fetch(LIVE_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    })
      .then((r) => r.json() as Promise<{ result?: string }>)
      .then((j) => j.result === "0xb626")
      .catch(() => false);
    test.skip(!up, `Robinhood Chain testnet RPC unreachable (${LIVE_RPC})`);
    await page.goto("/app/faucet?chain=46630");
    await expect(page.getByTestId("drip-remaining")).toHaveText(/^[\d,.]+ USDG left$/, { timeout: 45_000 });
    await expect(page.getByText("10 USDG per wallet every 24 hours")).toBeVisible();
    await expect(page.getByRole("link", { name: /Robinhood Chain faucet/ }).first()).toHaveAttribute(
      "href",
      "https://faucet.testnet.chain.robinhood.com/",
    );
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});
