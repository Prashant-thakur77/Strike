import { claudeCodeAvailable } from "./claudeCode.js";

/** How `--llm` reaches Claude: the Anthropic API (an API key) or the Claude Code CLI (a Pro/Max subscription). */
export type PlannerKind = "api" | "claude-code";

export const PLANNER_KINDS: readonly PlannerKind[] = ["api", "claude-code"];

/** Parse `--planner`. */
export function parsePlanner(value: string | undefined): PlannerKind | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "api" || v === "claude-code") return v;
  throw new Error(`--planner must be "api" or "claude-code", got "${value}"`);
}

/**
 * Which planner `--llm` uses: the forced one, else the API when ANTHROPIC_API_KEY is set, else Claude Code when the
 * `claude` CLI is on PATH (or CLAUDE_CODE_OAUTH_TOKEN is set). Null, with a reason, when neither is available.
 */
export function selectPlanner(
  forced: PlannerKind | undefined,
  env: NodeJS.ProcessEnv = process.env,
  hasClaudeCode: (env: NodeJS.ProcessEnv) => boolean = claudeCodeAvailable,
): { kind: PlannerKind; reason: null } | { kind: null; reason: string } {
  if (forced) return { kind: forced, reason: null };
  if (env.ANTHROPIC_API_KEY?.trim()) return { kind: "api", reason: null };
  if (hasClaudeCode(env)) return { kind: "claude-code", reason: null };
  return {
    kind: null,
    reason:
      "no Claude credentials: set ANTHROPIC_API_KEY, or install Claude Code (`claude`) and log in with a Claude subscription",
  };
}

/** How the record names the planner: "Claude via API, model X" or "Claude via Claude Code CLI, model X". */
export function plannerLabel(kind: PlannerKind, model: string): string {
  return `Claude via ${kind === "api" ? "API" : "Claude Code CLI"}, model ${model}`;
}
