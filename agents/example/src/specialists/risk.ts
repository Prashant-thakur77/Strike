import {
  DEFAULT_SHOCKS,
  type StrikeClient,
  epochManagerAbi,
  getDeployment,
  normCdf,
  numberToWad,
  riskEngineAbi,
  riskEngineError,
  tenorYears,
} from "@strike/sdk";
import { type Address, getAddress, parseUnits } from "viem";
import { cleanError } from "../candidates.js";
import { type NotProvided, isNotProvided, notProvided } from "../pipeline.js";
import type { RecordCandidate, RecordFailedRule } from "../record.js";

// The risk analyst: for every rung of the candidate ladder (dry-run through the MCP server's read-only risk_check,
// the contract's own previewProposal) it asks the risk engine contract for the option's greeks and the vault's payout
// at spot moves of -30% to +30%, and works out the break-even and the model probability of exercise. The engine is the
// EpochManager's pricer (the Stylus engine RiskLens reads through on v3). series_risk reads the same engine, but only
// for a series that is already selling; a candidate has no series yet, so the analyst passes the candidate's strike,
// tenor and size to the engine itself.

/** Greeks of one option, holder's side, from the engine (delta in tokens, gamma per $1, vega per 1.00 of vol, theta per day). */
export interface RowGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

/** The vault's worst payout on the ±30% grid for this candidate's size. */
export interface RowStress {
  /** The shock that costs the most, as a fraction (-0.3 = spot 30% lower). */
  worstShock: number;
  worstSpot: string;
  /** USD the vault would pay option holders at that spot. */
  worstLossUsd: string;
  /** That payout as a share of the collateral the candidate locks (0.25 = 25%). */
  shareOfCollateral: number;
  /** Premium the candidate would collect if every option sold, USD. */
  premiumIncomeUsd: string;
}

export interface RiskRow {
  targetDeltaBps: number | null;
  premiumBps: number | null;
  /** The contract's verdict for the rung (previewProposal through risk_check). */
  ok: boolean;
  reason: string | null;
  failedRule: RecordFailedRule | null;
  strike: string | null;
  size: string | null;
  capacity: string | null;
  fairValue: string | null;
  /** Fair value x premium factor, per option, USD. */
  premium: string | null;
  yieldBps: number | null;
  /** |delta| the contract measured. */
  delta: number | null;
  greeks: RowGreeks | NotProvided;
  stress: RowStress | NotProvided;
  /** The settlement price at which the vault's payout equals the premium it collected. */
  breakEven: string | null;
  /** How far the break-even is from spot, as a fraction of spot (always positive). */
  breakEvenDistance: number | null;
  /**
   * Model odds that the option ends in the money: Black-Scholes N(d2) for a call, N(-d2) for a put (risk-neutral,
   * zero rate, the pricer's sigma). Not a forecast.
   */
  exerciseProbability: number | null;
  /** The rung's dry run could not be read. */
  error?: string;
}

export interface RiskTable {
  isCall: boolean;
  spot: string;
  sigma: number;
  chainTimeIso: string;
  expiryIso: string;
  tenorSeconds: number;
  premiumBps: number;
  engine: { address: string; via: string } | NotProvided;
  shocks: string;
  rows: RiskRow[];
}

/** The engine calls the analyst makes (a contract in production, a fixture in tests). */
export interface RiskEngineReader {
  address: string;
  via: string;
  greeks(spot: bigint, strike: bigint, tenor: bigint, sigma: bigint, isCall: boolean): Promise<RowGreeks>;
  /** Largest payout on the grid (USD WAD) and the payout at each shock. */
  scenarioLoss(
    isCall: boolean,
    strike: bigint,
    soldWad: bigint,
    spot: bigint,
    shocks: readonly bigint[],
  ): Promise<{ worst: bigint; losses: readonly bigint[] }>;
}

const WAD = 10n ** 18n;
const toNum = (x: bigint) => Number(x) / 1e18;
const usd = (x: number) =>
  x
    .toFixed(6)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");

