import { expect, test } from "@playwright/test";
import {
  ContractFunctionRevertedError,
  ContractFunctionExecutionError,
  encodeErrorResult,
  parseAbi,
} from "viem";
// The SDK-free half of src/lib/playground.ts (Playwright's CommonJS loader can't require the ESM-only SDK).
import * as lib from "../src/components/app/playground/model";
import { acknowledge, horizontalOverflow } from "./helpers";

// Live tests read Robinhood Chain testnet (46630) through the public RPC; they skip when it is unreachable.

const RPC = process.env.E2E_RPC_46630 ?? "https://rpc.testnet.chain.robinhood.com";

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

/** Each preset and the verdict the mandate predicts (mirrors PRESETS in src/lib/playground.ts). */
const PRESET_EXPECT = [
  { id: "honest", expect: "None" },
  { id: "reckless", expect: "DeltaOutOfBand" },
  { id: "big", expect: "SizeTooLarge" },
  { id: "cheap", expect: "PremiumBelowFair" },
] as const;

const pureOnly = () =>
  test.skip(test.info().project.name !== "desktop", "pure function: one project is enough");

test.describe("playground helpers", () => {
  test("parseDecimal is strict about format and places", () => {
    pureOnly();
    expect(lib.parseDecimal("0.20", 4)).toBe(2000n);
    expect(lib.parseDecimal("369.64", 2)).toBe(36_964n);
    expect(lib.parseDecimal("1.234", 2)).toBeNull();
    expect(lib.parseDecimal("-1", 2)).toBeNull();
    expect(lib.parseDecimal("", 2)).toBeNull();
    expect(lib.parseDecimal(".5", 2)).toBe(50n);
  });

  test("sizeText never rounds a size up", () => {
    pureOnly();
    expect(lib.sizeText(2_500000000000000000n, 18)).toBe("2.5");
    expect(lib.sizeText(14_833274000237332n, 18)).toBe("0.01483");
    expect(lib.sizeText(0n, 18)).toBe("0");
  });

  test("rules before the failing one pass, the rest are not reached", () => {
    pureOnly();
    const mandate = {
      minDeltaBps: 1000,
      maxDeltaBps: 3500,
      minPremiumBps: 9500,
      minYieldBps: 5,
      maxShareSoldBps: 8000,
      minTenor: 86_400,
      maxTenor: 691_200,
    };
    const marks = lib.mandateRules(mandate, null, 8).map((r) => r.mark); // DeltaOutOfBand
    expect(marks).toEqual(["pass", "pass", "pass", "pass", "pass", "pass", "pass", "fail", "skip"]);
    expect(lib.mandateRules(mandate, null, 0).every((r) => r.mark === "pass")).toBe(true);
    expect(lib.mandateRules(mandate, null, null).every((r) => r.mark === "idle")).toBe(true);
  });

  test("slash consequence: min(slash, bond + unbonding), strikes and the bond floor", () => {
    pureOnly();
    const registry = {
      minBond: 50_000000n,
      slashAmount: 10_000000n,
      maxStrikes: 3,
      unbondDelay: 691_200,
      identityRegistry: "0x0000000000000000000000000000000000000000",
      reputationRegistry: "0x0000000000000000000000000000000000000000",
    } as const;
    const agent = { bond: 50_000000n, unbonding: 0n, strikes: 1 } as Parameters<
      typeof lib.slashConsequence
    >[1];
    expect(lib.slashConsequence(registry, agent)).toEqual({
      slashed: 10_000000n,
      bondAfter: 40_000000n,
      strikesAfter: 2,
      suspended: false,
      underBond: true,
    });
    const last = { bond: 4_000000n, unbonding: 1_000000n, strikes: 2 } as Parameters<
      typeof lib.slashConsequence
    >[1];
    expect(lib.slashConsequence(registry, last)).toMatchObject({ slashed: 5_000000n, suspended: true });
  });

  test("decodes a SafeStockFeed error from the raw revert data the EpochManager ABI can't decode", () => {
    pureOnly();
    const abi = parseAbi(["error StalePrice(uint256 updatedAt, uint256 maxAge)"]);
    const data = encodeErrorResult({ abi, errorName: "StalePrice", args: [1_790_700_322n, 90_000n] });
    const revert = new ContractFunctionRevertedError({ abi: [], data, functionName: "previewProposal" });
    const err = new ContractFunctionExecutionError(revert, {
      abi: [],
      functionName: "previewProposal",
      contractAddress: "0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99",
    });
    expect(lib.decodeRevertWith(err, abi)).toMatchObject({
      name: "StalePrice",
      signature: "StalePrice(1790700322, 90000)",
    });
    expect(lib.decodeRevertWith(new Error("network down"), abi)).toBeNull();
  });
});

test.describe("page", () => {
  test("presets give the verdicts the mandate predicts, live on 46630", async ({ page }) => {
    test.skip(!(await testnetUp()), `Robinhood Chain testnet RPC unreachable (${RPC})`);
    await acknowledge(page);
    await page.goto("/app/playground");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Playground");

    const verdict = page.getByTestId("verdict");
    for (const preset of PRESET_EXPECT) {
      await page.locator(`[data-preset="${preset.id}"]`).click();
      await expect(page.locator(`[data-preset="${preset.id}"]`)).toHaveAttribute("aria-pressed", "true");
      await expect(verdict).not.toHaveAttribute("data-busy", /.*/, { timeout: 45_000 });
      await expect(verdict).not.toHaveAttribute("data-kind", "pending", { timeout: 45_000 });
      const kind = await verdict.getAttribute("data-kind");
      const reason = await verdict.getAttribute("data-reason");
      test.info().annotations.push({ type: preset.id, description: `${kind} · ${reason}` });
      // A stale or paused feed makes the view revert; that is the contract answering, not the page failing.
      if (kind === "revert") {
        test.skip(true, `the contract reverted (${reason}): the feed is not safe right now`);
      }
      if (preset.expect === "None") {
        expect(kind).toBe("accepted");
        await expect(verdict).toContainText("Accepted: the contract would list this series");
      } else {
        expect(kind).toBe("rejected");
        expect(reason).toBe(preset.expect);
        await expect(verdict).toContainText(`Rejected: ${preset.expect}`);
        await expect(verdict).toContainText(
          /slashed by [\d.,]+ USDG, paid to this vault's depositors; \d\/\d strikes/,
        );
      }
      // The failing rule is marked in the rule list, by text as well as colour.
      const failing = page.locator('li[data-mark="fail"]');
      await expect(failing).toHaveCount(preset.expect === "None" ? 0 : 1);
      if (preset.expect !== "None") await expect(failing).toContainText(preset.expect);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("an hour before the close is not an NYSE close", async ({ page }) => {
    test.skip(!(await testnetUp()), `Robinhood Chain testnet RPC unreachable (${RPC})`);
    await acknowledge(page);
    await page.goto("/app/playground");
    const verdict = page.getByTestId("verdict");
    await expect(verdict).toHaveAttribute("data-kind", /accepted|rejected|revert/, { timeout: 45_000 });
    await page.getByRole("button", { name: /An hour before the close/ }).click();
    await expect(verdict).not.toHaveAttribute("data-busy", /.*/, { timeout: 45_000 });
    const kind = await verdict.getAttribute("data-kind");
    test.skip(kind === "revert", "the feed is not safe right now");
    await expect(verdict).toHaveAttribute("data-reason", "InvalidExpiry");
  });
});
