import { type Address, type Hex, type PublicClient, getAddress } from "viem";
import {
  epochManagerAbi,
  mirrorFeedAbi,
  riskEngineAbi,
  riskLensAbi,
  stockOracleAbi,
  strikeVaultAbi,
} from "./abi/index.js";
import { StrikeError, describeError } from "./errors.js";
import { type FeedStatus, feedStatusName } from "./names.js";
import type { SeriesState } from "./types.js";
import { BPS, WAD } from "./units.js";

/** RiskLens.defaultShocks: spot moves from −30% to +30% in 5% steps (13 points), WAD (−0.3e18 = −30%). */
export const DEFAULT_SHOCKS: readonly bigint[] = Array.from(
  { length: 13 },
  (_, i) => BigInt(i - 6) * 50_000_000_000_000_000n,
);

/** What each `PricerInputOutOfRange(which)` code means (the pricer's 1-5 and the risk engine's 6-8). */
export const PRICER_INPUT_ERRORS: Record<number, string> = {
  1: "spot outside the pricer's range",
  2: "strike outside the pricer's range",
  3: "time to expiry outside 1 second to 2 years",
  4: "volatility outside 1% to 500%",
  5: "target delta outside (0, 1)",
  6: "option price outside its no-arbitrage bounds (not strictly between intrinsic value and the cap)",
  7: "implied volatility outside 5% to 500%",
  8: "spot shock at or below −100% or above +1000%",
};

/** Greeks in WAD. Per option they describe the option holder's side; `exposure` is the vault's (short) side. */
export interface Greeks {
  /** dValue/dSpot: tokens of stock-equivalent exposure (per option, or in all for an exposure). */
  delta: bigint;
  /** dDelta/dSpot, per $1 of spot. Signed: an exposure's gamma is negative. */
  gamma: bigint;
  /** dValue/dSigma, USD per 1.00 (100 points) of volatility. */
  vega: bigint;
  /** dValue/dt, USD per calendar day. */
  theta: bigint;
}

/** The vault's payout at one spot shock. */
export interface RiskScenario {
  /** Relative spot move, WAD (−0.3e18 = −30%). */
  shock: bigint;
  /** Shocked spot, WAD per token (rounded down, as the engine does). */
  spot: bigint;
  /** USD value (WAD) the vault pays option holders if the series settles at `spot` (the engine's `scenarioLoss`). */
  loss: bigint;
}

/** Implied volatility of the series' last buy, solved by the risk engine's `impliedVol`. */
export interface LastBuyImpliedVol {
  /** Annualised volatility, WAD. */
  sigma: bigint;
  /** Fair value per option the buy implies: price paid ÷ the premium factor, WAD USD. */
  fairValue: bigint;
  /** USDG the buyer paid per option, as WAD USD (the premium is rounded up to the USDG unit). */
  pricePaid: bigint;
  /** Feed price at the buy (the round in force at its block time), WAD. */
  spot: bigint;
  /** `spot` moved `spotBufferBps` against the buyer: the spot `quoteBuy` priced with. */
  pricedSpot: bigint;
  /** Today's buffer (the contract does not record the one in force at the buy). */
  spotBufferBps: number;
  /** Seconds from the buy to expiry. */
  tenor: bigint;
  blockNumber: bigint;
  txHash: Hex;
}

