import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createPublicClient, http, parseAbi, type Address } from "viem";
import {
  hasPosition,
  intrinsicNow,
  optionState,
  portfolioTotals,
  type OptionRow,
  type PositionRow,
} from "../src/lib/portfolio";
import { acknowledge, horizontalOverflow } from "./helpers";

// /app/portfolio: one wallet across every vault. The aggregation on hand-made rows, the page without a wallet, and the
// page for a read-only wallet on Robinhood Chain testnet (the deployer, which holds vault shares), cross-checked
// against balanceOf and pendingPremium read here from the public RPC.

const RPC = process.env.E2E_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com";
const DEPLOYER = "0x26b277b434B1670f207Afd8946edA9AF78A613Ff";
const REPO = join(__dirname, "..", "..");

const pos = (over: Partial<PositionRow> = {}): PositionRow => ({
  vault: "0x01",
  symbol: "sTSLA-CC",
  version: "v3",
  isCall: true,
  underlying: "TSLA",
  shares: 0,
  assets: 0,
  assetUsd: 370,
  pendingPremium: 0,
  queuedDeposit: 0,
  queuedRedeemShares: 0,
  claimableDepositShares: 0,
  claimableRedeemAssets: 0,
  ...over,
});
const opt = (over: Partial<OptionRow> = {}): OptionRow => ({
  seriesId: "7",
  vault: "0x01",
  symbol: "sTSLA-CC",
  isCall: true,
  underlying: "TSLA",
  strike: 369.86,
  expiry: 1_790_971_200,
  balance: 4,
  settled: false,
  cancelled: false,
  payoutPerOption: 0,
  assetUsd: 380,
  spot: 380,
  ...over,
});

test.describe("portfolio logic", () => {
  test.skip(({ isMobile }) => isMobile, "pure logic runs once, on desktop");

  test("positions, option states and totals", () => {
    expect(hasPosition(pos())).toBe(false);
    expect(hasPosition(pos({ pendingPremium: 0.01 }))).toBe(true);
    expect(hasPosition(pos({ queuedRedeemShares: 1 }))).toBe(true);
    const o = opt();
    expect(optionState(o, o.expiry - 1)).toBe("live");
    expect(optionState(o, o.expiry)).toBe("expired");
    expect(optionState(opt({ settled: true, payoutPerOption: 0.0267 }), 0)).toBe("paid");
    expect(optionState(opt({ settled: true }), 0)).toBe("worthless");
    expect(optionState(opt({ cancelled: true }), 0)).toBe("cancelled");
    expect(intrinsicNow(o)).toBeCloseTo(10.14, 9);
    expect(intrinsicNow(opt({ isCall: false, strike: 342.91, spot: 380 }))).toBe(0);
    const t = portfolioTotals(
      [
        pos({ shares: 5, assets: 5 }),
        pos({ vault: "0x02", isCall: false, assets: 60, assetUsd: 1, pendingPremium: 10 }),
        pos({ vault: "0x03" }),
      ],
      [opt(), opt({ seriesId: "8", settled: true, payoutPerOption: 0.0267 })],
    );
    expect(t.vaults).toBe(2);
    expect(t.depositsUsd).toBeCloseTo(5 * 370 + 60, 9);
    expect(t.premiumToClaim).toBe(10);
    expect(t.options).toBe(8);
    expect(t.redeemableUsd).toBeCloseTo(0.0267 * 4 * 380, 9);
  });
});

/** A read-only EIP-1193 wallet on Robinhood Chain testnet: accounts and chain answered locally, reads forwarded. */
async function readOnlyWallet(page: Page, account: string) {
  await page.addInitScript(
    ({ rpc, account }) => {
      let id = 0;
      (window as unknown as { ethereum: unknown }).ethereum = {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
          if (method === "eth_chainId") return "0xb626";
          if (method === "net_version") return "46630";
          if (method === "wallet_requestPermissions" || method === "wallet_getPermissions")
            return [{ parentCapability: "eth_accounts" }];
          if (method === "wallet_switchEthereumChain") return null;
          const res = await fetch(rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
          });
          const json = await res.json();
          if (json.error) throw Object.assign(new Error(json.error.message), { code: json.error.code });
          return json.result;
        },
        on() {},
        removeListener() {},
      };
    },
    { rpc: RPC, account },
  );
}

/** Every vault of both Robinhood Chain testnet deployments and the deployer's shares and premium in each. */
async function deployerHoldings(): Promise<{ vault: Address; shares: bigint; premium: bigint }[]> {
  const client = createPublicClient({ transport: http(RPC) });
  const em = parseAbi([
    "function vaultCount() view returns (uint256)",
    "function allVaults(uint256) view returns (address)",
  ]);
  const v = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function pendingPremium(address) view returns (uint256)",
  ]);
  const out: { vault: Address; shares: bigint; premium: bigint }[] = [];
  for (const f of ["46630.json", "46630-v3.json"]) {
    const manager = JSON.parse(readFileSync(join(REPO, "contracts", "deployments", f), "utf8"))
      .epochManager as Address;
    const n = await client.readContract({ address: manager, abi: em, functionName: "vaultCount" });
    for (let i = 0n; i < n; i++) {
      const vault = await client.readContract({
        address: manager,
        abi: em,
        functionName: "allVaults",
        args: [i],
      });
      const [shares, premium] = await Promise.all([
        client.readContract({ address: vault, abi: v, functionName: "balanceOf", args: [DEPLOYER] }),
        client.readContract({ address: vault, abi: v, functionName: "pendingPremium", args: [DEPLOYER] }),
      ]);
      out.push({ vault, shares, premium });
    }
  }
  return out;
}

test("without a wallet: says what it would read and links on", async ({ page }) => {
  await acknowledge(page);
  await page.goto("/app/portfolio?chain=46630");
  await expect(page.getByRole("heading", { level: 1, name: "Portfolio" })).toBeVisible();
  await expect(page.getByTestId("portfolio-connect")).toContainText("Connect a wallet");
  await expect(page.getByTestId("page-purpose")).toContainText("across the vaults");
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test("a read-only wallet on Robinhood Chain testnet: every vault it holds, as the chain says", async ({
  page,
}, info) => {
  let expected: Awaited<ReturnType<typeof deployerHoldings>>;
  try {
    expected = await deployerHoldings();
  } catch {
    test.skip(true, "Robinhood Chain testnet RPC unreachable");
    return;
  }
  const holding = expected.filter((x) => x.shares > 0n || x.premium > 0n);
  await acknowledge(page);
  await readOnlyWallet(page, DEPLOYER);
  await page.goto("/app/portfolio?chain=46630");
  if (info.project.name === "mobile") {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Connect wallet" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  } else {
    await page.getByRole("banner").getByRole("button", { name: "Connect wallet" }).click();
  }
  await expect(page.getByTestId("portfolio")).toBeVisible({ timeout: 90_000 });
  const rows = page.getByTestId("portfolio-position");
  if (holding.length === 0) await expect(page.getByTestId("portfolio-empty")).toBeVisible();
  else {
    await expect(rows).toHaveCount(holding.length);
    for (const h of holding)
      await expect(
        page.locator(`[data-testid="portfolio-position"] a[href^="/app/vault/${h.vault}"]`),
      ).toHaveCount(1);
  }
  await expect(page.getByRole("region", { name: "Key figures" })).toContainText(String(holding.length));
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
