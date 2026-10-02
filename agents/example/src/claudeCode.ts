import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { CLAUDE_MODEL, type Narrate, PLANNING_TOOLS, planSchema, planningSystem } from "./llm.js";
import type { Plan } from "./strategy.js";

// The Claude Code planner: the same planning job as planWithClaude (llm.ts), run by the `claude` CLI in print mode,
// so a Claude Pro/Max subscription (`claude` logged in, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`) pays
// for it instead of an API key. Claude Code gets the Strike MCP server's read-only planning tools and nothing else:
// no built-in tools (Bash, Edit, Write, WebFetch...), no other MCP servers, no settings, hooks or CLAUDE.md files.

/** The name the Strike MCP server gets in Claude Code's config; its tools are `mcp__strike__<tool>`. */
export const MCP_SERVER_NAME = "strike";

/** The tools Claude Code may call: exactly the read-only planning tools (never propose_epoch or other writes). */
export const CLAUDE_CODE_TOOLS = [...PLANNING_TOOLS].map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

/** Default limit on one planning run. */
export const CLAUDE_CODE_TIMEOUT_MS = 6 * 60_000;

/** Default limit on Claude's turns (each tool call is one). */
export const CLAUDE_CODE_MAX_TURNS = 16;

/** Where Claude Code reaches the Strike MCP server. */
export type PlannerMcp =
  /** Start the server locally over stdio (the agent's own chain and RPC), with only the read-only tools. */
  | { kind: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd: string }
  /** A read-only Streamable HTTP endpoint, e.g. https://strike-options.vercel.app/api/mcp (testnet). */
  | { kind: "http"; url: string };

export interface ClaudeCodeOptions {
  vault: string;
  skill: string;
  narrate: Narrate;
  mcp: PlannerMcp;
  /** Model alias or name for `--model` (default {@link CLAUDE_MODEL}). */
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  /** The `claude` executable (default: CLAUDE_CODE_PATH, else `claude` on PATH). */
  claudePath?: string;
  /** Environment the CLI inherits (default process.env; secrets are removed, see {@link claudeCodeEnv}). */
  env?: NodeJS.ProcessEnv;
  /** For tests. */
  spawn?: typeof nodeSpawn;
}

export interface ClaudeCodePlan {
  /** Null when Claude Code produced no usable plan; `reason` says why. */
  plan: Plan | null;
  reason: string | null;
  /** The model Claude Code reported (its init message), else the one requested. */
  model: string;
}

/** The JSON Schema Claude Code's structured output must match: submit_plan's bounds. */
export function planJsonSchema(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(planSchema) as Record<string, unknown>;
  return schema;
}

/** The MCP config file Claude Code loads with `--mcp-config --strict-mcp-config`. */
export function mcpConfig(mcp: PlannerMcp): Record<string, unknown> {
  if (mcp.kind === "http") return { mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: mcp.url } } };
  // Claude Code starts stdio servers in its own working directory (an empty temp dir here), so change into the
  // server's directory first. `sh -c 'cd "$0" && exec "$@"' dir cmd args...` needs no quoting of the parts.
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [key, value] of Object.entries(mcp.env)) {
    if (key !== "STRIKE_AGENT_PRIVATE_KEY") env[key] = value;
  }
  // The config is a file on disk: it names the Alchemy key by reference (Claude Code expands ${VAR} from its own
  // environment, which has it) instead of holding it. Unexpanded, the SDK ignores it and reads the public RPC.
  if (env.ALCHEMY_API_KEY) env.ALCHEMY_API_KEY = "${ALCHEMY_API_KEY}";
  env.STRIKE_MCP_READ_ONLY = "1";
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: "sh",
        args: ["-c", 'cd "$0" && exec "$@"', mcp.cwd, mcp.command, ...mcp.args],
        env,
      },
    },
  };
}

/**
 * The environment the CLI runs with: no agent key (the planner never signs), no ANTHROPIC_API_KEY (so the
 * subscription login or CLAUDE_CODE_OAUTH_TOKEN pays, not an API key), no auto-memory, and not marked as nested.
 */
export function claudeCodeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
  for (const key of ["STRIKE_AGENT_PRIVATE_KEY", "ANTHROPIC_API_KEY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"])
    delete out[key];
  return out;
}

