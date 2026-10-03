// The specialist pipeline of a propose run, as the decision record keeps it (`decision.pipeline`). Five stages, always
// in this order and always all five: the market analyst, the risk analyst, the strike planner, the critic and the
// contract. Each one has its own inputs and tools, and its structured output is computed from those tools (MCP
// read-only tools, direct contract reads, the SDK's Black-Scholes); Claude, when it runs, only chooses the plan and
// writes text that is labelled as narration. A stage the run never reached is recorded as "not-run" with the reason.

import type { LlmUsage } from "./usage.js";

/** The stages, in pipeline order. */
export const PIPELINE_STAGES = ["market", "risk", "planner", "critic", "contract"] as const;
export type PipelineStageName = (typeof PIPELINE_STAGES)[number];

/** What people call each stage. */
export const STAGE_TITLES: Record<PipelineStageName, string> = {
  market: "Market analyst",
  risk: "Risk analyst",
  planner: "Strike planner",
  critic: "Critic",
  contract: "Contract",
};

/**
 * A stage's verdict. "pass": its job is done and the run goes on. "modify": the critic changed the plan inside the
 * mandate (each change is in `output.modifications` with the value before and after) and the mandate check passed on
 * the changed plan. "fail": the stage stopped the run, which is a no-trade decision (for the contract: it rejected the
 * proposal). "not-run": the run never reached the stage; `summary` says why.
 */
export type StageVerdict = "pass" | "modify" | "fail" | "not-run";

/** Who did the stage's job: agent code ("rule"), Claude choosing the plan ("claude"), or the contract on-chain. */
export type StageBy = "rule" | "claude" | "contract";

/** One thing a stage read: an MCP tool, a contract function (with its address) or an SDK computation. */
export interface StageSource {
  kind: "mcp" | "contract" | "sdk";
  /** e.g. "risk_check", "StockOracle.status", "blackScholes". */
  name: string;
  /** The contract read (kind "contract" only). */
  address?: string;
  /** The chain read, when it is not the record's chain (Robinhood Chain mainnet for the Chainlink feed). */
  chainId?: number;
}

/** Text Claude wrote about a stage. Never a number the stage computed: those are in `output`. */
export interface StageNarration {
  by: "claude";
  /** "Claude via API, model X" or "Claude via Claude Code CLI, model X". */
  label: string;
  text: string;
}

export interface PipelineStage {
  stage: PipelineStageName;
  /** 1, or 2 for the planner and critic pass after a vetoed first plan. */
  attempt: number;
  verdict: StageVerdict;
  /** One sentence: the reason for the verdict. */
  summary: string;
  /** What the stage was given (from earlier stages, the mandate, flags). */
  inputs: Record<string, unknown>;
  /** What it computed, from its sources. Empty for a stage that did not run. */
  output: Record<string, unknown>;
  sources: StageSource[];
  /** Wall-clock time the stage took (0 when it did not run). */
  durationMs: number;
  by: StageBy;
  /** Claude's words, labelled; present only when Claude wrote any. */
  narration?: StageNarration;
  /**
   * What the Claude call behind this stage used (tokens, calls, time, and a price where the source gives one); the
   * planner stage of an `--llm` run only. The same figures as `decision.llm`.
   */
  usage?: LlmUsage;
}

/** A value a stage could not get, recorded as such instead of a default. */
export interface NotProvided {
  provided: false;
  reason: string;
}

export const notProvided = (reason: string): NotProvided => ({ provided: false, reason });

export const isNotProvided = (v: unknown): v is NotProvided =>
  typeof v === "object" && v !== null && (v as { provided?: unknown }).provided === false;

/** A stage the run did not reach. */
export function notRunStage(stage: PipelineStageName, reason: string, attempt = 1): PipelineStage {
  return {
    stage,
    attempt,
    verdict: "not-run",
    summary: reason,
    inputs: {},
    output: {},
    sources: [],
    durationMs: 0,
    by: stage === "contract" ? "contract" : "rule",
  };
}

/** Collects the stages of one run, times them, and fills in the stages it never reached. */
export class PipelineLog {
  readonly stages: PipelineStage[] = [];

  constructor(private readonly clock: () => number = () => Date.now()) {}

  /** Time `fn` and record the stage it returns (durationMs is set here). */
  async run(fn: () => Promise<Omit<PipelineStage, "durationMs">>): Promise<PipelineStage> {
    const start = this.clock();
    const stage = { ...(await fn()), durationMs: 0 };
    stage.durationMs = Math.max(0, Math.round(this.clock() - start));
    this.stages.push(stage);
    return stage;
  }

  add(stage: PipelineStage) {
    this.stages.push(stage);
  }

  /** True when some stage of this name has been recorded. */
  has(stage: PipelineStageName): boolean {
    return this.stages.some((s) => s.stage === stage);
  }

  /**
   * Every stage not yet recorded, as "not-run" with `reason`, so the record always lists all five. The stages stay in
   * the order they ran (a retry's planner and critic follow the vetoed ones); stages run in pipeline order, so the
   * ones never reached come last.
   */
  close(reason: string | ((stage: PipelineStageName) => string)) {
    for (const name of PIPELINE_STAGES)
      if (!this.has(name)) this.add(notRunStage(name, typeof reason === "string" ? reason : reason(name)));
  }
}
