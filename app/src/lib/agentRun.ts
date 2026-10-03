// "Run the agent" on the playground: the example agent's rule stages (market analyst, risk analyst, strike planner,
// critic) run in the browser against a live vault, through the same contract views the agent calls, and nothing is
// sent. The result has the shape of a record's `decision.pipeline` (lib/pipeline.ts), so the decision page's stage
// strip renders it. Claude is not called here: it needs a key, and a public page would spend it for every visitor.
//
// The profiles mirror agents/example/src/strategy.ts; the critic's cushion rule mirrors
// agents/example/src/specialists/critic.ts (break-even at least 0.5 one-sigma moves from spot).

import type { Pipeline, Stage } from "./pipeline";

export interface RunProfile {
  id: "default" | "conservative";
  label: string;
  targetDelta: number;
  premiumBps: number;
  /** Share of the mandate's maximum size offered. */
  sizeShare: number;
}

export const RUN_PROFILES: readonly RunProfile[] = [
  {
    id: "default",
    label: "Default: 0.20 delta at fair value, the full size the mandate allows",
    targetDelta: 0.2,
    premiumBps: 10_000,
    sizeShare: 1,
  },
  {
    id: "conservative",
    label: "Conservative (agent #2): 0.15 delta at 108% of fair value, half the size",
    targetDelta: 0.15,
    premiumBps: 10_800,
    sizeShare: 0.5,
  },
];

export const CUSHION_SIGMAS = 0.5;
const BPS = 10_000;
const YEAR = 31_536_000;

/** What the browser read before the run: the playground snapshot's view of one vault. */
export interface RunInputs {
  vault: string;
  symbol: string;
  isCall: boolean;
  marketOpen: boolean;
  /** "Open" is the only state in which the contract takes a proposal. */
  epochState: string;
  feedOk: boolean;
  feedNote: string;
  /** The spot and volatility the contract judges against now (USD, annualised). */
  spot: number | null;
  sigma: number;
  mandate: { minDeltaBps: number; maxDeltaBps: number; minPremiumBps: number; maxShareSoldBps: number };
  /** Seconds from now to the expiry the agent would use. */
  tenorSeconds: number;
  expiryIso: string;
  stockOracle: string;
  epochManager: string;
}

/** One rung the browser dry-ran: the strike the pricer solved and the contract's verdict on it. */
export interface RunRung {
  targetDeltaBps: number;
  strike: number | null;
  size: number | null;
  ok: boolean;
  reason: string;
  fairValue: number | null;
  delta: number | null;
  /** Premium over collateral per option, bps. */
  yieldBps: number | null;
  /** The solve or the preview reverted. */
  error: string | null;
}

