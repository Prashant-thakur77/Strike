import { type StrikeMcp, ToolError } from "./mcp.js";
import type { BuyResult, HedgePlan, QuoteResult, RedeemResult, VaultView } from "./types.js";

// The buyer side of Strike: an agent that buys the options the vaults sell, to hedge a stock position or for
// directional exposure, within a USDG budget, and redeems them after settlement.

/** Where the buyer narrates (the agent's numbered steps). */
export interface Log {
  step(title: string): void;
  say(line: string): void;
}

/** Default USDG budget of the buyer agent. */
export const DEFAULT_BUDGET = 10;
/** Default slippage allowance on top of the quote, bps (1%). */
export const DEFAULT_SLIPPAGE_BPS = 100;

/** Micro-USDG (6 decimals) of a decimal string or number, for exact budget arithmetic. */
const micro = (usdg: string | number) => Math.round(Number(usdg) * 1e6);
/** The most the contract may charge: the quote plus slippage, rounded up as buy_options does. */
const worstCase = (premium: string, slippageBps: number) =>
  micro(premium) + Math.ceil((micro(premium) * slippageBps) / 10_000);
const fmt = (micros: number) => (micros / 1e6).toFixed(6).replace(/\.?0+$/, "");
const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
/** Series ids are 256-bit hashes: show the ends. */
export const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id);

/**
 * Options a USDG budget buys at `perOption` each with `slippageBps` of headroom, capped at `cap`: whole options when
 * at least one fits, else hundredths. 0 when the budget buys nothing.
 */
export function affordableOptions(
  budget: number,
  perOption: number,
  slippageBps: number,
  cap: number,
): number {
  if (!(budget > 0) || !(perOption > 0)) return 0;
  const raw = Math.min(budget / (perOption * (1 + slippageBps / 10_000)), cap);
  if (raw >= 1) return Math.floor(raw);
  return Math.floor(raw * 100 + 1e-9) / 100;
}

/** One order size smaller: a whole option, or a hundredth below one. */
function stepDown(amount: number): number {
  return amount > 1 ? amount - 1 : Math.round((amount - 0.01) * 100) / 100;
}

/**
 * The vault to buy from: `requested` (symbol or address) if given, else the first vault selling a series with options
 * left, covered calls first. Null when nothing is on sale.
 */
export function pickSeries(vaults: VaultView[], requested?: string): VaultView | null {
  const live = vaults.filter((v) => v.epochState === "Selling" && v.series && Number(v.series.remaining) > 0);
  if (requested) {
    const r = requested.toLowerCase();
    return live.find((v) => v.symbol.toLowerCase() === r || v.address.toLowerCase() === r) ?? null;
  }
  return live.find((v) => v.kind === "covered-call") ?? live[0] ?? null;
}

export interface BuyOptions {
  /** Vault symbol or address; default: the first live series (or, with `hedge`, the best hedge). */
  vault?: string;
  /** Most USDG to spend, slippage included. */
  budget: number;
  /** Most options to buy (default: as many as the budget allows). */
  amount?: number;
  /** Tokens held to protect: size the purchase with hedge_plan (puts for a long position). */
  hedge?: number;
  /** Stock token symbol for the hedge (default: the vault's, or the first vault's). */
  underlying?: string;
  slippageBps?: number;
}

/**
 * Buyer mode: find a live series (or plan a hedge with hedge_plan), size the order so the quote plus slippage fits
 * the budget, buy with buy_options and explain the position: premium, max loss and breakeven.
 */
