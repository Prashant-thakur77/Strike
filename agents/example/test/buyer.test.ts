import { describe, expect, it } from "vitest";
import { affordableOptions, buyOptions, pickSeries, redeemOptions, shortId } from "../src/buyer.js";
import { type StrikeMcp, ToolError } from "../src/mcp.js";
import type { VaultView } from "../src/types.js";

// The buyer agent against a scripted Strike MCP server: which tools it calls, with what, and what it says.

const mandate = {
  minDeltaBps: 1000,
  maxDeltaBps: 3500,
  minPremiumBps: 9500,
  minYieldBps: 5,
  maxShareSoldBps: 8000,
  minTenor: 86_400,
  maxTenor: 691_200,
  summary: "",
};
const vaultView = (
  symbol: string,
  kind: VaultView["kind"],
  epochState: VaultView["epochState"],
  remaining = "8",
): VaultView => ({
  address: `0x${symbol}`,
  symbol,
  name: symbol,
  kind,
  epochState,
  agentId: "1",
  underlying: { symbol: "TSLA" },
  asset: { symbol: kind === "covered-call" ? "TSLA" : "USDG" },
  totalAssets: "10",
  mandate,
  series:
    epochState === "Selling"
      ? {
          id: "42",
          strike: "389.79",
          expiryIso: "2026-10-09T20:00:00.000Z",
          premiumBps: 10_000,
          sold: "0",
          size: "8",
          remaining,
        }
      : null,
});
const CC = vaultView("sTSLA-CC", "covered-call", "Selling");
const CSP = vaultView("sTSLA-CSP", "cash-secured-put", "Open");

type Handler = (args: Record<string, unknown>) => unknown;

/** A StrikeMcp whose tools are `handlers`; records every call. */
function fakeMcp(handlers: Record<string, Handler>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const mcp: StrikeMcp = {
    client: undefined as never,
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return handler(args) as T;
    },
    close: async () => {},
  };
  return { mcp, calls, argsOf: (name: string) => calls.filter((c) => c.name === name).map((c) => c.args) };
}

function recorder() {
  const lines: string[] = [];
  return { lines, log: { step: (t: string) => lines.push(`# ${t}`), say: (l: string) => lines.push(l) } };
}

/** quote at `perOption` USDG per option (6-decimal strings, as the MCP server formats them). */
const quoteAt = (perOption: number) => (args: Record<string, unknown>) => ({
  seriesId: "42",
  underlying: "TSLA",
  strike: "389.79",
  expiryIso: "2026-10-09T20:00:00.000Z",
  premiumBps: 10_000,
  amount: String(args.amount),
  remaining: "8",
  premium: (Number(args.amount) * perOption).toFixed(6).replace(/\.?0+$/, ""),
  premiumPerOption: String(perOption),
});

const bought = (args: Record<string, unknown>) => ({
  vaultSymbol: args.vault,
  seriesId: args.vault === "sTSLA-CSP" ? "43" : "42",
  underlying: "TSLA",
  isCall: args.vault !== "sTSLA-CSP",
  strike: args.vault === "sTSLA-CSP" ? "350" : "389.79",
  expiryIso: "2026-10-09T20:00:00.000Z",
  amount: String(args.amount),
  premiumPaid: (Number(args.amount) * (args.vault === "sTSLA-CSP" ? 1.5 : 2.44)).toString(),
  premiumPerOption: args.vault === "sTSLA-CSP" ? "1.5" : "2.44",
  maxPremium: "0",
  maxLoss: (Number(args.amount) * (args.vault === "sTSLA-CSP" ? 1.5 : 2.44)).toString(),
  breakeven: args.vault === "sTSLA-CSP" ? "348.5" : "392.23",
  txHash: "0xbuy",
  explanation: "",
});

