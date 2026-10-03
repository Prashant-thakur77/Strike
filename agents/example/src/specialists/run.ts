import { BPS, numberToWad } from "@strike/sdk";
import { keccak256, toBytes } from "viem";
import {
  type PlannerCall,
  candidateFromCheck,
  cleanError,
  plannerCandidates,
  runLadder,
} from "../candidates.js";
import type { Journal } from "../journal.js";
import {
  type NotProvided,
  PipelineLog,
  type PipelineStage,
  type PipelineStageName,
  STAGE_TITLES,
  type StageSource,
  isNotProvided,
} from "../pipeline.js";
import type { PlannerKind } from "../planner.js";
import {
  type Plan,
  type Profile,
  defaultPremiumBps,
  deterministicPlan,
  profileLabel,
  profilePlan,
} from "../strategy.js";
import type { ProposeResult, RiskCheck, VaultState } from "../types.js";
import {
  type Alternative,
  type CriticRule,
  DRIFT_LIMIT,
  type Modification,
  alternatives,
  confidence,
  criticRules,
  mandateModifications,
  sizeModification,
} from "./critic.js";
import { type Contradiction, type MarketBrief, type MarketReads, marketBrief } from "./market.js";
import { type PlannerChoice, claudeChoice, ruleChoice } from "./plan.js";
import { type RiskEngineReader, type RiskRow, type RiskTable, riskRow, riskTable } from "./risk.js";

// The propose run as a pipeline of specialists: market analyst -> risk analyst -> strike planner -> critic -> the
// contract. Each stage's output goes into the decision record (`decision.pipeline`); a stage that stops the run makes
// it a no-trade decision, recorded like any other, and the stages after it are recorded as not run.

/** What Claude's planner returned (through the API or Claude Code), with the risk_check calls it made. */
export type ClaudePlan =
  | { plan: Plan; kind: PlannerKind; model: string; label: string; calls: PlannerCall[] }
  | { plan: null; reason: string; calls: PlannerCall[] };

export interface PipelineOptions {
  /** --llm: Claude chooses the plan (planClaude must be given). */
  llm: boolean;
  profile: Profile;
  targetDelta: number;
  dryRun: boolean;
  /** --ignore-session (dry runs only): evaluate as if the NYSE were open; the record says so. */
  ignoreSession: boolean;
}

export interface PipelineDeps {
  state: VaultState;
  /** The MCP server's read-only risk_check (previewProposal). */
  riskCheck: (args: Record<string, unknown>) => Promise<RiskCheck>;
  readMarket: () => Promise<MarketReads>;
  riskEngine: (spotWad: bigint) => Promise<RiskEngineReader | NotProvided>;
  planClaude?: (context: string) => Promise<ClaudePlan>;
  /** propose_epoch; absent for a dry run. */
  propose?: (args: Record<string, unknown>) => Promise<ProposeResult>;
  journal: Journal;
  say: (line: string) => void;
  step: (title: string) => void;
  clock?: () => number;
}

export type PipelineOutcome =
  | { kind: "no-trade"; stage: PipelineStageName; reasons: string[] }
  | { kind: "dry-run"; check: RiskCheck }
  | { kind: "sent"; result: ProposeResult; check: RiskCheck };

/** A stage that stopped the run with an error (not a decision): recorded as fail, then rethrown. */
class StageError extends Error {
  constructor(
    readonly stage: PipelineStageName,
    message: string,
  ) {
    super(message);
  }
}

