import type { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_TOOLS,
  claudeCodeArgs,
  claudeCodeEnv,
  interpretResult,
  mcpConfig,
  planJsonSchema,
  planWithClaudeCode,
} from "../src/claudeCode.js";
import { parsePlanner, plannerLabel, selectPlanner } from "../src/planner.js";

// planWithClaudeCode against a scripted `claude` process (spawn is injected): the argv it builds, the files it hands
// the CLI, and every failure path coming back as `plan: null` with a reason.

interface Spawned {
  exe: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  files: { system: string; mcp: string };
}

type Script =
  { lines: string[]; code?: number; stderr?: string } | { error: NodeJS.ErrnoException } | { hang: true };

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";

/** A fake spawn that plays `script`, recording what it was called with (and the temp files, before cleanup). */
function fakeSpawn(script: Script) {
  const calls: Spawned[] = [];
  const spawn = ((exe: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      killed: boolean;
      kill: (signal?: string) => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    const call: Spawned = {
      exe,
      args,
      cwd: options.cwd,
      env: options.env,
      stdin: "",
      files: {
        system: readFileSync(flag(args, "--system-prompt-file"), "utf8"),
        mcp: readFileSync(flag(args, "--mcp-config"), "utf8"),
      },
    };
    calls.push(call);
    child.stdin.on("data", (d: Buffer) => (call.stdin += d.toString()));
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit("close", null));
      return true;
    };
    setImmediate(() => {
      if ("error" in script) {
        child.emit("error", script.error);
        return;
      }
      if ("hang" in script) return;
      for (const l of script.lines) child.stdout.write(`${l}\n`);
      if (script.stderr) child.stderr.write(script.stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", script.code ?? 0));
    });
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}

const init = (status = "connected") =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    model: "claude-opus-5",
    claude_code_version: "2.1.263",
    mcp_servers: [{ name: "strike", status }],
  });
const assistant = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } });
const result = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, permission_denials: [], ...fields });

const PLAN = { targetDeltaBps: 1800, premiumBps: 10500, reasoning: "Far enough out of the money." };
const stdio = {
  kind: "stdio" as const,
  command: "pnpm",
  args: ["--silent", "--filter", "@strike/mcp", "dev"],
  env: {
    STRIKE_CHAIN_ID: "31337",
    STRIKE_RPC_URL: "http://127.0.0.1:8550",
    STRIKE_AGENT_PRIVATE_KEY: "0xsecret",
  },
  cwd: "/repo",
};

async function run(script: Script, extra: Partial<Parameters<typeof planWithClaudeCode>[0]> = {}) {
  const { spawn, calls } = fakeSpawn(script);
  const said: string[] = [];
  const res = await planWithClaudeCode({
    vault: "0xVault",
    skill: "SKILL TEXT",
    narrate: (l) => said.push(l),
    mcp: stdio,
    spawn,
    claudePath: "claude",
    env: {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-test",
      STRIKE_AGENT_PRIVATE_KEY: "0xsecret",
      HOME: "/home/x",
    },
    ...extra,
  });
  return { res, said, calls };
}