export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Target deltas from one step below the band to one step above it, 0.05 apart (the agent's ladder). */
export function runTargets(m: RunInputs["mandate"]): number[] {
  const out: number[] = [];
  const lo = Math.max(0.05, m.minDeltaBps / BPS - 0.05);
  const hi = Math.min(0.95, m.maxDeltaBps / BPS + 0.05);
  for (let d = Math.round(lo * 100); d <= Math.round(hi * 100) + 1e-9; d += 5) out.push(d * 100);
  return out;
}

/** The profile's premium factor raised to the mandate's floor, as the agent does. */
export function profilePremium(p: RunProfile, m: RunInputs["mandate"]): number {
  return Math.max(p.premiumBps, m.minPremiumBps);
}

const pct = (x: number, f = 1) => `${(x * 100).toFixed(f)}%`;
const usd = (x: number) => `$${x.toFixed(2)}`;

/** The run as a pipeline, from what the browser read and the rungs it dry-ran. */
export function buildRun(
  inp: RunInputs,
  profile: RunProfile,
  rungs: RunRung[],
  durations: Partial<Record<string, number>> = {},
): Pipeline {
  const premiumBps = profilePremium(profile, inp.mandate);
  const checks = [
    {
      check: "session",
      code: "MARKET_CLOSED",
      ok: inp.marketOpen,
      waived: !inp.marketOpen,
      measured: inp.marketOpen ? "NYSE regular session open" : "NYSE closed",
      limit: "the NYSE regular session (openEpoch and buy revert outside it)",
    },
    {
      check: "epoch",
      code: "EPOCH_NOT_OPEN",
      ok: inp.epochState === "Open",
      waived: inp.epochState !== "Open",
      measured: `epoch ${inp.epochState}`,
      limit: "Open: the only state in which the contract takes a proposal",
    },
    {
      check: "feed",
      code: "FEED_UNUSABLE",
      ok: inp.feedOk,
      measured: inp.feedNote,
      limit: "a safe price from the stock oracle",
    },
    {
      check: "spot",
      code: "NO_SPOT",
      ok: inp.spot !== null,
      measured: inp.spot === null ? "no reference spot" : `${usd(inp.spot)}, σ ${pct(inp.sigma, 0)} a year`,
      limit: "the spot and volatility the contract judges against",
    },
  ];
  const hardFail = !inp.feedOk || inp.spot === null;
  const waived = checks.filter((c) => c.waived).map((c) => c.check);
  const market: Stage = {
    stage: "market",
    attempt: 1,
    verdict: hardFail ? "fail" : "pass",
    summary: hardFail
      ? "No-go: the feed gives no safe price, so no strike can be priced."
      : `Go${waived.length ? ` (${waived.join(" and ")} waived: evaluated as if a proposal could be sent now)` : ""}.`,
    inputs: { vault: inp.vault },
    output: { go: !hardFail, checks },
    sources: [
      { kind: "contract", name: "StockOracle.status", address: inp.stockOracle, chainId: null },
      { kind: "contract", name: "EpochManager.epochs", address: inp.epochManager, chainId: null },
    ],
    durationMs: durations.market ?? null,
    by: "rule",
    narration: null,
  };
  const notRun = (stage: string, why: string): Stage => ({
    stage,
    attempt: 1,
    verdict: "not-run",
    summary: `not run: ${why}`,
    inputs: {},
    output: {},
    sources: [],
    durationMs: null,
    by: stage === "contract" ? "contract" : "rule",
    narration: null,
  });
  if (hardFail) {
    return {
      stages: [
        market,
        notRun("risk", "the market analyst stopped the run"),
        notRun("planner", "the market analyst stopped the run"),
        notRun("critic", "the market analyst stopped the run"),
        notRun("contract", "the playground sends nothing"),
      ],
      noTrade: {
        stage: "market",
        reasons: [market.summary],
        codes: checks.filter((c) => !c.ok && !c.waived).map((c) => c.code),
      },
      run: {
        dryRun: true,
        ignoreSession: waived.length > 0,
        note: "Run in your browser against the live vault: nothing was sent.",
      },
      llm: null,
      alternatives: [],
      confidence: null,
    };
  }
  const spot = inp.spot!;
  const sd = inp.sigma * Math.sqrt(inp.tenorSeconds / YEAR);
  const rows = rungs.map((g) => {
    const premium = g.fairValue === null ? null : (g.fairValue * premiumBps) / BPS;
    const breakEven =
      g.strike === null || premium === null ? null : inp.isCall ? g.strike + premium : g.strike - premium;
    let p: number | null = null;
    if (g.strike !== null && sd > 0) {
      const d2 = (Math.log(spot / g.strike) - (sd * sd) / 2) / sd;
      p = inp.isCall ? normCdf(d2) : normCdf(-d2);
    }
    return {
      targetDeltaBps: g.targetDeltaBps,
      premiumBps,
      ok: g.ok,
      reason: g.error ? `reverted: ${g.error}` : g.reason,
      failedRule: null,
      strike: g.strike === null ? null : g.strike.toFixed(2),
      size: g.size === null ? null : String(g.size),
      fairValue: g.fairValue,
      yieldBps: g.yieldBps,
      delta: g.delta,
      breakEven: breakEven === null ? null : breakEven.toFixed(4),
      breakEvenDistance: breakEven === null ? null : inp.isCall ? breakEven / spot - 1 : 1 - breakEven / spot,
      exerciseProbability: p,
    };
  });
  const passing = rows.filter((r) => r.ok);
  const risk: Stage = {
    stage: "risk",
    attempt: 1,
    verdict: passing.length ? "pass" : "fail",
    summary: `${rows.length} rungs dry-run in your browser, ${passing.length} inside the mandate.`,
    inputs: { vault: inp.vault, premiumBps, expiryIso: inp.expiryIso },
    output: {
      rows,
      rejections: Object.fromEntries(
        [...new Set(rows.filter((r) => !r.ok).map((r) => r.reason))].map((k) => [
          k,
          rows.filter((r) => !r.ok && r.reason === k).length,
        ]),
      ),
    },
    sources: [
      { kind: "contract", name: "EpochManager.previewProposal", address: inp.epochManager, chainId: null },
      { kind: "sdk", name: "solveStrike (the pricer's strikeForDelta)", address: null, chainId: null },
    ],
    durationMs: durations.risk ?? null,
    by: "rule",
    narration: null,
  };
  if (!passing.length) {
    return {
      stages: [
        market,
        risk,
        notRun("planner", "no rung passed the mandate"),
        notRun("critic", "no rung passed the mandate"),
        notRun("contract", "the playground sends nothing"),
      ],
      noTrade: {
        stage: "risk",
        reasons: ["no rung passed the mandate"],
        codes: Object.keys(risk.output.rejections as object),
      },
      run: {
        dryRun: true,
        ignoreSession: waived.length > 0,
        note: "Run in your browser against the live vault: nothing was sent.",
      },
      llm: null,
      alternatives: [],
      confidence: null,
    };
  }
  const want = Math.min(
    Math.max(Math.round(profile.targetDelta * BPS), inp.mandate.minDeltaBps),
    inp.mandate.maxDeltaBps,
  );
  const considered = [...rows]
    .map((r) => ({
      targetDeltaBps: r.targetDeltaBps,
      ok: r.ok,
      reason: r.reason,
      distanceBps: Math.abs(r.targetDeltaBps - want),
    }))
    .sort((a, b) => a.distanceBps - b.distanceBps || a.targetDeltaBps - b.targetDeltaBps);
  const pick = considered.find((c) => c.ok)!;
  const chosen = rows.find((r) => r.targetDeltaBps === pick.targetDeltaBps)!;
  const planner: Stage = {
    stage: "planner",
    attempt: 1,
    verdict: "pass",
    summary:
      pick.targetDeltaBps === want
        ? `The rung at the profile's ${(want / BPS).toFixed(2)} delta, which the contract's dry run accepts.`
        : `The nearest rung to the profile's ${(want / BPS).toFixed(2)} delta that the contract accepts.`,
    inputs: { profile: profile.id, desiredDeltaBps: want, premiumBps },
    output: {
      targetDeltaBps: pick.targetDeltaBps,
      premiumBps,
      strike: chosen.strike,
      size: chosen.size,
      from: "ladder",
      considered: considered.map((c) => ({ ...c, selected: c.targetDeltaBps === pick.targetDeltaBps })),
    },
    sources: [{ kind: "sdk", name: `profile ${profile.id}` }].map((x) => ({
      ...x,
      address: null,
      chainId: null,
    })),
    durationMs: 0,
    by: "rule",
    narration: null,
  };
  const cushion = chosen.breakEvenDistance ?? 0;
  const cushionLimit = CUSHION_SIGMAS * sd;
  const rules = [
    {
      priority: "P0",
      code: "MARKET_NO_GO",
      rule: "market",
      ok: true,
      applicable: true,
      measured: waived.length ? `go, with ${waived.join(" and ")} waived` : "go",
      limit: "the market analyst's go",
    },
    {
      priority: "P1",
      code: "MANDATE_REJECTED",
      rule: "mandate",
      ok: chosen.ok,
      applicable: true,
      measured: `previewProposal: ${chosen.reason}`,
      limit: "every rule of the vault's mandate",
    },
    {
      priority: "P2",
      code: "CUSHION_TOO_THIN",
      rule: "cushion",
      ok: cushion >= cushionLimit,
      applicable: true,
      measured: `break-even ${chosen.breakEven ? usd(Number(chosen.breakEven)) : "n/a"} is ${pct(cushion)} from spot ${usd(spot)}`,
      limit: `at least ${pct(cushionLimit)} (${CUSHION_SIGMAS} x the ${pct(sd)} one-sigma move to expiry)`,
    },
  ];
  const vetoed = rules.filter((r) => !r.ok);
  const critic: Stage = {
    stage: "critic",
    attempt: 1,
    verdict: vetoed.length ? "fail" : "pass",
    summary: vetoed.length
      ? `Veto: ${vetoed.map((r) => r.code).join(", ")}.`
      : `All ${rules.length} rules pass.`,
    inputs: { plan: planner.output },
    output: { modifications: [], rules, veto: vetoed.map((r) => r.code) },
    sources: [
      { kind: "contract", name: "EpochManager.previewProposal", address: inp.epochManager, chainId: null },
    ],
    durationMs: 0,
    by: "rule",
    narration: null,
  };
  return {
    stages: [
      market,
      risk,
      planner,
      critic,
      notRun(
        "contract",
        "the playground sends nothing; the agent would send this proposal while the epoch is Open",
      ),
    ],
    noTrade: vetoed.length
      ? { stage: "critic", reasons: vetoed.map((r) => r.measured), codes: vetoed.map((r) => r.code) }
      : null,
    run: {
      dryRun: true,
      ignoreSession: waived.length > 0,
      note: "Run in your browser against the live vault: nothing was sent.",
    },
    llm: null,
    alternatives: [],
    confidence:
      chosen.exerciseProbability === null
        ? null
        : {
            worthlessProbability: 1 - chosen.exerciseProbability,
            kind: "model odds",
            basis: `Black-Scholes N(d2) at σ ${pct(inp.sigma, 0)} and ${(inp.tenorSeconds / 86_400).toFixed(2)} days to expiry: model odds, not a forecast`,
          },
  };
}