const dText = (bps: number) => (bps / BPS).toFixed(2);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The specialists' facts for Claude's prompt: computed numbers only, so Claude plans from what the tools measured. */
export function plannerContext(brief: MarketBrief, table: RiskTable): string {
  const rows = table.rows.map((r) => ({
    targetDeltaBps: r.targetDeltaBps,
    ok: r.ok,
    reason: r.reason,
    strike: r.strike,
    yieldBps: r.yieldBps,
    exerciseProbability: r.exerciseProbability === null ? null : Number(r.exerciseProbability.toFixed(4)),
    breakEvenDistance: r.breakEvenDistance === null ? null : Number(r.breakEvenDistance.toFixed(4)),
    stressShareOfCollateral: isNotProvided(r.stress) ? null : Number(r.stress.shareOfCollateral.toFixed(4)),
  }));
  return JSON.stringify(
    {
      marketBrief: {
        go: brief.go,
        reasons: brief.reasons,
        spot: brief.spot,
        sigma: brief.sigma.value,
        sessionWaived: brief.sessionWaived,
      },
      riskTable: { spot: table.spot, expiryIso: table.expiryIso, premiumBps: table.premiumBps, rows },
    },
    null,
    1,
  );
}

/** Contradictions in --llm mode: Claude's own last dry run of its plan against the critic's exact one. */
export function plannerContradictions(
  planner: ReturnType<typeof plannerCandidates>,
  check: RiskCheck,
): Contradiction[] {
  const own = [...planner]
    .reverse()
    .find(
      (c) =>
        c.ok &&
        c.strike !== null &&
        c.targetDeltaBps === check.proposal.targetDeltaBps &&
        c.premiumBps === check.proposal.premiumBps,
    );
  if (!own || own.strike === null) return [];
  const k0 = Number(own.strike);
  const k1 = Number(check.proposal.strike);
  const d = k0 > 0 ? Math.abs(k1 - k0) / k0 : 1;
  return [
    {
      between: ["Claude's own risk_check of its plan", "the critic's exact dry run"],
      agree: d <= DRIFT_LIMIT,
      measured: `strike $${own.strike} when Claude dry-ran it, $${check.proposal.strike} at the critic (${(d * 100).toFixed(2)}%)`,
      limit: `within ${(DRIFT_LIMIT * 100).toFixed(1)}%`,
    },
  ];
}

/** How many rungs the contract's dry run rejected, by reason (and how many could not be read). */
export function rejectionCounts(rows: RiskRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.ok) continue;
    const key = r.error !== undefined ? "unreadable" : (r.reason ?? "unknown");
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** The critic's approval goes stale after this long; a send after it needs a new pass. */
export const APPROVAL_TTL_MS = 120_000;

export interface PreflightCheck {
  check: "binding" | "approval-age" | "live-only";
  code: string;
  ok: boolean;
  measured: string;
  limit: string;
}

/**
 * The checks right before propose_epoch: the payload is exactly what the critic passed (bound by a keccak256 digest of
 * it), the critic's approval is recent, and no dry-run-only flag is on for a send.
 */
export function preflightChecks(input: {
  args: { vault: string; targetDeltaBps: number; premiumBps: number; size: string };
  approved: { targetDeltaBps: number; premiumBps: number; size: string; expiryIso: string };
  approvedAgeMs: number;
  ignoreSession: boolean;
  sending: boolean;
}): { proposalDigest: string; checks: PreflightCheck[] } {
  const { args, approved } = input;
  const proposalDigest = keccak256(
    toBytes(
      JSON.stringify({
        vault: args.vault,
        targetDeltaBps: approved.targetDeltaBps,
        premiumBps: approved.premiumBps,
        size: approved.size,
        expiryIso: approved.expiryIso,
      }),
    ),
  );
  const bound =
    args.targetDeltaBps === approved.targetDeltaBps &&
    args.premiumBps === approved.premiumBps &&
    args.size === approved.size;
  const checks: PreflightCheck[] = [
    {
      check: "binding",
      code: "PAYLOAD_MISMATCH",
      ok: bound,
      measured: bound
        ? `the payload is the critic's proposal (digest ${proposalDigest.slice(0, 10)}…)`
        : `payload ${args.targetDeltaBps} bps, ${args.premiumBps} bps, ${args.size} against the critic's ${approved.targetDeltaBps} bps, ${approved.premiumBps} bps, ${approved.size}`,
      limit: "exactly the delta, premium factor and size the critic passed",
    },
    {
      check: "approval-age",
      code: "APPROVAL_EXPIRED",
      ok: input.approvedAgeMs <= APPROVAL_TTL_MS,
      measured: `the critic passed it ${(input.approvedAgeMs / 1000).toFixed(1)} s ago`,
      limit: `at most ${APPROVAL_TTL_MS / 1000} s`,
    },
    {
      check: "live-only",
      code: "DRY_RUN_FLAG_ON_SEND",
      ok: !(input.sending && input.ignoreSession),
      measured: input.ignoreSession ? "--ignore-session is on" : "no dry-run-only flag",
      limit: "--ignore-session never goes with a send",
    },
  ];
  return { proposalDigest, checks };
}

