import Anthropic from "@anthropic-ai/sdk";
import { type MCPClientLike, mcpTools } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { type PlannerCall, cleanError } from "./candidates.js";
import type { Plan } from "./strategy.js";

/** The Claude model that plans each epoch. */
export const CLAUDE_MODEL = "claude-opus-5";

/** Read-only Strike tools Claude may call. It never gets propose_epoch: the agent code proposes. */
export const PLANNING_TOOLS: ReadonlySet<string> = new Set([
  "vault_state",
  "risk_check",
  "agent_stats",
  "quote",
]);

/** The plan Claude hands back (submit_plan's input here, the structured output with Claude Code). */
export const planSchema = z.object({
  targetDeltaBps: z.number().int().min(1).max(9999).describe("Target |delta| in bps of 1 (2000 = 0.20)"),
  premiumBps: z.number().int().min(1).max(30_000).describe("Premium as a share of fair value (10000 = 100%)"),
  reasoning: z
    .string()
    .min(1)
    .describe("Two to four sentences for the vault's depositors explaining the choice"),
});

/** The planning instructions; `finish` is step 3 (how Claude hands the plan back), then the protocol's skill. */
export function planningSystem(finish: string, skill: string): string {
  return `You are the strike-picking agent for a Strike options vault on Robinhood Chain. Each week the vault sells one option series on a stock token and pays the premium to its depositors in USDG.

Your job this epoch: choose the target |delta| (targetDeltaBps, 2000 = 0.20) and the premium factor (premiumBps, 10000 = 100% of Black-Scholes fair value) for the vault's proposal, and explain the choice to depositors.

How to work:
1. Call vault_state to read the vault, its mandate, spot, the next expiry and your agent's bond.
2. Dry-run candidates with risk_check (pass targetDeltaBps and premiumBps). Compare fair value, yield and delta.
3. ${finish}

Trade-offs: a lower delta is further out of the money (the stock is rarely called away or put to the vault) but earns less premium; a higher delta earns more but gives up more upside. A premium factor above 100% earns more per option but buyers pay more, so fewer options may sell. Stay inside the mandate with a margin: a proposal the contract rejects slashes your USDG bond.

The protocol's own guide for agents follows.

${skill}`;
}

/**
 * The planning request, with the specialists' facts when there are any: the market analyst's brief and the risk
 * analyst's table, computed from tools. Claude chooses from them; the critic then checks its choice.
 */
export function plannerPrompt(base: string, context?: string): string {
  if (!context) return base;
  return `${base}

The agent's market analyst and risk analyst already measured this week with the same read-only tools and the risk engine contract. Their results follow as JSON (computed, not estimated). Choose a rung inside the mandate (ok: true), weighing yield against the model probability of exercise, the break-even distance and the ±30% stress share of collateral. An independent critic re-checks your choice before anything is sent.

${context}`;
}