describe("buyer strategy", () => {
  it("sizes an order to the budget with slippage headroom", () => {
    expect(affordableOptions(10, 2.44, 100, Number.POSITIVE_INFINITY)).toBe(4); // 10 / 2.4644 = 4.06
    expect(affordableOptions(10, 2.44, 100, 2)).toBe(2);
    expect(affordableOptions(10, 2.44, 100, 2.5)).toBe(2);
    expect(affordableOptions(1, 2.44, 100, 8)).toBe(0.4); // below one option: hundredths
    expect(affordableOptions(0.001, 2.44, 100, 8)).toBe(0);
    expect(affordableOptions(10, 0, 100, 8)).toBe(0);
  });

  it("shortens 256-bit series ids for the narrative", () => {
    expect(shortId("82704486548296460466137399048234592122040480043184794643538196096873311146115")).toBe(
      "827044…6115",
    );
    expect(shortId("42")).toBe("42");
  });

  it("picks a live series with options left, calls first, or the requested vault", () => {
    const put = vaultView("sTSLA-CSP", "cash-secured-put", "Selling");
    expect(pickSeries([put, CC])?.symbol).toBe("sTSLA-CC");
    expect(pickSeries([put, CC], "stsla-csp")?.symbol).toBe("sTSLA-CSP");
    expect(pickSeries([put, CC], "0xsTSLA-CSP")?.symbol).toBe("sTSLA-CSP");
    expect(pickSeries([vaultView("sTSLA-CC", "covered-call", "Selling", "0"), CSP])).toBeNull();
    expect(pickSeries([CC], "sTSLA-CSP")).toBeNull();
  });
});

describe("buyOptions", () => {
  it("buys the options a 10 USDG budget affords and explains max loss and breakeven", async () => {
    const { mcp, argsOf } = fakeMcp({
      list_vaults: () => ({ vaults: [CSP, CC] }),
      quote: quoteAt(2.44),
      buy_options: bought,
    });
    const { lines, log } = recorder();
    const res = await buyOptions(mcp, { budget: 10 }, log);
    expect(argsOf("quote")).toEqual([
      { vault: "sTSLA-CC", amount: "1" },
      { vault: "sTSLA-CC", amount: "4" },
    ]);
    expect(argsOf("buy_options")).toEqual([{ vault: "sTSLA-CC", amount: "4", maxSlippageBps: 100 }]);
    expect(res.premiumPaid).toBe("9.76");
    const out = lines.join("\n");
    expect(out).toMatch(/sTSLA-CC sells series 42: TSLA call, strike \$389\.79/);
    expect(out).toMatch(/4 options, quoted 9\.76 USDG \(at most 9\.8576 USDG\)/);
    expect(out).toMatch(/Max loss: 9\.76 USDG, the premium/);
    expect(out).toMatch(/Breakeven at expiry: TSLA at \$392\.23 \(strike \$389\.79 \+ 2\.44 per option\)/);
    expect(out).toMatch(/settles above \$389\.79/);
  });

  it("steps the order down when the exact quote would break the budget", async () => {
    // One option quotes 2.44, but four quote 9.95: with 1% slippage that is 10.05 > 10.
    const { mcp, argsOf } = fakeMcp({
      list_vaults: () => ({ vaults: [CC] }),
      quote: (args) => quoteAt(args.amount === "4" ? 2.4875 : 2.44)(args),
      buy_options: bought,
    });
    await buyOptions(mcp, { budget: 10, amount: 6 }, recorder().log);
    expect(argsOf("quote").map((a) => a.amount)).toEqual(["1", "4", "3"]);
    expect(argsOf("buy_options")[0]).toMatchObject({ amount: "3" });
  });

  it("refuses when nothing is on sale or the budget buys nothing", async () => {
    const idle = fakeMcp({ list_vaults: () => ({ vaults: [CSP] }) });
    await expect(buyOptions(idle.mcp, { budget: 10 }, recorder().log)).rejects.toThrow(/no vault is selling/);
    const poor = fakeMcp({ list_vaults: () => ({ vaults: [CC] }), quote: quoteAt(2.44) });
    await expect(buyOptions(poor.mcp, { budget: 0.001 }, recorder().log)).rejects.toThrow(/buys no options/);
    expect(poor.argsOf("buy_options")).toEqual([]);
  });

  it("hedges a holding with the put series hedge_plan picks, within the budget", async () => {
    const plan = {
      underlying: "TSLA",
      side: "long",
      position: "10",
      hedgeable: true,
      canBuyNow: true,
      explanation: "Hedge 10 TSLA with 10 puts of sTSLA-CSP ...",
      hedge: {
        vaultSymbol: "sTSLA-CSP",
        seriesId: "43",
        optionType: "put",
        strike: "350",
        options: "10",
        coverage: 1,
        premium: "15",
        premiumPerOption: "1.5",
        protectedPrice: "350",
        effectivePrice: "348.5",
        maxLoss: "205",
      },
    };
    const { mcp, argsOf } = fakeMcp({
      list_vaults: () => ({ vaults: [CC] }),
      hedge_plan: () => plan,
      quote: quoteAt(1.5),
      buy_options: bought,
    });
    const { lines, log } = recorder();
    await buyOptions(mcp, { budget: 10, hedge: 10 }, log);
    expect(argsOf("hedge_plan")).toEqual([{ underlying: "TSLA", position: "10" }]);
    expect(argsOf("buy_options")).toEqual([{ vault: "sTSLA-CSP", amount: "6", maxSlippageBps: 100 }]);
    const out = lines.join("\n");
    expect(out).toMatch(/Hedge 10 TSLA with 10 puts/);
    expect(out).toMatch(/covers 6 of the 10 tokens/);
    expect(out).toMatch(/strike \$350 − 1\.5 per option/);

    const none = fakeMcp({
      list_vaults: () => ({ vaults: [CC] }),
      hedge_plan: () => ({ ...plan, hedgeable: false, hedge: null, explanation: "No TSLA put series" }),
    });
    await expect(buyOptions(none.mcp, { budget: 10, hedge: 10 }, recorder().log)).rejects.toThrow(
      /no live series can hedge/,
    );
  });
});