/** Live risk of one series, computed by the risk engine (IRiskEngine) at the chain's current time. */
export interface SeriesRisk {
  seriesId: bigint;
  vault: Address;
  underlying: Address;
  isCall: boolean;
  /** WAD USD per token. */
  strike: bigint;
  expiry: bigint;
  settled: boolean;
  cancelled: boolean;
  /** The contract that computed greeks, scenarios and implied volatility (through RiskLens, the EpochManager's pricer). */
  riskEngine: Address;
  /** How the greeks and scenarios were read: through the v3 RiskLens, or by calling the risk engine directly. */
  source: "riskLens" | "riskEngine";
  /** The RiskLens read (null when the engine was called directly) and the function used. */
  riskLens: Address | null;
  riskLensFunction: "seriesRisk" | "seriesRiskAt" | null;
  chainId: number;
  /** The vault's EpochManager (`StrikeVault.manager()`). */
  epochManager: Address;
  /**
   * Protocol version the series belongs to ("v2", "v3"): the deployment map's `version` when the vault's
   * EpochManager is the map's, "v3" when a RiskLens bound to that EpochManager answered, else null (unknown).
   */
  version: string | null;
  /** Latest block timestamp. */
  chainTime: bigint;
  /** Seconds to expiry; 0 once expired, and the greeks are then 0 (as RiskLens). */
  tenor: bigint;
  /** Spot the risk is computed at, WAD per token: `EpochManager.spot`, or the last print when the feed is unusable. */
  spot: bigint;
  /** "Ok" for a live SafeStockFeed price; otherwise why `spot` is only the last print. */
  spotStatus: FeedStatus;
  /** Volatility the greeks use, WAD: the epoch's opening sigma for the vault's live series, else the current one. */
  sigma: bigint;
  sigmaSource: "epoch-open" | "current";
  /** `EpochManager.underlyings(token).sigma` now, WAD. */
  currentSigma: bigint;
  tokenDecimals: number;
  usdgDecimals: number;
  /** Options sold, underlying base units, and the same in WAD options (what the engine takes). */
  sold: bigint;
  soldWad: bigint;
  /** Collateral locked for the sold options: tokens (calls) or USDG (puts), base units. */
  collateral: bigint;
  collateralUnit: "token" | "usdg";
  /** USDG the vault collected from buyers (base units). */
  premium: bigint;
  /** Per option, option holder's side, at `spot` and `sigma`. */
  greeks: Greeks;
  /** The vault's side: −greeks × options sold. */
  exposure: Greeks;
  /** The same at `currentSigma`, when it differs from `sigma`. */
  atCurrentSigma: { greeks: Greeks; exposure: Greeks } | null;
  /** The shock grid, in order. */
  scenarios: RiskScenario[];
  /** Largest payout on the grid, USD WAD, and the first shock that reaches it. */
  worstLoss: bigint;
  worstShock: bigint;
  /** Payout at `worstShock` in collateral units (tokens for a call, USDG for a put), rounded as `settle` rounds it. */
  worstPayout: bigint;
  /** worstPayout ÷ collateral, bps (both in collateral units); 0 when nothing is sold. */
  worstShareOfCollateralBps: number;
  /** Implied volatility of the last buy, or null with the reason in `impliedVolNote`. */
  impliedVol: LastBuyImpliedVol | null;
  impliedVolNote: string;
}

/** Options for `seriesRisk`. */
export interface SeriesRiskOptions {
  /** Shock grid, WAD; default {@link DEFAULT_SHOCKS}. */
  shocks?: readonly bigint[];
  /** Solve the last buy's implied volatility (reads logs and feed rounds; default true). */
  impliedVol?: boolean;
  /** First block of the `OptionsBought` log scan (default: the deployment block, else 0). */
  fromBlock?: bigint;
}

/** What `seriesRisk` needs from the client. */
export interface RiskContext {
  publicClient: PublicClient;
  epochManager: Address;
  stockOracle: Address;
  riskEngine: Address | undefined;
  /** RiskLens (v3); used when its `manager()` is the series' EpochManager. */
  riskLens?: Address | undefined;
  /** The deployment map's record for the chain, before any env override: which EpochManager is which version. */
  mapped?: { epochManager: Address; version?: string | undefined } | undefined;
  fromBlock: bigint;
  chainId: number;
  blockTimestamp: () => Promise<bigint>;
  usdgDecimals: () => Promise<number>;
  getSeries: (id: bigint) => Promise<SeriesState | null>;
}