/** The `claude` arguments (the prompt goes on stdin). File paths are inside the run's temp directory. */
export function claudeCodeArgs(o: {
  systemPromptFile: string;
  mcpConfigFile: string;
  model: string;
  maxTurns: number;
}): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(planJsonSchema()),
    "--system-prompt-file",
    o.systemPromptFile,
    "--mcp-config",
    o.mcpConfigFile,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    CLAUDE_CODE_TOOLS.join(","),
    "--permission-mode",
    "dontAsk",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-turns",
    String(o.maxTurns),
    "--model",
    o.model,
  ];
}

/** True if `name` is an executable file on PATH (or an executable path). */
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const candidates = name.includes("/")
    ? [name]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, name));
  return candidates.some((p) => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The `claude` executable to run. */
export function claudeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CODE_PATH?.trim() || "claude";
}

/** True if the Claude Code planner can run: the CLI is on PATH, or CLAUDE_CODE_OAUTH_TOKEN is set. */
export function claudeCodeAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return onPath(claudeExecutable(env), env) || !!env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
}

const LOGIN_HINT =
  "Claude Code is not logged in: run `claude` and /login, or set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`)";
const looksLikeAuth = (s: string) =>
  /not logged in|\/login|invalid api key|oauth token|authenticat|unauthori[sz]ed|401/i.test(s);
const tail = (s: string, n = 300) => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `...${t.slice(-n)}` : t;
};
const shortTool = (name: string) => name.replace(`mcp__${MCP_SERVER_NAME}__`, "");

interface StreamState {
  model: string | null;
  result: Record<string, unknown> | null;
  badLines: number;
  failure: string | null;
}

/** Narrate one stream-json line and collect the init model and the final result. */
function handleLine(line: string, state: StreamState, narrate: Narrate): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    state.badLines += 1;
    return;
  }
  if (msg.type === "system" && msg.subtype === "init") {
    if (typeof msg.model === "string") state.model = msg.model;
    const servers = Array.isArray(msg.mcp_servers)
      ? (msg.mcp_servers as { name: string; status: string }[])
      : [];
    const strike = servers.find((s) => s.name === MCP_SERVER_NAME);
    narrate(
      `Claude Code ${String(msg.claude_code_version ?? "")} started (model ${state.model ?? "?"}); Strike MCP server ${strike?.status ?? "missing"}.`,
    );
    if (strike && strike.status !== "connected" && strike.status !== "pending") {
      state.failure = `the Strike MCP server did not start inside Claude Code (${strike.status})`;
    }
    return;
  }
  if (msg.type === "assistant") {
    const content = (msg.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as { type: string; text?: string; name?: string; input?: unknown }[]) {
      if (block.type === "text" && block.text?.trim()) narrate(`Claude: ${block.text.trim()}`);
      else if (block.type === "tool_use" && block.name && block.name !== "StructuredOutput")
        narrate(`Claude calls ${shortTool(block.name)} ${JSON.stringify(block.input ?? {})}`);
    }
    return;
  }
  if (msg.type === "result") state.result = msg;
}

/** Turn Claude Code's final `result` message into a plan or a reason. */
export function interpretResult(result: Record<string, unknown>): {
  plan: Plan | null;
  reason: string | null;
} {
  const text = typeof result.result === "string" ? result.result : "";
  const denials = Array.isArray(result.permission_denials) ? result.permission_denials : [];
  const denied = denials.length
    ? ` (denied: ${denials.map((d) => shortTool(String((d as { tool_name?: string }).tool_name))).join(", ")})`
    : "";
  if (result.subtype === "error_max_turns") {
    return { plan: null, reason: `Claude used all its turns without handing back a plan${denied}` };
  }
  if (result.subtype === "error_max_structured_output_retries") {
    return { plan: null, reason: "Claude's answer never matched the plan schema" };
  }
  if (result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")) {
    if (looksLikeAuth(text)) return { plan: null, reason: LOGIN_HINT };
    return {
      plan: null,
      reason: `Claude Code failed (${String(result.subtype)}): ${tail(text) || "no message"}`,
    };
  }
  if (result.stop_reason === "refusal") return { plan: null, reason: "Claude declined to plan this epoch" };
  let raw: unknown = result.structured_output;
  if (raw === undefined || raw === null) {
    try {
      raw = JSON.parse(text);
    } catch {
      return {
        plan: null,
        reason: `Claude handed back no plan${text ? `: ${tail(text, 200)}` : ""}${denied}`,
      };
    }
  }
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      plan: null,
      reason: `Claude's plan is invalid (${issue ? `${issue.path.join(".") || "plan"}: ${issue.message}` : "schema"})`,
    };
  }
  return { plan: parsed.data, reason: null };
}