export async function buyOptions(mcp: StrikeMcp, opts: BuyOptions, log: Log): Promise<BuyResult> {
  const slippageBps = opts.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  log.step("Find a live series");
  const { vaults } = await mcp.call<{ vaults: VaultView[] }>("list_vaults");
  const selling = vaults.filter((v) => v.epochState === "Selling" && v.series);
  for (const v of selling) {
    const s = v.series as NonNullable<VaultView["series"]>;
    log.say(
      `${v.symbol} sells series ${shortId(s.id)}: ${v.underlying.symbol} ${v.kind === "covered-call" ? "call" : "put"}, strike $${s.strike}, expiry ${s.expiryIso}, ${s.remaining} of ${s.size} options left.`,
    );
  }
  if (selling.length === 0) log.say("No vault is selling options right now.");

  let vault: string;
  let perOption: number;
  let cap = opts.amount ?? Number.POSITIVE_INFINITY;
  if (opts.hedge !== undefined) {
    log.step("Plan the hedge (hedge_plan)");
    const target = opts.vault
      ? { vault: opts.vault }
      : { underlying: opts.underlying ?? vaults[0]?.underlying.symbol };
    const plan = await mcp.call<HedgePlan>("hedge_plan", { ...target, position: String(opts.hedge) });
    log.say(plan.explanation);
    if (!plan.hedge) throw new Error("no live series can hedge this position right now; not buying");
    vault = plan.hedge.vaultSymbol;
    perOption = Number(plan.hedge.premiumPerOption);
    cap = Math.min(cap, Number(plan.hedge.options));
  } else {
    const choice = pickSeries(vaults, opts.vault);
    if (!choice?.series) {
      throw new Error(
        opts.vault
          ? `${opts.vault} has no series on sale right now`
          : "no vault is selling options right now",
      );
    }
    vault = choice.symbol;
    log.step(`Quote ${choice.symbol} (quote)`);
    const one = Math.min(1, Number(choice.series.remaining));
    const q = await mcp.call<QuoteResult>("quote", { vault, amount: String(one) });
    perOption = Number(q.premiumPerOption);
    log.say(
      `One option costs ${q.premiumPerOption} USDG now: Black-Scholes fair value × ${pct(q.premiumBps)} at the oracle spot moved 0.5% against the buyer, never below intrinsic value.`,
    );
    cap = Math.min(cap, Number(q.remaining));
  }

  log.step("Size the order within the budget");
  let amount = affordableOptions(opts.budget, perOption, slippageBps, cap);
  const budgetMicro = micro(opts.budget);
  let quote: QuoteResult | null = null;
  for (let tries = 0; amount > 0 && tries < 5; tries += 1) {
    quote = await mcp.call<QuoteResult>("quote", { vault, amount: String(amount) });
    if (worstCase(quote.premium, slippageBps) <= budgetMicro) break;
    amount = stepDown(amount);
    quote = null;
  }
  if (!quote || amount <= 0) {
    throw new Error(`a ${opts.budget} USDG budget buys no options at ${perOption} USDG each; not buying`);
  }
  log.say(
    `Budget ${opts.budget} USDG with ${pct(slippageBps)} slippage headroom: ${amount} options, quoted ${quote.premium} USDG (at most ${fmt(worstCase(quote.premium, slippageBps))} USDG).`,
  );
  if (opts.hedge !== undefined && amount < opts.hedge) {
    log.say(`That covers ${amount} of the ${opts.hedge} tokens; the rest stay unhedged.`);
  }

  log.step("Buy (buy_options)");
  const res = await mcp.call<BuyResult>("buy_options", {
    vault,
    amount: String(amount),
    maxSlippageBps: slippageBps,
  });
  const kind = res.isCall ? "call" : "put";
  log.say(
    `Bought ${res.amount} ${res.underlying} ${kind}s of series ${shortId(res.seriesId)} (${res.vaultSymbol}) for ${res.premiumPaid} USDG, ${res.premiumPerOption} per option (tx ${res.txHash}).`,
  );
  log.say(`Max loss: ${res.maxLoss} USDG, the premium; nothing more can be lost.`);
  log.say(
    `Breakeven at expiry: ${res.underlying} at $${res.breakeven} (strike $${res.strike} ${res.isCall ? "+" : "−"} ${res.premiumPerOption} per option).`,
  );
  log.say(
    res.isCall
      ? `If ${res.underlying} settles above $${res.strike} on ${res.expiryIso}, each option pays (S − K) / S ${res.underlying}. Redeem after settlement with --redeem.`
      : `If ${res.underlying} settles below $${res.strike} on ${res.expiryIso}, each option pays K − S in USDG. Redeem after settlement with --redeem.`,
  );
  return res;
}

/**
 * Redeem this wallet's options of settled (or cancelled) series: in `vault`, or in every vault (skipping those with
 * nothing to redeem). Throws when nothing was redeemed.
 */
export async function redeemOptions(
  mcp: StrikeMcp,
  opts: { vault?: string },
  log: Log,
): Promise<RedeemResult[]> {
  log.step("Redeem settled options (redeem_options)");
  const targets = opts.vault
    ? [opts.vault]
    : (await mcp.call<{ vaults: VaultView[] }>("list_vaults")).vaults.map((v) => v.symbol);
  const done: RedeemResult[] = [];
  for (const vault of targets) {
    try {
      const r = await mcp.call<RedeemResult>("redeem_options", { vault });
      log.say(r.explanation.replace(r.seriesId, shortId(r.seriesId)));
      log.say(
        `${r.vaultSymbol}: redeemed ${r.amount} options for ${r.paid} ${r.paidAsset} (tx ${r.txHash}).`,
      );
      done.push(r);
    } catch (err) {
      if (opts.vault || !(err instanceof ToolError)) throw err;
      log.say(`${vault}: nothing to redeem (${err.message.replace(/^redeem_options: /, "")}).`);
    }
  }
  if (done.length === 0) throw new Error("no settled options to redeem");
  return done;
}