describe("planWithClaudeCode", () => {
  it("returns the structured plan and narrates the tool calls", async () => {
    const { res, said, calls } = await run({
      lines: [
        init(),
        assistant([{ type: "text", text: "Reading the vault." }]),
        assistant([{ type: "tool_use", name: "mcp__strike__vault_state", input: { vault: "0xVault" } }]),
        assistant([
          {
            type: "tool_use",
            name: "mcp__strike__risk_check",
            input: { targetDeltaBps: 1800, premiumBps: 10500 },
          },
        ]),
        assistant([{ type: "tool_use", name: "StructuredOutput", input: PLAN }]),
        result({ structured_output: PLAN, result: JSON.stringify(PLAN) }),
      ],
    });
    expect(res).toEqual({ plan: PLAN, reason: null, model: "claude-opus-5" });
    expect(said).toContain("Claude: Reading the vault.");
    expect(said).toContain('Claude calls vault_state {"vault":"0xVault"}');
    expect(said).toContain('Claude calls risk_check {"targetDeltaBps":1800,"premiumBps":10500}');
    expect(said.some((l) => l.includes("StructuredOutput"))).toBe(false);

    const call = calls[0]!;
    expect(call.stdin).toContain("0xVault");
    expect(call.cwd).toMatch(/strike-claude-code-/);
    expect(call.files.system).toContain("SKILL TEXT");
    expect(call.files.system).toContain("structured output");
    // The CLI never sees the agent key, and an API key does not pre-empt the subscription.
    expect(call.env.STRIKE_AGENT_PRIVATE_KEY).toBeUndefined();
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();
    // The MCP server is started read-only, in the repo, without the key.
    const server = (JSON.parse(call.files.mcp) as { mcpServers: Record<string, Record<string, unknown>> })
      .mcpServers.strike!;
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("sh");
    expect(server.args).toEqual(["-c", 'cd "$0" && exec "$@"', "/repo", "pnpm", ...stdio.args]);
    const env = server.env as Record<string, string>;
    expect(env.STRIKE_MCP_READ_ONLY).toBe("1");
    expect(env.STRIKE_CHAIN_ID).toBe("31337");
    expect(env.STRIKE_AGENT_PRIVATE_KEY).toBeUndefined();
  });

  it("never allows write tools or built-in tools", async () => {
    const { calls } = await run({ lines: [init(), result({ structured_output: PLAN })] });
    const args = calls[0]!.args;
    const allowed = flag(args, "--allowedTools").split(",");
    expect(allowed.sort()).toEqual(
      [
        "mcp__strike__agent_stats",
        "mcp__strike__quote",
        "mcp__strike__risk_check",
        "mcp__strike__vault_state",
      ].sort(),
    );
    expect(CLAUDE_CODE_TOOLS.sort()).toEqual(allowed);
    for (const write of ["propose_epoch", "settle_epoch", "buy_options", "register_agent", "create_vault"]) {
      expect(args.join(" ")).not.toContain(write);
    }
    for (const builtin of ["Bash", "Edit", "Write", "WebFetch", "Read"])
      expect(allowed).not.toContain(builtin);
    expect(flag(args, "--tools")).toBe(""); // no built-in tools at all
    expect(args).toContain("--strict-mcp-config");
    expect(flag(args, "--permission-mode")).toBe("dontAsk");
    expect(flag(args, "--setting-sources")).toBe("");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(flag(args, "--output-format")).toBe("stream-json");
    expect(JSON.parse(flag(args, "--json-schema"))).toEqual(planJsonSchema());
  });

  it("reports a missing CLI", async () => {
    const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const { res } = await run({ error });
    expect(res.plan).toBeNull();
    expect(res.reason).toMatch(/not installed/);
    expect(res.model).toBe("claude-opus-5");
  });

  it("reports output that is not JSON", async () => {
    const { res } = await run({ lines: ["Welcome to Claude Code!", "{oops"] });
    expect(res.plan).toBeNull();
    expect(res.reason).toMatch(/not JSON/);
  });

  it("reports a non-zero exit, and a missing login", async () => {
    const crashed = await run({ lines: [], code: 2, stderr: "boom: something broke" });
    expect(crashed.res.plan).toBeNull();
    expect(crashed.res.reason).toBe("claude exited with code 2: boom: something broke");

    const noLogin = await run({ lines: [], code: 1, stderr: "Invalid API key · Please run /login" });
    expect(noLogin.res.reason).toMatch(/not logged in/);

    const loginResult = await run({
      lines: [init(), result({ is_error: true, result: "Not logged in · Please run /login" })],
      code: 1,
    });
    expect(loginResult.res.reason).toMatch(/not logged in/);
  });

  it("reports a refusal, an invalid plan and running out of turns", async () => {
    const refused = await run({ lines: [init(), result({ stop_reason: "refusal", result: "" })] });
    expect(refused.res).toMatchObject({ plan: null, reason: "Claude declined to plan this epoch" });

    const invalid = await run({
      lines: [init(), result({ structured_output: { ...PLAN, targetDeltaBps: 20_000 } })],
    });
    expect(invalid.res.plan).toBeNull();
    expect(invalid.res.reason).toMatch(/invalid.*targetDeltaBps/);

    const turns = await run({
      lines: [
        init(),
        result({
          subtype: "error_max_turns",
          is_error: true,
          permission_denials: [{ tool_name: "mcp__strike__propose_epoch" }],
        }),
      ],
    });
    expect(turns.res.reason).toMatch(/turns.*denied: propose_epoch/);
  });

  it("stops when the Strike MCP server fails, and on a timeout", async () => {
    const failed = await run({ lines: [init("failed"), result({ structured_output: PLAN })] });
    expect(failed.res).toMatchObject({ plan: null });
    expect(failed.res.reason).toMatch(/MCP server did not start/);

    const hung = await run({ hang: true }, { timeoutMs: 20 });
    expect(hung.res.reason).toMatch(/timed out/);
  });

  it("falls back to the result text when there is no structured output", () => {
    expect(interpretResult({ type: "result", subtype: "success", result: JSON.stringify(PLAN) })).toEqual({
      plan: PLAN,
      reason: null,
    });
    expect(interpretResult({ type: "result", subtype: "success", result: "I think 0.2" }).reason).toMatch(
      /no plan/,
    );
  });
});