describe("redeemOptions", () => {
  const redeemed = {
    vaultSymbol: "sTSLA-CC",
    seriesId: "42",
    status: "settled",
    settlementPrice: "400",
    amount: "4",
    paid: "0.1021",
    paidAsset: "TSLA",
    paidValue: "40.84",
    txHash: "0xredeem",
    explanation: "series 42 settled at $400, in the money: 4 options paid 0.1021 TSLA",
  };

  it("redeems in every vault that has settled options and skips the rest", async () => {
    const { mcp } = fakeMcp({
      list_vaults: () => ({ vaults: [CC, CSP] }),
      redeem_options: (args) => {
        if (args.vault === "sTSLA-CSP")
          throw new ToolError("redeem_options", "0xB0B holds no options of sTSLA-CSP");
        return redeemed;
      },
    });
    const { lines, log } = recorder();
    const res = await redeemOptions(mcp, {}, log);
    expect(res).toHaveLength(1);
    const out = lines.join("\n");
    expect(out).toMatch(/sTSLA-CC: redeemed 4 options for 0\.1021 TSLA/);
    expect(out).toMatch(/sTSLA-CSP: nothing to redeem \(0xB0B holds no options of sTSLA-CSP\)/);
  });

  it("stops on the requested vault's error, and when nothing was redeemed", async () => {
    const pending = fakeMcp({
      redeem_options: () => {
        throw new ToolError("redeem_options", "series 42 is not settled yet");
      },
      list_vaults: () => ({ vaults: [CC] }),
    });
    await expect(redeemOptions(pending.mcp, { vault: "sTSLA-CC" }, recorder().log)).rejects.toThrow(
      /not settled yet/,
    );
    await expect(redeemOptions(pending.mcp, {}, recorder().log)).rejects.toThrow(/no settled options/);
  });
});