/**
 * The decision note for a critic modification, in the wording the agent's notes have always used (the app reads the
 * size cap's), so a record's notes and its pipeline say the same thing.
 */
export function modificationNote(m: Modification, profile: Profile): string {
  if (m.field === "size")
    return `Profile "${profile.name}" capped the size at ${Math.round(profile.sizeShare * 100)}% of capacity: ${m.before} → ${m.after}.`;
  if (m.field === "targetDeltaBps")
    return `Mandate guard in the agent code adjusted the plan: target delta ${m.before} bps → ${m.after} bps (inside the mandate band).`;
  return `Mandate guard in the agent code adjusted the plan: premium ${m.before} bps → ${m.after} bps.`;
}

export async function runPipeline(opts: PipelineOptions, deps: PipelineDeps): Promise<PipelineOutcome> {
  const { state, journal, say, step } = deps;
  const mandate = state.vault.mandate;
  const vault = state.vault.address;
  const clock = deps.clock ?? (() => Date.now());
  const pipe = new PipelineLog(clock);
  journal.pipeline = pipe.stages;
  const ruleplan =
    opts.profile.name !== "default"
      ? profilePlan(opts.profile, mandate)
      : deterministicPlan(mandate, opts.targetDelta);

  /** Run a stage; an exception becomes a failed stage and stops the run. */
  const stage = async (
    name: PipelineStageName,
    attempt: number,
    fn: () => Promise<Omit<PipelineStage, "durationMs" | "stage" | "attempt">>,
  ): Promise<PipelineStage> => {
    try {
      return await pipe.run(async () => ({ stage: name, attempt, ...(await fn()) }));
    } catch (err) {
      if (err instanceof StageError) throw err;
      const message = cleanError(err);
      pipe.add({
        stage: name,
        attempt,
        verdict: "fail",
        summary: `could not run: ${message}`,
        inputs: {},
        output: { error: message },
        sources: [],
        durationMs: 0,
        by: name === "contract" ? "contract" : "rule",
      });
      pipe.close(`not run: the ${STAGE_TITLES[name].toLowerCase()} stopped with an error`);
      throw new StageError(name, `${STAGE_TITLES[name]}: ${message}`);
    }
  };

  /** End the run without a trade: record it, mark the later stages not run. */
  const noTrade = (
    at: PipelineStageName,
    reasons: string[],
    codes: string[],
    extra: { table?: RiskTable | null; exact?: RiskRow | null; contradictions?: Contradiction[] } = {},
  ): PipelineOutcome => {
    const title = at === "contract" ? "Preflight before sending" : STAGE_TITLES[at];
    const summary = `No trade this week: the ${title.toLowerCase()} stopped the run (${reasons.join("; ")}). Nothing was sent.`;
    say(summary);
    if (!journal.decision) {
      journal.decided({
        strategy: opts.llm ? "claude" : "default",
        targetDeltaBps: null,
        premiumBps: null,
        reasoning: summary,
        notes: [],
        ...(opts.llm
          ? {}
          : { planner: { kind: "rule", model: opts.profile.name, label: profileLabel(opts.profile) } }),
      });
    }
    journal.alternatives = alternatives({
      exact: extra.exact ?? null,
      table: extra.table ?? null,
      proposed: false,
    });
    journal.contradictions = extra.contradictions ?? journal.contradictions;
    journal.finish({
      status: "not-sent",
      summary,
      reason: "no-trade",
      noTrade: { stage: at, reasons, codes },
    });
    pipe.close((name) =>
      name === "contract"
        ? `not run: the ${title.toLowerCase()} stopped the run, so no proposal was sent`
        : `not run: the ${title.toLowerCase()} stopped the run before this stage`,
    );
    return { kind: "no-trade", stage: at, reasons };
  };

  try {
    // 1. Market analyst.
    step("Market analyst: may the agent trade this week?");
    let brief!: MarketBrief;
    await stage("market", 1, async () => {
      const reads = await deps.readMarket();
      brief = marketBrief(reads, { ignoreSession: opts.ignoreSession });
      for (const c of brief.checks)
        say(`${c.ok ? "ok  " : c.waived ? "WAIVED" : "FAIL"} ${c.check}: ${c.measured} (limit: ${c.limit})`);
      for (const c of brief.contradictions)
        if (!c.agree) say(`Contradiction: ${c.between.join(" vs ")}: ${c.measured} (limit: ${c.limit})`);
      const sources: StageSource[] = [{ kind: "mcp", name: "vault_state" }, ...reads.sources];
      return {
        verdict: brief.go ? "pass" : "fail",
        summary: brief.go ? `Go: ${brief.reasons.join("; ")}.` : `No-go: ${brief.reasons.join("; ")}.`,
        inputs: { vault, underlying: reads.token, ignoreSession: opts.ignoreSession, mcpSpot: reads.mcpSpot },
        output: brief as unknown as Record<string, unknown>,
        sources,
        by: "rule",
      };
    });
    journal.contradictions = brief.contradictions;
    if (!brief.go)
      return noTrade("market", brief.reasons, brief.codes, { contradictions: brief.contradictions });

    // 2. Risk analyst.
    const ladderPremium = opts.llm ? defaultPremiumBps(mandate) : ruleplan.premiumBps;
    step("Risk analyst: the ladder through risk_check, greeks and the ±30% stress from the risk engine");
    let table!: RiskTable;
    let engine!: RiskEngineReader | NotProvided;
    await stage("risk", 1, async () => {
      const raws: RiskCheck[] = [];
      const ladder = await runLadder({
        call: async (args) => {
          const r = await deps.riskCheck({ vault, ...args });
          raws.push(r);
          return r;
        },
        mandate,
        blockTimeIso: state.blockTimeIso,
        premiumBps: ladderPremium,
        chosenDeltaBps: opts.llm ? null : ruleplan.targetDeltaBps,
      });
      journal.ladderDryRuns(ladder);
      const ref = raws.find((r) => r && typeof r.spot === "string" && r.proposal?.expiryIso);
      if (!ref)
        throw new Error(`no rung of the ladder could be dry-run (${ladder[0]?.error ?? "no result"})`);
      const spot = Number(ref.spot);
      engine = await deps.riskEngine(numberToWad(spot));
      table = await riskTable({
        ladder,
        engine,
        spot,
        sigma: brief.sigma.value,
        nowSec: Date.parse(brief.chainTimeIso) / 1000,
        expirySec: Date.parse(ref.proposal.expiryIso) / 1000,
        isCall: ref.isCall,
        premiumBps: ladderPremium,
      });
      const accepted = table.rows.filter((r) => r.ok).length;
      for (const r of table.rows) {
        if (r.targetDeltaBps === null) continue;
        const stress = isNotProvided(r.stress)
          ? "stress not provided"
          : `±30% stress $${r.stress.worstLossUsd} (${pct(r.stress.shareOfCollateral)} of collateral)`;
        say(
          `${dText(r.targetDeltaBps)} delta: ${r.error ? `could not dry-run (${r.error})` : `${r.ok ? "inside" : `outside (${r.reason})`}, strike $${r.strike}, yield ${((r.yieldBps ?? 0) / 100).toFixed(2)}%, P(exercise) ${r.exerciseProbability === null ? "?" : pct(r.exerciseProbability)}, ${stress}`}`,
        );
      }
      const sources: StageSource[] = [
        { kind: "mcp", name: "risk_check" },
        ...(isNotProvided(engine)
          ? []
          : [
              { kind: "contract" as const, name: "IRiskEngine.greeks", address: engine.address },
              { kind: "contract" as const, name: "IRiskEngine.scenarioLoss", address: engine.address },
            ]),
        { kind: "sdk", name: "normCdf (model probability of exercise)" },
      ];
      return {
        verdict: accepted > 0 ? "pass" : "fail",
        summary:
          accepted > 0
            ? `${table.rows.length} rungs dry-run, ${accepted} inside the mandate; greeks and stress ${isNotProvided(engine) ? `not provided (${engine.reason})` : `from the risk engine at ${engine.address}`}.`
            : `None of the ${table.rows.length} rungs is inside the mandate.`,
        inputs: { vault, premiumBps: ladderPremium, mandate: mandate.summary, sigma: brief.sigma.value },
        output: { ...table, rejections: rejectionCounts(table.rows) } as unknown as Record<string, unknown>,
        sources,
        by: "rule",
      };
    });
    if (!table.rows.some((r) => r.ok))
      return noTrade("risk", ["no rung of the ladder is inside the mandate"], ["NO_RUNG_IN_MANDATE"], {
        table,
        contradictions: brief.contradictions,
      });

    // 3. Strike planner.
    let choice: PlannerChoice | null = null;
    let plannerCands: ReturnType<typeof plannerCandidates> = [];
    const fallbackNotes: string[] = [];
    step(
      opts.llm
        ? "Strike planner: Claude chooses from the ladder (read-only tools)"
        : `Strike planner: ${profileLabel(opts.profile)}`,
    );
    await stage("planner", 1, async () => {
      if (opts.llm && deps.planClaude) {
        const res = await deps.planClaude(plannerContext(brief, table));
        plannerCands = plannerCandidates(res.calls, mandate, state.blockTimeIso);
        if (plannerCands.length > 0) journal.plannerDryRuns(plannerCands);
        if (res.plan) {
          choice = claudeChoice(table.rows, res.plan);
          journal.decided({
            strategy: "claude",
            targetDeltaBps: choice.targetDeltaBps,
            premiumBps: choice.premiumBps,
            reasoning: res.plan.reasoning,
            notes: [`${res.label}.`],
            planner: { kind: res.kind, model: res.model, label: res.label },
          });
          say(
            `Claude's plan: ${dText(choice.targetDeltaBps)} delta at ${(choice.premiumBps / 100).toFixed(0)}% of fair value`,
          );
          return {
            verdict: "pass",
            summary: choice.reason,
            inputs: {
              ladderRungs: table.rows.length,
              mandate: mandate.summary,
              context: "market brief and risk table",
            },
            output: choice as unknown as Record<string, unknown>,
            sources: [
              { kind: "mcp", name: "vault_state" },
              { kind: "mcp", name: "risk_check" },
            ],
            by: "claude",
            narration: { by: "claude", label: res.label, text: res.plan.reasoning },
          };
        }
        say(`Claude gave no plan (${res.reason}); the rule planner chooses.`);
        fallbackNotes.push(`Claude gave no plan (${res.reason}); the agent used the default strategy.`);
      }
      choice = ruleChoice(table.rows, ruleplan);
      journal.decided({
        strategy: "default",
        targetDeltaBps: choice?.targetDeltaBps ?? null,
        premiumBps: choice?.premiumBps ?? null,
        reasoning: ruleplan.reasoning,
        notes: fallbackNotes,
        planner: { kind: "rule", model: opts.profile.name, label: profileLabel(opts.profile) },
      });
      if (choice) say(choice.reason);
      return {
        verdict: choice ? "pass" : "fail",
        summary: choice ? choice.reason : "no accepted rung to choose",
        inputs: {
          profile: opts.profile.name,
          desiredDeltaBps: ruleplan.targetDeltaBps,
          premiumBps: ruleplan.premiumBps,
          ladderRungs: table.rows.length,
        },
        output: (choice ?? {}) as Record<string, unknown>,
        sources: [{ kind: "sdk", name: `profile ${opts.profile.name}` }],
        by: "rule",
      };
    });
    if (!choice)
      return noTrade("planner", ["no accepted rung to choose"], ["NO_RUNG_TO_CHOOSE"], {
        table,
        contradictions: brief.contradictions,
      });

    // 4. Critic (and one retry, further out of the money, after a mandate or cushion veto).
    const critic = async (c: PlannerChoice, attempt: number) => {
      step(
        `Critic${attempt > 1 ? " (retry)" : ""}: check the plan against the mandate and the analysts' numbers`,
      );
      let result!: {
        approvedAt: number;
        verdict: "pass" | "modify" | "fail";
        check: RiskCheck;
        exact: RiskRow;
        plan: PlannerChoice;
        rules: CriticRule[];
      };
      await stage("critic", attempt, async () => {
        const { choice: modified, modifications } = mandateModifications(c, mandate);
        const args = (size?: string | null) => ({
          vault,
          targetDeltaBps: modified.targetDeltaBps,
          premiumBps: modified.premiumBps,
          ...(size ? { size } : {}),
        });
        let check = await deps.riskCheck(args(modified.size));
        const sizeMod: Modification | null = sizeModification(
          check.proposal.size,
          check.measured.capacity,
          opts.profile.sizeShare,
          opts.profile.name,
        );
        if (sizeMod) {
          modifications.push(sizeMod);
          check = await deps.riskCheck(args(String(sizeMod.after))); // the mandate check again, on the changed plan
        }
        journal.dryRan(check);
        const exactCand = candidateFromCheck("ladder", check, mandate, state.blockTimeIso);
        const exact = await riskRow(
          exactCand,
          {
            spot: Number(check.spot),
            sigma: table.sigma,
            tenorSeconds: table.tenorSeconds,
            isCall: check.isCall,
          },
          engine,
        );
        const tableRow =
          table.rows.find(
            (r) =>
              r.targetDeltaBps === modified.targetDeltaBps &&
              r.premiumBps === modified.premiumBps &&
              !r.error,
          ) ?? null;
        const rules = criticRules({
          brief,
          check,
          exact,
          tableRow,
          table,
          failedRule: exactCand.failedRule,
          cushionSigmas: opts.profile.cushionSigmas,
        });
        for (const m of modifications) say(`MODIFY ${m.field}: ${m.before} -> ${m.after} (${m.reason})`);
        for (const r of rules) say(`${r.ok ? "ok  " : "VETO"} ${r.rule}: ${r.measured} (limit: ${r.limit})`);
        const vetoes = rules.filter((r) => !r.ok);
        const verdict = vetoes.length > 0 ? "fail" : modifications.length > 0 ? "modify" : "pass";
        const plan = { ...modified, size: check.proposal.size, strike: check.proposal.strike };
        result = { verdict, check, exact, plan, rules, approvedAt: clock() };
        const conf = confidence(exact, table);
        return {
          verdict,
          summary:
            verdict === "fail"
              ? `Veto: ${vetoes.map((v) => `${v.rule} (${v.measured}; limit ${v.limit})`).join("; ")}.`
              : verdict === "modify"
                ? `Modified inside the mandate (${modifications.map((m) => `${m.field} ${m.before} -> ${m.after}`).join(", ")}), and all ${rules.length} rules pass on the changed plan.`
                : `All ${rules.length} rules pass.`,
          inputs: { plan: c, attempt, profile: opts.profile.name, marketGo: brief.go },
          output: {
            proposal: {
              targetDeltaBps: plan.targetDeltaBps,
              premiumBps: plan.premiumBps,
              strike: check.proposal.strike,
              size: check.proposal.size,
              expiryIso: check.proposal.expiryIso,
            },
            modifications,
            rules,
            veto: vetoes.map((v) => v.rule),
            exact,
            confidence: conf,
          },
          sources: [
            { kind: "mcp", name: "risk_check" },
            ...(isNotProvided(engine)
              ? []
              : [
                  { kind: "contract" as const, name: "IRiskEngine.greeks", address: engine.address },
                  { kind: "contract" as const, name: "IRiskEngine.scenarioLoss", address: engine.address },
                ]),
          ],
          by: "rule",
        };
      });
      return result;
    };

    let verdict = await critic(choice, 1);
    if (verdict.verdict === "fail") {
      const vetoed = verdict.rules.filter((r) => !r.ok).map((r) => r.rule);
      const retryable = vetoed.every((r) => r === "mandate" || r === "cushion");
      if (!retryable) {
        return noTrade(
          "critic",
          verdict.rules.filter((r) => !r.ok).map((r) => `${r.rule}: ${r.measured}`),
          verdict.rules.filter((r) => !r.ok).map((r) => r.code),
          {
            table,
            exact: verdict.exact,
            contradictions: brief.contradictions,
          },
        );
      }
      step("Strike planner (retry): the next accepted rung further out of the money");
      const first: PlannerChoice = verdict.plan;
      let retry: PlannerChoice | null = null;
      await stage("planner", 2, async () => {
        retry = ruleChoice(
          table.rows,
          { ...ruleplan, targetDeltaBps: first.targetDeltaBps, premiumBps: first.premiumBps },
          { below: first.targetDeltaBps },
        );
        if (retry) say(retry.reason);
        return {
          verdict: retry ? "pass" : "fail",
          summary: retry ? retry.reason : `no accepted rung below ${dText(first.targetDeltaBps)} delta`,
          inputs: {
            vetoed: vetoed,
            previous: { targetDeltaBps: first.targetDeltaBps, premiumBps: first.premiumBps },
          },
          output: (retry ?? {}) as Record<string, unknown>,
          sources: [{ kind: "sdk", name: "the risk table" }],
          by: "rule",
        };
      });
      if (!retry) {
        return noTrade(
          "critic",
          verdict.rules.filter((r) => !r.ok).map((r) => `${r.rule}: ${r.measured}`),
          verdict.rules.filter((r) => !r.ok).map((r) => r.code),
          {
            table,
            exact: verdict.exact,
            contradictions: brief.contradictions,
          },
        );
      }
      journal.note(
        `The critic vetoed ${dText(first.targetDeltaBps)} delta (${vetoed.join(", ")}); the planner retried further out of the money.`,
      );
      verdict = await critic(retry, 2);
      if (verdict.verdict === "fail") {
        return noTrade(
          "critic",
          verdict.rules.filter((r) => !r.ok).map((r) => `${r.rule}: ${r.measured}`),
          verdict.rules.filter((r) => !r.ok).map((r) => r.code),
          {
            table,
            exact: verdict.exact,
            contradictions: brief.contradictions,
          },
        );
      }
    }

    // The plan the critic passed is the proposal.
    const final = verdict.plan;
    const check = verdict.check;
    if (journal.decision) {
      for (const m of (pipe.stages.at(-1)?.output.modifications as Modification[] | undefined) ?? [])
        journal.note(modificationNote(m, opts.profile));
      journal.decision.targetDeltaBps = final.targetDeltaBps;
      journal.decision.premiumBps = final.premiumBps;
    }
    journal.chose({ targetDeltaBps: final.targetDeltaBps, premiumBps: final.premiumBps });
    journal.alternatives = alternatives({ exact: verdict.exact, table, proposed: !opts.dryRun });
    journal.confidence = confidence(verdict.exact, table);
    journal.contradictions = [...brief.contradictions, ...plannerContradictions(plannerCands, check)];

    // 5. The contract. The payload is bound to what the critic passed, by a digest the record keeps.
    const args = {
      vault,
      targetDeltaBps: final.targetDeltaBps,
      size: check.proposal.size,
      premiumBps: final.premiumBps,
    };
    const preflight = preflightChecks({
      args,
      approved: {
        targetDeltaBps: final.targetDeltaBps,
        premiumBps: final.premiumBps,
        size: check.proposal.size,
        expiryIso: check.proposal.expiryIso,
      },
      approvedAgeMs: clock() - verdict.approvedAt,
      ignoreSession: opts.ignoreSession,
      sending: !(opts.dryRun || !deps.propose),
    });
    const contractInputs = { ...args, expiryIso: check.proposal.expiryIso, preflight };
    if (opts.dryRun || !deps.propose) {
      const why = opts.ignoreSession
        ? "dry run with --ignore-session (evaluated as if the NYSE were open): nothing was sent"
        : "dry run (--dry-run): the plan passed the critic and was not sent";
      say(`${why}.`);
      pipe.add({
        stage: "contract",
        attempt: 1,
        verdict: "not-run",
        summary: `not run: ${why}`,
        inputs: contractInputs,
        output: {},
        sources: [],
        durationMs: 0,
        by: "contract",
      });
      journal.alternatives = alternatives({ exact: verdict.exact, table, proposed: false });
      journal.finish({
        status: "not-sent",
        summary: opts.ignoreSession
          ? "Dry run only (--dry-run --ignore-session, evaluated as if the NYSE were open): the plan passed every specialist and was not sent."
          : "Dry run only (--dry-run): the plan passed every specialist and the risk check, and was not sent.",
        strike: check.proposal.strike,
        expiryIso: check.proposal.expiryIso,
        size: check.proposal.size,
      });
      return { kind: "dry-run", check };
    }
    const failedPreflight = preflight.checks.filter((c) => !c.ok);
    if (failedPreflight.length > 0) {
      pipe.add({
        stage: "contract",
        attempt: 1,
        verdict: "not-run",
        summary: `not run: the preflight before sending failed (${failedPreflight.map((c) => c.check).join(", ")})`,
        inputs: contractInputs,
        output: {},
        sources: [],
        durationMs: 0,
        by: "contract",
      });
      return noTrade(
        "contract",
        failedPreflight.map((c) => `${c.check}: ${c.measured}`),
        failedPreflight.map((c) => c.code),
        { table, exact: verdict.exact, contradictions: journal.contradictions ?? [] },
      );
    }
    step("Contract: propose on-chain (proposeByDelta); the mandate is enforced again there");
    let sent!: ProposeResult;
    await stage("contract", 1, async () => {
      sent = await deps.propose!(args);
      journal.proposed(sent, "proposeByDelta", check.proposal.expiryIso);
      return {
        verdict: sent.accepted ? "pass" : "fail",
        summary: sent.accepted
          ? `Accepted: series ${sent.seriesId} on sale.`
          : sent.submitted
            ? `Rejected on-chain (${sent.reason}); ${sent.slashed} USDG slashed from the bond.`
            : `Not submitted: ${sent.reason}.`,
        inputs: contractInputs,
        output: {
          submitted: sent.submitted,
          accepted: sent.accepted,
          reason: sent.reason,
          seriesId: sent.seriesId,
          strike: sent.strike,
          size: sent.size,
          slashed: sent.slashed,
          txHash: sent.txHash,
          openTxHash: sent.openTxHash,
        },
        sources: [{ kind: "mcp", name: "propose_epoch" }],
        by: "contract",
      };
    });
    return { kind: "sent", result: sent, check };
  } catch (err) {
    if (err instanceof StageError) throw new Error(err.message);
    pipe.close("not run: the run stopped with an error");
    throw err;
  }
}

export type { Alternative };