/** The structured result of an MCP tool call, or the JSON in its text. Null when there is neither. */
export function toolResultData(res: { structuredContent?: unknown; content?: unknown }): unknown {
  if (res.structuredContent !== undefined && res.structuredContent !== null) return res.structuredContent;
  const parts = Array.isArray(res.content) ? (res.content as { type?: string; text?: string }[]) : [];
  const text = parts.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The text of an MCP tool error, for the record. */
export function toolErrorText(res: { content?: unknown }): string {
  const parts = Array.isArray(res.content) ? (res.content as { type?: string; text?: string }[]) : [];
  return cleanError(parts.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join(" ") || "tool error");
}

/**
 * The MCP client Claude's tool loop calls through, reporting every `risk_check` call (its arguments and its result
 * or error) to `capture` before handing the result back unchanged. The record keeps these as Claude's candidates.
 */
export function capturingClient(client: Client, capture: (call: PlannerCall) => void): MCPClientLike {
  return {
    listTools: () => client.listTools(),
    callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => {
      const input = (params.arguments ?? {}) as Record<string, unknown>;
      let res: Awaited<ReturnType<Client["callTool"]>>;
      try {
        res = await client.callTool(params);
      } catch (err) {
        if (params.name === "risk_check") {
          capture({ tool: "risk_check", input, result: null, error: cleanError(err) });
        }
        throw err;
      }
      if (params.name === "risk_check") {
        const r = res as { isError?: boolean; content?: unknown; structuredContent?: unknown };
        capture(
          r.isError
            ? { tool: "risk_check", input, result: null, error: toolErrorText(r) }
            : { tool: "risk_check", input, result: toolResultData(r), error: null },
        );
      }
      return res;
    },
  } as unknown as MCPClientLike;
}

/** Where Claude's reasoning and tool calls are printed. */
export type Narrate = (line: string) => void;

/**
 * Let Claude choose this epoch's target delta and premium factor, using the Strike MCP server's read-only tools
 * (tool results are fed back to it by the SDK's tool runner). Returns null if Claude declines or submits no plan.
 */
export async function planWithClaude(opts: {
  mcp: Client;
  vault: string;
  skill: string;
  narrate: Narrate;
  /** Called with each `risk_check` Claude makes (arguments and result), for the decision record. */
  capture?: (call: PlannerCall) => void;
  /** The specialists' computed facts (market brief, risk table) to plan from; see {@link plannerPrompt}. */
  context?: string;
}): Promise<Plan | null> {
  const anthropic = new Anthropic();
  const { tools } = await opts.mcp.listTools();
  const readTools = tools.filter((t) => PLANNING_TOOLS.has(t.name) && t.annotations?.readOnlyHint === true);
  const submitted: { plan?: Plan } = {};

  const submitPlan = betaZodTool({
    name: "submit_plan",
    description:
      "Submit this epoch's plan. Call once, after risk_check returned ok: true for the same targetDeltaBps and premiumBps.",
    inputSchema: planSchema,
    run: (input) => {
      submitted.plan = input;
      return "Plan recorded. The agent will dry-run it once more and propose it.";
    },
  });

  const runner = anthropic.beta.messages.toolRunner({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: planningSystem(
      "Call submit_plan exactly once with a candidate that passed risk_check (ok: true).",
      opts.skill,
    ),
    tools: [
      ...mcpTools(
        readTools,
        opts.capture ? capturingClient(opts.mcp, opts.capture) : (opts.mcp as unknown as MCPClientLike),
      ),
      submitPlan,
    ],
    messages: [
      {
        role: "user",
        content: plannerPrompt(
          `Plan this week's proposal for vault ${opts.vault}. Start with vault_state, dry-run with risk_check, then submit_plan.`,
          opts.context,
        ),
      },
    ],
    max_iterations: 12,
  });

  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) opts.narrate(`Claude: ${block.text.trim()}`);
      else if (block.type === "tool_use")
        opts.narrate(`Claude calls ${block.name} ${JSON.stringify(block.input)}`);
      else if (block.type === "fallback")
        opts.narrate(`(${block.from.model} declined; ${block.to.model} continued)`);
    }
    if (message.stop_reason === "refusal") {
      opts.narrate("Claude declined to plan this epoch.");
      return null;
    }
  }
  return submitted.plan ?? null;
}

/** A short, human reason for an Anthropic API failure (typed errors, most specific first). */
export function describeClaudeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "authentication failed (check ANTHROPIC_API_KEY)";
  if (err instanceof Anthropic.RateLimitError) return "rate limited by the Claude API";
  if (err instanceof Anthropic.APIConnectionError) return "could not reach the Claude API";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  const message = err instanceof Error ? err.message : String(err);
  // The SDK throws a long configuration error when no key is set; say that plainly.
  if (/authentication method|apiKey|X-Api-Key/i.test(message)) return "no ANTHROPIC_API_KEY is set";
  return message;
}