describe("Claude Code config", () => {
  it("uses the HTTP transport for a remote endpoint", () => {
    expect(mcpConfig({ kind: "http", url: "https://strike-options.vercel.app/api/mcp" })).toEqual({
      mcpServers: { strike: { type: "http", url: "https://strike-options.vercel.app/api/mcp" } },
    });
  });

  it("names the Alchemy key by reference in the config file, never by value", () => {
    const cfg = mcpConfig({ ...stdio, env: { ...stdio.env, ALCHEMY_API_KEY: "test_key_0123456789" } }) as {
      mcpServers: { strike: { env: Record<string, string> } };
    };
    expect(cfg.mcpServers.strike.env.ALCHEMY_API_KEY).toBe("${ALCHEMY_API_KEY}");
    expect(JSON.stringify(cfg)).not.toContain("test_key_0123456789");
    expect(JSON.stringify(cfg)).not.toContain("0xsecret");
    const without = mcpConfig(stdio) as { mcpServers: { strike: { env: Record<string, string> } } };
    expect(without.mcpServers.strike.env.ALCHEMY_API_KEY).toBeUndefined();
  });

  it("the JSON schema carries submit_plan's bounds", () => {
    const s = planJsonSchema() as { properties: Record<string, Record<string, number>>; required: string[] };
    expect(s.required.sort()).toEqual(["premiumBps", "reasoning", "targetDeltaBps"]);
    expect(s.properties.targetDeltaBps).toMatchObject({ minimum: 1, maximum: 9999 });
    expect(s.properties.premiumBps).toMatchObject({ minimum: 1, maximum: 30000 });
  });

  it("argv puts the prompt on stdin, not argv", () => {
    const args = claudeCodeArgs({
      systemPromptFile: "/t/s.md",
      mcpConfigFile: "/t/m.json",
      model: "m",
      maxTurns: 3,
    });
    expect(args[0]).toBe("-p");
    expect(flag(args, "--max-turns")).toBe("3");
    expect(flag(args, "--model")).toBe("m");
  });

  it("claudeCodeEnv strips secrets and keeps the OAuth token", () => {
    const env = claudeCodeEnv({
      ANTHROPIC_API_KEY: "a",
      STRIKE_AGENT_PRIVATE_KEY: "k",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      CLAUDECODE: "1",
    });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });
});

describe("planner selection", () => {
  const none = () => false;
  const yes = () => true;

  it("prefers the API key, then Claude Code, else none", () => {
    expect(selectPlanner(undefined, { ANTHROPIC_API_KEY: "k" }, yes).kind).toBe("api");
    expect(selectPlanner(undefined, {}, yes).kind).toBe("claude-code");
    const neither = selectPlanner(undefined, {}, none);
    expect(neither.kind).toBeNull();
    expect(neither.reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("--planner forces one", () => {
    expect(selectPlanner("claude-code", { ANTHROPIC_API_KEY: "k" }, none).kind).toBe("claude-code");
    expect(selectPlanner("api", {}, yes).kind).toBe("api");
    expect(parsePlanner("Claude-Code")).toBe("claude-code");
    expect(parsePlanner(undefined)).toBeUndefined();
    expect(() => parsePlanner("gpt")).toThrow(/api.*claude-code/);
  });

  it("labels the planner for the record", () => {
    expect(plannerLabel("api", "claude-opus-5")).toBe("Claude via API, model claude-opus-5");
    expect(plannerLabel("claude-code", "claude-opus-5")).toBe(
      "Claude via Claude Code CLI, model claude-opus-5",
    );
  });
});
