// The specialist pipeline in a decision record (agents/example README, "The pipeline in the record", decision D45):
// market analyst, risk analyst, strike planner, critic and the contract, each with a verdict, inputs, output, sources
// and timing. Read from the raw record JSON, loosely: a field the record does not carry is null here and the page
// says so; nothing is filled in. `{ provided: false, reason }` is the agent's own "not provided".
//
// Data only (strike.config.json for explorers), so the Playwright specs can load it as CommonJS.
import strikeConfig from "../../../strike.config.json";

export type StageId = "market" | "risk" | "planner" | "critic" | "contract";
export type Verdict = "pass" | "modify" | "fail" | "not-run";

export interface StageSource {
  kind: string;
  name: string;
  address: string | null;
  chainId: number | null;
}

export interface Narration {
  label: string;
  text: string;
}

export interface Stage {
  stage: string;
  attempt: number;
  verdict: string;
  summary: string;
  inputs: Record<string, unknown>;
  output: Record<string, unknown>;
  sources: StageSource[];
  durationMs: number | null;
  by: string;
  narration: Narration | null;
}

export interface NoTrade {
  stage: string;
  reasons: string[];
  codes: string[];
}

export interface RunInfo {
  dryRun: boolean;
  ignoreSession: boolean;
  note: string;
}

export interface Alternative {
  name: string;
  taken: boolean;
  available: boolean | null;
  targetDeltaBps: number | null;
  strike: number | null;
  size: number | null;
  premiumPerOption: number | null;
  premiumIncomeUsd: number | null;
  breakEven: number | null;
  exerciseProbability: number | null;
  stressLossUsd: number | null;
  source: string;
}

export interface Confidence {
  worthlessProbability: number;
  kind: string;
  basis: string;
}

export interface Pipeline {
  stages: Stage[];
  noTrade: NoTrade | null;
  run: RunInfo | null;
  alternatives: Alternative[];
  confidence: Confidence | null;
}

export const STAGE_ORDER: StageId[] = ["market", "risk", "planner", "critic", "contract"];

export const STAGE_LABEL: Record<string, string> = {
  market: "Market analyst",
  risk: "Risk analyst",
  planner: "Strike planner",
  critic: "Critic",
  contract: "Contract",
};

export const BY_LABEL: Record<string, string> = {
  rule: "agent code",
  claude: "Claude",
  contract: "the contract",
};

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `{ provided: false, reason }`: the agent could not get this value. */
export function notProvided(v: unknown): string | null {
  const o = obj(v);
  return o && o.provided === false ? (str(o.reason) ?? "no reason given") : null;
}

function stageOf(v: unknown): Stage | null {
  const o = obj(v);
  if (!o || !str(o.stage)) return null;
  const n = obj(o.narration);
  return {
    stage: str(o.stage)!,
    attempt: num(o.attempt) ?? 1,
    verdict: str(o.verdict) ?? "not-run",
    summary: str(o.summary) ?? "",
    inputs: obj(o.inputs) ?? {},
    output: obj(o.output) ?? {},
    sources: arr(o.sources).flatMap((s) => {
      const x = obj(s);
      return x && str(x.name)
        ? [{ kind: str(x.kind) ?? "", name: str(x.name)!, address: str(x.address), chainId: num(x.chainId) }]
        : [];
    }),
    durationMs: num(o.durationMs),
    by: str(o.by) ?? "",
    narration: n && str(n.text) ? { label: str(n.label) ?? "Claude", text: str(n.text)! } : null,
  };
}

/** The pipeline of a raw record, or null for a record written before it (no `decision.pipeline`). */
export function pipelineOf(raw: unknown): Pipeline | null {
  const r = obj(raw);
  const d = obj(r?.decision);
  const stages = arr(d?.pipeline).flatMap((s) => {
    const x = stageOf(s);
    return x ? [x] : [];
  });
  if (stages.length === 0) return null;
  const nt = obj(obj(r?.result)?.noTrade);
  const run = obj(r?.run);
  const conf = obj(d?.confidence);
  return {
    stages,
    noTrade: nt
      ? {
          stage: str(nt.stage) ?? "",
          reasons: arr(nt.reasons).flatMap((x) => (typeof x === "string" ? [x] : [])),
          codes: arr(nt.codes).flatMap((x) => (typeof x === "string" ? [x] : [])),
        }
      : null,
    run: run
      ? { dryRun: run.dryRun === true, ignoreSession: run.ignoreSession === true, note: str(run.note) ?? "" }
      : null,
    alternatives: arr(d?.alternatives).flatMap((a) => {
      const x = obj(a);
      if (!x || !str(x.name)) return [];
      return [
        {
          name: str(x.name)!,
          taken: x.taken === true,
          available: typeof x.available === "boolean" ? x.available : null,
          targetDeltaBps: num(x.targetDeltaBps),
          strike: num(x.strike),
          size: num(x.size),
          premiumPerOption: num(x.premiumPerOption),
          premiumIncomeUsd: num(x.premiumIncomeUsd),
          breakEven: num(x.breakEven),
          exerciseProbability: num(x.exerciseProbability),
          stressLossUsd: num(x.stressLossUsd),
          source: str(x.source) ?? "",
        },
      ];
    }),
    confidence:
      conf && num(conf.worthlessProbability) !== null
        ? {
            worthlessProbability: num(conf.worthlessProbability)!,
            kind: str(conf.kind) ?? "",
            basis: str(conf.basis) ?? "",
          }
        : null,
  };
}

