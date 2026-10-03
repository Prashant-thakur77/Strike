import { type NotProvided, notProvided } from "./pipeline.js";

// What a Claude call cost, as the API or the Claude Code stream reported it: tokens, calls, time and, where the
// source gives one, a price. Nothing is estimated here. A figure the source did not report is recorded as
// `{ provided: false, reason }`, never as 0. The record keeps it as `decision.llm` and on the planner stage's `usage`.

/** A count the source reported, or why it is missing. */
export type Counted = number | NotProvided;

export interface LlmUsage {
  planner: "api" | "claude-code";
  model: string;
  /** Model requests: the API's responses, or Claude Code's `num_turns`. */
  calls: Counted;
  inputTokens: Counted;
  outputTokens: Counted;
  cacheReadTokens?: Counted;
  cacheCreationTokens?: Counted;
  /** Claude Code's `total_cost_usd` (its own estimate at list prices); the Messages API reports no price. */
  costUsd?: Counted;
  durationMs: Counted;
  /** Where the figures come from, in words. */
  source: string;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** One Messages API response's usage block (the fields the tally reads). */
export interface ApiUsageBlock {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

/** Adds up the `usage` of each Messages API response of one planning run. */
export class ApiUsageTally {
  private readonly responses: { usage: ApiUsageBlock | null; model: string | null }[] = [];

  /** Add one response (its `usage` and `model`). */
  add(message: { usage?: ApiUsageBlock | null; model?: unknown }) {
    this.responses.push({
      usage: message.usage && typeof message.usage === "object" ? message.usage : null,
      model: typeof message.model === "string" && message.model ? message.model : null,
    });
  }

  get calls(): number {
    return this.responses.length;
  }

  /** The usage, or null when no response came back (nothing was spent that the API reported). */
  toUsage(requestedModel: string, durationMs: number): LlmUsage | null {
    const n = this.responses.length;
    if (n === 0) return null;
    const total = (key: keyof ApiUsageBlock, what: string): Counted => {
      const values = this.responses.map((r) => r.usage?.[key]);
      if (values.every(finite)) return values.reduce<number>((a, b) => a + (b as number), 0);
      const missing = values.filter((v) => !finite(v)).length;
      return notProvided(`${missing} of ${n} API responses did not report ${what}`);
    };
    return {
      planner: "api",
      model: [...this.responses].reverse().find((r) => r.model)?.model ?? requestedModel,
      calls: n,
      inputTokens: total("input_tokens", "input_tokens"),
      outputTokens: total("output_tokens", "output_tokens"),
      cacheReadTokens: total("cache_read_input_tokens", "cache_read_input_tokens"),
      cacheCreationTokens: total("cache_creation_input_tokens", "cache_creation_input_tokens"),
      costUsd: notProvided("the Messages API reports tokens, not a price"),
      durationMs: Math.max(0, Math.round(durationMs)),
      source: `Messages API usage objects, summed over ${n} response${n === 1 ? "" : "s"}; durationMs is the agent's own clock around the planning call`,
    };
  }
}

const NO_RESULT = "the Claude Code run ended without a result message";

/**
 * The usage from a Claude Code `stream-json` run. `result` is the final `result` message (null when the stream
 * ended without one): its `usage` block, `total_cost_usd`, `num_turns` and `duration_ms`.
 */
export function claudeCodeUsage(result: Record<string, unknown> | null, model: string): LlmUsage {
  const usage =
    result && typeof result.usage === "object" && result.usage !== null
      ? (result.usage as Record<string, unknown>)
      : null;
  const pick = (from: Record<string, unknown> | null, key: string, what: string): Counted => {
    if (!result) return notProvided(NO_RESULT);
    const v = from?.[key];
    return finite(v) ? v : notProvided(`the result message has no ${what}`);
  };
  return {
    planner: "claude-code",
    model,
    calls: pick(result, "num_turns", "num_turns"),
    inputTokens: pick(usage, "input_tokens", "usage.input_tokens"),
    outputTokens: pick(usage, "output_tokens", "usage.output_tokens"),
    cacheReadTokens: pick(usage, "cache_read_input_tokens", "usage.cache_read_input_tokens"),
    cacheCreationTokens: pick(usage, "cache_creation_input_tokens", "usage.cache_creation_input_tokens"),
    costUsd: pick(result, "total_cost_usd", "total_cost_usd"),
    durationMs: pick(result, "duration_ms", "duration_ms"),
    source:
      "Claude Code stream-json result message (usage, num_turns, duration_ms, total_cost_usd); total_cost_usd is Claude Code's own estimate at list prices, not a bill",
  };
}

/** A short line for people: "12 calls, 41,230 input and 2,114 output tokens, $0.41, 38 s". */
export function usageText(u: LlmUsage): string {
  const fmt = (c: Counted | undefined, unit: string) =>
    typeof c === "number" ? `${c.toLocaleString("en-US")} ${unit}` : c ? `${unit} not provided` : null;
  const parts = [
    typeof u.calls === "number" ? `${u.calls} call${u.calls === 1 ? "" : "s"}` : "calls not provided",
    fmt(u.inputTokens, "input tokens"),
    fmt(u.outputTokens, "output tokens"),
    typeof u.cacheReadTokens === "number" ? fmt(u.cacheReadTokens, "cache-read tokens") : null,
    typeof u.cacheCreationTokens === "number" ? fmt(u.cacheCreationTokens, "cache-creation tokens") : null,
    typeof u.costUsd === "number" ? `$${u.costUsd.toFixed(4)} (Claude Code's list-price estimate)` : null,
    typeof u.durationMs === "number" ? `${(u.durationMs / 1000).toFixed(1)} s` : null,
  ];
  return parts.filter((p): p is string => p !== null).join(", ");
}