/** Plain-words lines for the depositors' side of each greek (one sentence each), for UIs and agents. */
export function explainSeriesRisk(
  r: Pick<SeriesRisk, "exposure" | "sold" | "tokenDecimals" | "tenor" | "isCall">,
  symbol: string,
): { delta: string; gamma: string; vega: string; theta: string } {
  if (r.tenor === 0n) {
    const done = "0: the series has expired, so only the settlement price matters now.";
    return { delta: `Delta ${done}`, gamma: `Gamma ${done}`, vega: `Vega ${done}`, theta: `Theta ${done}` };
  }
  const num = (x: bigint) => Number(x) / 1e18;
  const usd = (x: number) => `$${Math.abs(x).toFixed(2)}`;
  const signed = (x: number, digits: number) =>
    `${x < 0 ? "−" : x > 0 ? "+" : ""}${Math.abs(x).toFixed(digits)}`;
  const [delta, gamma, vega, theta] = [
    r.exposure.delta,
    r.exposure.gamma,
    r.exposure.vega,
    r.exposure.theta,
  ].map(num) as [number, number, number, number];
  const sold = Number(r.sold) / 10 ** r.tokenDecimals;
  const across = `across the ${sold.toLocaleString("en-US", { maximumFractionDigits: 6 })} option${sold === 1 ? "" : "s"} sold`;
  return {
    delta:
      delta <= 0
        ? `Delta ${signed(delta, 2)}: the vault loses about ${usd(delta)} for every $1 ${symbol} rises, ${across}.`
        : `Delta ${signed(delta, 2)}: the vault loses about ${usd(delta)} for every $1 ${symbol} falls, ${across}.`,
    gamma: r.isCall
      ? `Gamma ${signed(gamma, 4)}: each $1 ${symbol} rises adds about ${usd(gamma)} to that loss per $1, so losses speed up as ${symbol} climbs past the strike.`
      : `Gamma ${signed(gamma, 4)}: each $1 ${symbol} falls adds about ${usd(gamma)} to that loss per $1, so losses speed up as ${symbol} drops past the strike.`,
    vega: `Vega ${signed(vega, 2)}: each volatility point (1%) the market adds raises the options' value by about ${usd(vega / 100)}, a mark-to-market loss for the vault until expiry.`,
    theta: `Theta ${signed(theta, 2)}: with nothing else moving, time decay earns the vault about ${usd(theta)} a day.`,
  };
}

const ZERO_GREEKS: Greeks = { delta: 0n, gamma: 0n, vega: 0n, theta: 0n };

/** The vault's side of `sold` WAD options: −greeks × sold, WAD. */
export function vaultExposure(g: Greeks, soldWad: bigint): Greeks {
  const scale = (x: bigint) => -((x * soldWad) / WAD);
  return { delta: scale(g.delta), gamma: scale(g.gamma), vega: scale(g.vega), theta: scale(g.theta) };
}

/** Spot moved by `shock` (WAD), rounded down: RiskLib.shockedSpot. */
export function shockedSpot(spot: bigint, shock: bigint): bigint {
  if (shock <= -WAD || shock > 10n * WAD)
    throw new StrikeError(`spot shock ${shock} is outside (-100%, +1000%]`);
  return (spot * (WAD + shock)) / WAD;
}

/** The payout `EpochManager.settle` computes at `price`: tokens (base units) for a call, USDG for a put. */
export function settlementPayout(
  isCall: boolean,
  strike: bigint,
  sold: bigint,
  price: bigint,
  tokenDecimals: number,
  usdgDecimals: number,
): bigint {
  if (isCall) {
    const perOption = price > strike ? ((price - strike) * WAD) / price : 0n;
    return (sold * perOption) / WAD;
  }
  const perPut = strike > price ? strike - price : 0n;
  // Decimals.valueInUsd(sold, perPut, tokenDecimals, usdgDecimals, Floor)
  return (sold * perPut * 10n ** BigInt(usdgDecimals)) / (10n ** BigInt(tokenDecimals) * WAD);
}

/** `PricerInputOutOfRange(code)` in words, or the error's short description. */
export function riskEngineError(err: unknown): string {
  const text = describeError(err);
  const m = /PricerInputOutOfRange\((\d+)\)/.exec(text);
  const reason = m ? PRICER_INPUT_ERRORS[Number(m[1])] : undefined;
  return reason ? `${text}: ${reason}` : text;
}

const readGreeks = async (
  ctx: RiskContext,
  engine: Address,
  args: readonly [bigint, bigint, bigint, bigint, boolean],
): Promise<Greeks> => {
  const [delta, gamma, vega, theta] = await ctx.publicClient.readContract({
    address: engine,
    abi: riskEngineAbi,
    functionName: "greeks",
    args,
  });
  return { delta, gamma, vega, theta };
};

/**
 * Live risk of a series: greeks at the live spot, the vault's exposure, the payout over a spot-shock grid against
 * the locked collateral, and the implied volatility of the last buy, all computed by the risk engine contract.
 */