/** Model probability that the option ends in the money (see {@link RiskRow.exerciseProbability}). */
export function exerciseProbability(
  spot: number,
  strike: number,
  tenorSeconds: number,
  sigma: number,
  isCall: boolean,
): number | null {
  if (!(spot > 0 && strike > 0 && sigma > 0)) return null;
  if (!(tenorSeconds > 0)) return isCall ? (spot > strike ? 1 : 0) : strike > spot ? 1 : 0;
  const vol = sigma * Math.sqrt(tenorYears(tenorSeconds));
  const d2 = (Math.log(spot / strike) - (vol * vol) / 2) / vol;
  return isCall ? normCdf(d2) : normCdf(-d2);
}

/** Break-even for the vault (seller): strike plus the premium for a call, minus it for a put. */
export function breakEven(strike: number, premium: number, isCall: boolean): number {
  return isCall ? strike + premium : strike - premium;
}

/** One rung of the ladder with the engine's numbers. Never throws: an engine failure is "not provided". */
export async function riskRow(
  c: RecordCandidate,
  ctx: { spot: number; sigma: number; tenorSeconds: number; isCall: boolean },
  engine: RiskEngineReader | NotProvided,
): Promise<RiskRow> {
  const base: RiskRow = {
    targetDeltaBps: c.targetDeltaBps,
    premiumBps: c.premiumBps,
    ok: c.ok,
    reason: c.reason,
    failedRule: c.failedRule,
    strike: c.strike,
    size: c.size,
    capacity: c.capacity,
    fairValue: c.fairValue,
    premium: c.premium,
    yieldBps: c.yieldBps,
    delta: c.delta,
    greeks: notProvided("the rung's dry run could not be read"),
    stress: notProvided("the rung's dry run could not be read"),
    breakEven: null,
    breakEvenDistance: null,
    exerciseProbability: null,
    ...(c.error !== undefined ? { error: c.error } : {}),
  };
  if (c.error !== undefined || c.strike === null) return base;
  const strike = Number(c.strike);
  const premium = c.premium !== null ? Number(c.premium) : 0;
  const be = breakEven(strike, premium, ctx.isCall);
  base.breakEven = usd(be);
  base.breakEvenDistance = Math.abs(be - ctx.spot) / ctx.spot;
  base.exerciseProbability = exerciseProbability(ctx.spot, strike, ctx.tenorSeconds, ctx.sigma, ctx.isCall);
  if (isNotProvided(engine)) {
    base.greeks = engine;
    base.stress = engine;
    return base;
  }
  const spotWad = numberToWad(ctx.spot);
  const strikeWad = parseUnits(c.strike, 18);
  try {
    base.greeks = await engine.greeks(
      spotWad,
      strikeWad,
      BigInt(Math.max(1, Math.round(ctx.tenorSeconds))),
      numberToWad(ctx.sigma),
      ctx.isCall,
    );
  } catch (err) {
    base.greeks = notProvided(
      `the risk engine rejected the greeks call (${cleanError(riskEngineError(err))})`,
    );
  }
  const size = c.size !== null ? Number(c.size) : 0;
  if (!(size > 0)) {
    base.stress = notProvided("the rung offers no options, so there is nothing to stress");
    return base;
  }
  try {
    const soldWad = parseUnits(c.size as string, 18);
    const { worst, losses } = await engine.scenarioLoss(
      ctx.isCall,
      strikeWad,
      soldWad,
      spotWad,
      DEFAULT_SHOCKS,
    );
    const i = Math.max(
      0,
      losses.findIndex((l) => l === worst),
    );
    const shock = toNum(DEFAULT_SHOCKS[i] ?? 0n);
    const worstSpot = (ctx.spot * (1 + shock)) as number;
    const lossUsd = toNum(worst);
    // Collateral the candidate locks: the options' strike value in USDG for a put, one token per option for a call
    // (valued at the shocked spot, the price the call's payout is measured at).
    const collateralUsd = ctx.isCall ? size * worstSpot : size * strike;
    base.stress = {
      worstShock: Math.round(shock * 100) / 100,
      worstSpot: usd(worstSpot),
      worstLossUsd: usd(lossUsd),
      shareOfCollateral: collateralUsd > 0 ? lossUsd / collateralUsd : 0,
      premiumIncomeUsd: usd(premium * size),
    };
  } catch (err) {
    base.stress = notProvided(
      `the risk engine rejected the stress test (${cleanError(riskEngineError(err))})`,
    );
  }
  return base;
}