/** The chip's word for a stage's verdict: a failing non-contract stage that stopped the run reads "No trade". */
export function verdictLabel(s: Stage, noTrade: NoTrade | null): string {
  if (s.verdict === "pass") return "PASS";
  if (s.verdict === "modify") return "MODIFY";
  if (s.verdict === "fail")
    return noTrade && noTrade.stage === s.stage && s.stage !== "contract" ? "No trade" : "FAIL";
  return "Not run";
}

/** Every stage in pipeline order; a stage the record lacks entirely is listed as not run with no reason invented. */
export function stripStages(p: Pipeline): (Stage & { missing?: boolean })[] {
  const out: (Stage & { missing?: boolean })[] = [...p.stages];
  for (const id of STAGE_ORDER)
    if (!p.stages.some((s) => s.stage === id))
      out.push({
        stage: id,
        attempt: 1,
        verdict: "not-run",
        summary: "not in this record",
        inputs: {},
        output: {},
        sources: [],
        durationMs: null,
        by: "",
        narration: null,
        missing: true,
      });
  return out;
}

const EXPLORERS: Record<number, string> = Object.fromEntries(
  Object.entries(strikeConfig.chains).flatMap(([id, c]) =>
    (c as { explorer?: string | null }).explorer ? [[Number(id), (c as { explorer: string }).explorer]] : [],
  ),
);

/** A contract source's explorer link on its own chain (4663 is Robinhood Chain mainnet), else the record's chain. */
export function sourceUrl(s: StageSource, recordChain: number): string | null {
  if (s.kind !== "contract" || !s.address || !/^0x[0-9a-fA-F]{40}$/.test(s.address)) return null;
  const base = EXPLORERS[s.chainId ?? recordChain];
  return base ? `${base.replace(/\/$/, "")}/address/${s.address}` : null;
}

export function txUrl(hash: string, chainId: number): string | null {
  const base = EXPLORERS[chainId];
  return base && /^0x[0-9a-fA-F]{64}$/.test(hash) ? `${base.replace(/\/$/, "")}/tx/${hash}` : null;
}

/* ================================================================ alternatives graded at settlement */

/**
 * The vault's result for an alternative at the settlement price: its premium income minus the payout on its size
 * (a put pays size × max(K − S, 0), a call size × max(S − K, 0)); kept cash is 0. Null when it lacks a strike, size or
 * premium.
 */
export function gradeAlternative(a: Alternative, settlement: number, isCall: boolean): number | null {
  if (a.strike === null && (a.size ?? 0) === 0) return 0;
  if (a.strike === null || a.size === null || a.premiumIncomeUsd === null) return null;
  const payout = a.size * (isCall ? Math.max(settlement - a.strike, 0) : Math.max(a.strike - settlement, 0));
  return a.premiumIncomeUsd - payout;
}

/* ================================================================ the dry runs (no anchor) */

/** Folders of the specialist pipeline's dry runs, per chain. */
export const DRY_RUN_FOLDERS: Record<number, string> = {
  46630: "docs/agent-log/dry-runs",
  421614: "docs/agent-log/dry-runs/arbitrum-sepolia",
};

/** The dry runs the agents page links: the weekend no-trades, the as-if-open runs and the Claude-planned one. */
export const DRY_RUNS: { chainId: number; name: string; what: string }[] = [
  {
    chainId: 46630,
    name: "2026-10-03-sTSLA-CSP-dry-run",
    what: "Weekend: the market analyst stops the run (MARKET_CLOSED)",
  },
  {
    chainId: 421614,
    name: "2026-10-03-sTSLA-CSP-dry-run",
    what: "Weekend on Arbitrum Sepolia: the market analyst stops the run (MARKET_CLOSED)",
  },
  {
    chainId: 46630,
    name: "2026-10-03-sTSLA-CSP-as-if-open-dry-run",
    what: "As if the NYSE were open: every stage runs",
  },
  {
    chainId: 421614,
    name: "2026-10-03-sTSLA-CSP-as-if-open-dry-run",
    what: "As if the NYSE were open, on Arbitrum Sepolia",
  },
  {
    chainId: 46630,
    name: "2026-10-03-sTSLA-CSP-as-if-open-claude-dry-run",
    what: "As if open, with Claude as the strike planner",
  },
];