export async function computeSeriesRisk(
  ctx: RiskContext,
  seriesOrId: bigint | SeriesState,
  opts: SeriesRiskOptions = {},
): Promise<SeriesRisk> {
  if (!ctx.riskEngine && !ctx.riskLens)
    throw new StrikeError(`no risk engine is deployed on chain ${ctx.chainId}`);
  const s = typeof seriesOrId === "bigint" ? await ctx.getSeries(seriesOrId) : seriesOrId;
  if (!s) throw new StrikeError(`series ${String(seriesOrId)} does not exist`);
  const pc = ctx.publicClient;
  const em = ctx.epochManager;

  const [chainTime, usdgDecimals, u, epoch, live, vaultManager, lensManager] = await Promise.all([
    ctx.blockTimestamp(),
    ctx.usdgDecimals(),
    pc.readContract({ address: em, abi: epochManagerAbi, functionName: "underlyings", args: [s.underlying] }),
    pc.readContract({ address: em, abi: epochManagerAbi, functionName: "epochs", args: [s.vault] }),
    readSpot(ctx, s.underlying),
    pc.readContract({ address: s.vault, abi: strikeVaultAbi, functionName: "manager" }),
    ctx.riskLens
      ? pc
          .readContract({ address: ctx.riskLens, abi: riskLensAbi, functionName: "manager" })
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const same = (a: Address | null | undefined, b: Address | null | undefined) =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();
  // RiskLens is v3-only and bound to one EpochManager: use it only when it is this series' manager.
  const lens =
    ctx.riskLens && same(lensManager, vaultManager) && same(vaultManager, em) ? ctx.riskLens : null;
  const version = same(ctx.mapped?.epochManager, vaultManager)
    ? (ctx.mapped?.version ?? (lens ? "v3" : null))
    : lens
      ? "v3"
      : null;
  // Through RiskLens the engine is the EpochManager's pricer (what RiskLens calls); otherwise the configured one.
  const engine = lens
    ? await pc.readContract({ address: em, abi: epochManagerAbi, functionName: "pricer" })
    : ctx.riskEngine;
  if (!engine)
    throw new StrikeError(
      `no risk engine for series ${s.id} on chain ${ctx.chainId}: the RiskLens is not bound to its EpochManager`,
    );

  const [tokenDecimals, , currentSigma, , , spotBufferBps] = u;
  const [, , epochSeriesId, , openSigma] = epoch;
  const fromEpoch = epochSeriesId === s.id && openSigma > 0n;
  const sigma = fromEpoch ? openSigma : currentSigma;
  let { spot } = live;
  const { status: spotStatus } = live;

  let tenor = s.expiry > chainTime ? s.expiry - chainTime : 0n;
  const soldWad = (s.sold * WAD) / 10n ** BigInt(tokenDecimals);
  const shocks = [...(opts.shocks ?? DEFAULT_SHOCKS)];
  const defaultGrid =
    shocks.length === DEFAULT_SHOCKS.length && shocks.every((x, i) => x === DEFAULT_SHOCKS[i]);

  let greeks: Greeks;
  let atCurrent: Greeks | null;
  let worstLoss: bigint;
  let losses: readonly bigint[];
  let lensFn: "seriesRisk" | "seriesRiskAt" | null = null;
  let lensWorst: { shock: bigint; payout: bigint } | null = null;
  const needCurrent = currentSigma !== sigma && currentSigma > 0n;
  try {
    if (lens) {
      // RiskLens.seriesRisk is the live view (EpochManager.spot, the current sigma, the ±30% grid). The epoch's
      // opening sigma, a last print while the feed is unsafe, or another grid go through seriesRiskAt.
      const liveView = spotStatus === "Ok" && sigma === currentSigma && defaultGrid;
      lensFn = liveView ? "seriesRisk" : "seriesRiskAt";
      const at = (vol: bigint) =>
        pc.readContract({
          address: lens,
          abi: riskLensAbi,
          functionName: "seriesRiskAt",
          args: [s.id, spot, vol, shocks],
        });
      const [main, cur] = await Promise.all([
        liveView
          ? pc.readContract({ address: lens, abi: riskLensAbi, functionName: "seriesRisk", args: [s.id] })
          : at(sigma),
        needCurrent ? at(currentSigma) : Promise.resolve(null),
      ]);
      spot = main.spot;
      tenor = main.tenor;
      greeks = { delta: main.delta, gamma: main.gamma, vega: main.vega, theta: main.theta };
      atCurrent = cur ? { delta: cur.delta, gamma: cur.gamma, vega: cur.vega, theta: cur.theta } : null;
      worstLoss = main.worstLoss;
      losses = main.losses;
      lensWorst = { shock: main.worstShock, payout: main.worstPayout };
    } else {
      const greeksAt = (vol: bigint) =>
        tenor === 0n
          ? Promise.resolve(ZERO_GREEKS)
          : readGreeks(ctx, engine, [spot, s.strike, tenor, vol, s.isCall]);
      [greeks, atCurrent, [worstLoss, losses]] = await Promise.all([
        greeksAt(sigma),
        needCurrent ? greeksAt(currentSigma) : Promise.resolve(null),
        pc.readContract({
          address: engine,
          abi: riskEngineAbi,
          functionName: "scenarioLoss",
          args: [s.isCall, s.strike, soldWad, spot, shocks],
        }),
      ]);
    }
  } catch (err) {
    const via = lens ? ` (through RiskLens at ${getAddress(lens)})` : "";
    throw new StrikeError(
      `the risk engine at ${getAddress(engine)}${via} rejected series ${s.id}: ${riskEngineError(err)}`,
    );
  }

  const scenarios = shocks.map((shock, i) => ({
    shock,
    spot: shockedSpot(spot, shock),
    loss: losses[i] as bigint,
  }));
  const worst = scenarios.find((x) => x.loss === worstLoss) ?? scenarios[0];
  const worstPayout = lensWorst
    ? lensWorst.payout
    : worst
      ? settlementPayout(s.isCall, s.strike, s.sold, worst.spot, tokenDecimals, usdgDecimals)
      : 0n;

  let impliedVol: LastBuyImpliedVol | null = null;
  let impliedVolNote = "not requested";
  if (opts.impliedVol !== false) {
    const iv = await lastBuyImpliedVol(ctx, engine, s, {
      tokenDecimals,
      usdgDecimals,
      spotBufferBps,
      fromBlock: opts.fromBlock ?? ctx.fromBlock,
    });
    impliedVol = iv.value;
    impliedVolNote = iv.note;
  }

  return {
    seriesId: s.id,
    vault: s.vault,
    underlying: s.underlying,
    isCall: s.isCall,
    strike: s.strike,
    expiry: s.expiry,
    settled: s.settled,
    cancelled: s.cancelled,
    riskEngine: getAddress(engine),
    source: lens ? "riskLens" : "riskEngine",
    riskLens: lens ? getAddress(lens) : null,
    riskLensFunction: lensFn,
    chainId: ctx.chainId,
    epochManager: getAddress(vaultManager),
    version,
    chainTime,
    tenor,
    spot,
    spotStatus,
    sigma,
    sigmaSource: fromEpoch ? "epoch-open" : "current",
    currentSigma,
    tokenDecimals,
    usdgDecimals,
    sold: s.sold,
    soldWad,
    collateral: s.collateral,
    collateralUnit: s.isCall ? "token" : "usdg",
    premium: s.premium,
    greeks,
    exposure: vaultExposure(greeks, soldWad),
    atCurrentSigma: atCurrent ? { greeks: atCurrent, exposure: vaultExposure(atCurrent, soldWad) } : null,
    scenarios,
    worstLoss,
    worstShock: lensWorst?.shock ?? worst?.shock ?? 0n,
    worstPayout,
    worstShareOfCollateralBps: s.collateral > 0n ? Number((worstPayout * BigInt(BPS)) / s.collateral) : 0,
    impliedVol,
    impliedVolNote,
  };
}

/** `EpochManager.spot` (every SafeStockFeed check); when it reverts, the oracle's last print and why it is unsafe. */
async function readSpot(ctx: RiskContext, token: Address): Promise<{ spot: bigint; status: FeedStatus }> {
  try {
    const spot = await ctx.publicClient.readContract({
      address: ctx.epochManager,
      abi: epochManagerAbi,
      functionName: "spot",
      args: [token],
    });
    return { spot, status: "Ok" };
  } catch (err) {
    let code: number;
    let price: bigint;
    try {
      [code, price] = await ctx.publicClient.readContract({
        address: ctx.stockOracle,
        abi: stockOracleAbi,
        functionName: "status",
        args: [token],
      });
    } catch {
      throw new StrikeError(`no price for ${token}: ${describeError(err)}`);
    }
    const status = feedStatusName(code);
    // A price that fails a SafeStockFeed check (for example a stale print over a weekend) is still the last print.
    if (status === "Ok" || price === 0n) {
      throw new StrikeError(`no usable price for ${token}: ${status === "Ok" ? describeError(err) : status}`);
    }
    return { spot: price, status };
  }
}

const MAX_ROUND_STEPS = 64;

/**
 * The last buy's implied volatility: its premium per option ÷ the premium factor is the fair value the contract
 * priced (unless the intrinsic floor bound), at the feed price then moved by the spot buffer, with the time left then.
 */
async function lastBuyImpliedVol(
  ctx: RiskContext,
  engine: Address,
  s: SeriesState,
  p: { tokenDecimals: number; usdgDecimals: number; spotBufferBps: number; fromBlock: bigint },
): Promise<{ value: LastBuyImpliedVol | null; note: string }> {
  const pc = ctx.publicClient;
  if (s.sold === 0n) return { value: null, note: "no options bought yet" };
  let log;
  try {
    const logs = await pc.getContractEvents({
      address: ctx.epochManager,
      abi: epochManagerAbi,
      eventName: "OptionsBought",
      args: { seriesId: s.id },
      fromBlock: p.fromBlock,
      toBlock: "latest",
      strict: true,
    });
    log = logs.at(-1);
  } catch (err) {
    return { value: null, note: `could not read the buys from the logs (${describeError(err)})` };
  }
  if (!log || log.args.amount === 0n)
    return { value: null, note: "no OptionsBought log found for this series" };
  const { amount, premium } = log.args;

  try {
    const block = await pc.getBlock({ blockNumber: log.blockNumber });
    const boughtAt = block.timestamp;
    if (boughtAt >= s.expiry) return { value: null, note: "the last buy has no time to expiry" };
    const spot = await feedPriceAt(ctx, s.underlying, boughtAt);
    if (spot === null) return { value: null, note: "the feed round in force at the buy is not available" };
    const buffer = BigInt(p.spotBufferBps);
    const bps = BigInt(BPS);
    const pricedSpot = (spot * (s.isCall ? bps + buffer : bps - buffer)) / bps;
    const pricePaid =
      (premium * 10n ** BigInt(18 - p.usdgDecimals) * 10n ** BigInt(p.tokenDecimals)) / amount;
    const fairValue = (pricePaid * bps) / BigInt(s.premiumBps);
    const intrinsic = s.isCall
      ? pricedSpot > s.strike
        ? pricedSpot - s.strike
        : 0n
      : s.strike > pricedSpot
        ? s.strike - pricedSpot
        : 0n;
    if (pricePaid <= intrinsic) {
      return {
        value: null,
        note: "the last buy paid intrinsic value (the price floor), which carries no volatility",
      };
    }
    const tenor = s.expiry - boughtAt;
    const sigma = await pc.readContract({
      address: engine,
      abi: riskEngineAbi,
      functionName: "impliedVol",
      args: [fairValue, pricedSpot, s.strike, tenor, s.isCall],
    });
    return {
      value: {
        sigma,
        fairValue,
        pricePaid,
        spot,
        pricedSpot,
        spotBufferBps: p.spotBufferBps,
        tenor,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      },
      note: "solved by the risk engine's impliedVol from the last buy's price",
    };
  } catch (err) {
    return { value: null, note: `not derivable: ${riskEngineError(err)}` };
  }
}

/** The feed answer (WAD) of the round in force at `at`: the newest round published at or before it. */
async function feedPriceAt(ctx: RiskContext, token: Address, at: bigint): Promise<bigint | null> {
  const pc = ctx.publicClient;
  const cfg = await pc.readContract({
    address: ctx.stockOracle,
    abi: stockOracleAbi,
    functionName: "feedConfig",
    args: [token],
  });
  const feed = { address: cfg.feed, abi: mirrorFeedAbi } as const;
  const scale = (answer: bigint) =>
    cfg.feedDecimals <= 18
      ? answer * 10n ** BigInt(18 - cfg.feedDecimals)
      : answer / 10n ** BigInt(cfg.feedDecimals - 18);
  let [roundId, answer, , updatedAt] = await pc.readContract({ ...feed, functionName: "latestRoundData" });
  const phaseBase = roundId - (roundId & ((1n << 64n) - 1n));
  for (let i = 0; i < MAX_ROUND_STEPS; i++) {
    if (updatedAt <= at) return answer > 0n ? scale(answer) : null;
    if (roundId - phaseBase <= 1n) return null;
    [roundId, answer, , updatedAt] = await pc.readContract({
      ...feed,
      functionName: "getRoundData",
      args: [roundId - 1n],
    });
  }
  return null;
}