/** The risk table for a dry-run ladder. */
export async function riskTable(opts: {
  ladder: RecordCandidate[];
  engine: RiskEngineReader | NotProvided;
  spot: number;
  sigma: number;
  nowSec: number;
  expirySec: number;
  isCall: boolean;
  premiumBps: number;
}): Promise<RiskTable> {
  const tenorSeconds = Math.max(0, opts.expirySec - opts.nowSec);
  const ctx = { spot: opts.spot, sigma: opts.sigma, tenorSeconds, isCall: opts.isCall };
  const rows: RiskRow[] = [];
  for (const c of opts.ladder) rows.push(await riskRow(c, ctx, opts.engine));
  return {
    isCall: opts.isCall,
    spot: usd(opts.spot),
    sigma: opts.sigma,
    chainTimeIso: new Date(opts.nowSec * 1000).toISOString(),
    expiryIso: new Date(opts.expirySec * 1000).toISOString(),
    tenorSeconds,
    premiumBps: opts.premiumBps,
    engine: isNotProvided(opts.engine) ? opts.engine : { address: opts.engine.address, via: opts.engine.via },
    shocks: "spot moves of -30% to +30% in 5% steps (RiskLens.defaultShocks)",
    rows,
  };
}

/**
 * The risk engine of a vault's EpochManager: its `pricer()` (the Stylus pricer, which is also the IRiskEngine RiskLens
 * reads through), else the deployment's `riskEngine`. Not provided when neither answers `greeks`.
 */
export async function riskEngineFor(
  strike: StrikeClient,
  probe: { spot: bigint },
): Promise<RiskEngineReader | NotProvided> {
  const pc = strike.viem.publicClient;
  const candidates: { address: Address; via: string }[] = [];
  try {
    const pricer = await pc.readContract({
      address: strike.addresses.epochManager,
      abi: epochManagerAbi,
      functionName: "pricer",
    });
    candidates.push({ address: getAddress(pricer), via: "EpochManager.pricer()" });
  } catch {
    // an EpochManager without pricer(): try the deployment's engine
  }
  let configured: string | undefined;
  try {
    configured = getDeployment(strike.chainId).riskEngine ?? undefined;
  } catch {
    configured = undefined;
  }
  if (configured && !candidates.some((c) => c.address.toLowerCase() === configured.toLowerCase()))
    candidates.push({ address: getAddress(configured), via: "the deployment's riskEngine" });
  const errors: string[] = [];
  for (const c of candidates) {
    const reader = engineReader(strike, c.address, c.via);
    try {
      await reader.greeks(probe.spot, probe.spot, 86_400n, WAD / 2n, true);
      return reader;
    } catch (err) {
      errors.push(`${c.address}: ${cleanError(riskEngineError(err))}`);
    }
  }
  return notProvided(
    candidates.length === 0
      ? "no risk engine is deployed for this EpochManager"
      : `no risk engine answered greeks (${errors.join("; ")})`,
  );
}

function engineReader(strike: StrikeClient, address: Address, via: string): RiskEngineReader {
  const pc = strike.viem.publicClient;
  return {
    address,
    via,
    async greeks(spot, k, tenor, sigma, isCall) {
      const [delta, gamma, vega, theta] = await pc.readContract({
        address,
        abi: riskEngineAbi,
        functionName: "greeks",
        args: [spot, k, tenor, sigma, isCall],
      });
      return { delta: toNum(delta), gamma: toNum(gamma), vega: toNum(vega), theta: toNum(theta) };
    },
    async scenarioLoss(isCall, k, soldWad, spot, shocks) {
      const [worst, losses] = await pc.readContract({
        address,
        abi: riskEngineAbi,
        functionName: "scenarioLoss",
        args: [isCall, k, soldWad, spot, [...shocks]],
      });
      return { worst, losses };
    },
  };
}