/**
 * Let Claude choose this epoch's target delta and premium factor through the Claude Code CLI (`claude -p`), with
 * the Strike MCP server's read-only planning tools. Never throws: a missing CLI, a missing login, a non-zero exit,
 * a timeout, a refusal or an invalid answer come back as `plan: null` with a reason.
 */
export async function planWithClaudeCode(opts: ClaudeCodeOptions): Promise<ClaudeCodePlan> {
  const env = opts.env ?? process.env;
  const requested = opts.model ?? CLAUDE_MODEL;
  const state: StreamState = { model: null, result: null, badLines: 0, failure: null };
  const done = (plan: Plan | null, reason: string | null): ClaudeCodePlan => ({
    plan,
    reason,
    model: state.model ?? requested,
  });

  // An empty working directory: no CLAUDE.md or project settings to pick up, and a private place for the config.
  const dir = await mkdtemp(join(tmpdir(), "strike-claude-code-"));
  try {
    const systemPromptFile = join(dir, "system-prompt.md");
    const mcpConfigFile = join(dir, "mcp.json");
    await writeFile(
      systemPromptFile,
      planningSystem(
        "Finish with your plan as the structured output (targetDeltaBps, premiumBps, reasoning): a candidate that passed risk_check (ok: true) with the same targetDeltaBps and premiumBps.",
        opts.skill,
      ),
    );
    // The config can hold the RPC URL (which may carry a provider key): owner-only.
    await writeFile(mcpConfigFile, JSON.stringify(mcpConfig(opts.mcp), null, 2), { mode: 0o600 });
    await chmod(mcpConfigFile, 0o600);
    const args = claudeCodeArgs({
      systemPromptFile,
      mcpConfigFile,
      model: requested,
      maxTurns: opts.maxTurns ?? CLAUDE_CODE_MAX_TURNS,
    });
    const prompt = `Plan this week's proposal for vault ${opts.vault}. Start with vault_state, dry-run with risk_check, then hand back the plan.`;

    const exe = opts.claudePath ?? claudeExecutable(env);
    const spawn = opts.spawn ?? nodeSpawn;
    const timeoutMs = opts.timeoutMs ?? CLAUDE_CODE_TIMEOUT_MS;

    const outcome = await new Promise<{
      code: number | null;
      error?: NodeJS.ErrnoException;
      timedOut: boolean;
      stderr: string;
    }>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(exe, args, { cwd: dir, env: claudeCodeEnv(env), stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        resolve({ code: null, error: error as NodeJS.ErrnoException, timedOut: false, stderr: "" });
        return;
      }
      let stderr = "";
      let buffer = "";
      let timedOut = false;
      let settled = false;
      const finish = (r: { code: number | null; error?: NodeJS.ErrnoException }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (buffer.trim()) handleLine(buffer.trim(), state, opts.narrate);
        resolve({ ...r, timedOut, stderr });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) handleLine(line, state, opts.narrate);
          if (state.failure && !child.killed) child.kill("SIGTERM");
          nl = buffer.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", (error) => finish({ code: null, error }));
      child.on("close", (code) => finish({ code }));
      child.stdin?.on("error", () => {}); // the CLI may exit before reading the prompt
      child.stdin?.end(prompt);
    });

    if (outcome.error) {
      if (outcome.error.code === "ENOENT") {
        return done(
          null,
          `the claude CLI is not installed or not on PATH (${exe}); install it with \`npm i -g @anthropic-ai/claude-code\``,
        );
      }
      return done(null, `could not run ${exe}: ${outcome.error.message}`);
    }
    if (state.failure) return done(null, state.failure);
    if (outcome.timedOut) return done(null, `Claude Code timed out after ${Math.round(timeoutMs / 1000)} s`);
    if (state.result) {
      const { plan, reason } = interpretResult(state.result);
      if (plan && outcome.code !== 0)
        return done(null, `claude exited with code ${outcome.code} after its plan`);
      return done(plan, reason);
    }
    if (outcome.code !== 0) {
      if (looksLikeAuth(outcome.stderr)) return done(null, LOGIN_HINT);
      return done(
        null,
        `claude exited with code ${outcome.code}${outcome.stderr.trim() ? `: ${tail(outcome.stderr)}` : ""}`,
      );
    }
    return done(
      null,
      state.badLines
        ? "claude printed output that is not JSON (no result message)"
        : "claude returned no result",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
