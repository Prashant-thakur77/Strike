import Anthropic from "@anthropic-ai/sdk";
import { type MCPClientLike, mcpTools } from "@anthropic-ai/sdk/helpers/beta/mcp";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { Plan } from "./strategy.js";

/** The Claude model that plans each epoch. */
export const CLAUDE_MODEL = "claude-opus-5";

/** Read-only Strike tools Claude may call. It never gets propose_epoch: the agent code proposes. */
const PLANNING_TOOLS = new Set(["vault_state", "risk_check", "agent_stats", "quote"]);

const SYSTEM = `You are the strike-picking agent for a Strike options vault on Robinhood Chain. Each week the vault sells one option series on a stock token and pays the premium to its depositors in USDG.

Your job this epoch: choose the target |delta| (targetDeltaBps, 2000 = 0.20) and the premium factor (premiumBps, 10000 = 100% of Black-Scholes fair value) for the vault's proposal, and explain the choice to depositors.

How to work:
1. Call vault_state to read the vault, its mandate, spot, the next expiry and your agent's bond.
2. Dry-run candidates with risk_check (pass targetDeltaBps and premiumBps). Compare fair value, yield and delta.
3. Call submit_plan exactly once with a candidate that passed risk_check (ok: true).

Trade-offs: a lower delta is further out of the money (the stock is rarely called away or put to the vault) but earns less premium; a higher delta earns more but gives up more upside. A premium factor above 100% earns more per option but buyers pay more, so fewer options may sell. Stay inside the mandate with a margin: a proposal the contract rejects slashes your USDG bond.

The protocol's own guide for agents follows.

`;

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
}): Promise<Plan | null> {
  const anthropic = new Anthropic();
  const { tools } = await opts.mcp.listTools();
  const readTools = tools.filter((t) => PLANNING_TOOLS.has(t.name) && t.annotations?.readOnlyHint === true);
  const submitted: { plan?: Plan } = {};

  const submitPlan = betaZodTool({
    name: "submit_plan",
    description:
      "Submit this epoch's plan. Call once, after risk_check returned ok: true for the same targetDeltaBps and premiumBps.",
    inputSchema: z.object({
      targetDeltaBps: z.number().int().min(1).max(9999).describe("Target |delta| in bps of 1 (2000 = 0.20)"),
      premiumBps: z
        .number()
        .int()
        .min(1)
        .max(30_000)
        .describe("Premium as a share of fair value (10000 = 100%)"),
      reasoning: z
        .string()
        .min(1)
        .describe("Two to four sentences for the vault's depositors explaining the choice"),
    }),
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
    system: SYSTEM + opts.skill,
    tools: [...mcpTools(readTools, opts.mcp as unknown as MCPClientLike), submitPlan],
    messages: [
      {
        role: "user",
        content: `Plan this week's proposal for vault ${opts.vault}. Start with vault_state, dry-run with risk_check, then submit_plan.`,
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
  return err instanceof Error ? err.message : String(err);
}
