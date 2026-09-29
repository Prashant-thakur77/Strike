import { describe, expect, it } from "vitest";
import type { StrikeMcp } from "../src/mcp.js";
import { joinStrike, parseBond, parseVaultSpec } from "../src/onboard.js";
import type { CreateVaultResult, OnboardCheck, RegisterAgentResult } from "../src/types.js";

// The --register mode against a scripted Strike MCP server: which tools it calls, in what order, with what, and
// when it stops.

type Handler = (args: Record<string, unknown>) => unknown;

function fakeMcp(handlers: Record<string, Handler>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const mcp: StrikeMcp = {
    client: undefined as never,
    async call<T>(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const handler = handlers[name];
      if (!handler) throw new Error(`unexpected tool ${name}`);
      return handler(args) as T;
    },
    close: async () => {},
  };
  return { mcp, calls };
}

function recorder() {
  const lines: string[] = [];
  return { lines, log: { step: (t: string) => lines.push(`# ${t}`), say: (l: string) => lines.push(l) } };
}

const ok = (check: string, detail = "fine"): OnboardCheck => ({ check, ok: true, blocking: true, detail });

/** register_agent: a fresh key with `balance` USDG, or agent #`existing` with `bond` bonded. */
function registerTool(opts: { balance?: number; existing?: string; bond?: number } = {}) {
  let agentId = opts.existing ?? null;
  let bond = opts.bond ?? 0;
  return (args: Record<string, unknown>): RegisterAgentResult => {
    const amount = args.bond === "min" ? 50 : Number(args.bond ?? 0);
    const balance = opts.balance ?? 1000;
    const canPay = balance >= amount;
    const checks = [
      ok("Signer free"),
      { check: "USDG for the bond", ok: canPay, blocking: true, detail: `holds ${balance} USDG` },
    ];
    const common = {
      alreadyRegistered: opts.existing !== undefined,
      signer: "0xME",
      payout: "0xME",
      minBond: "50",
      slashAmount: "10",
      maxStrikes: 3,
      usdgBalance: String(balance),
      checks,
      nextStep: "Create your own vault with create_vault.",
    };
    if (args.dryRun || !canPay) {
      return {
        ...common,
        dryRun: args.dryRun === true,
        submitted: false,
        agentId,
        bondPosted: "0",
        bond: String(bond),
        active: bond >= 50,
        registerTxHash: null,
        bondTxHash: null,
        explanation: canPay
          ? "Dry run: would register 0xME as an agent."
          : "Not sent. USDG for the bond: too little.",
      };
    }
    const fresh = agentId === null;
    agentId ??= "2";
    bond += amount;
    return {
      ...common,
      dryRun: false,
      submitted: true,
      agentId,
      bondPosted: String(amount),
      bond: String(bond),
      active: bond >= 50,
      registerTxHash: fresh ? "0xreg" : null,
      bondTxHash: amount > 0 ? "0xbond" : null,
      explanation: `Registered agent #${agentId}.`,
    };
  };
}

function createTool(opts: { blocked?: boolean } = {}) {
  return (args: Record<string, unknown>): CreateVaultResult => {
    const symbol = `s${String(args.underlying)}-${args.kind === "call" ? "CC" : "CSP"}-A${String(args.agentId)}`;
    const checks = [
      ok("Stock token allowed"),
      {
        check: "Mandate inside the floors",
        ok: !opts.blocked,
        blocking: true,
        detail: opts.blocked ? "minPremiumBps must be at least 9000" : "passes",
      },
    ];
    const sent = !args.dryRun && !opts.blocked;
    return {
      dryRun: args.dryRun === true,
      submitted: sent,
      vault: sent ? "0xVAULT" : null,
      agentId: String(args.agentId),
      underlying: { address: "0xTSLA", symbol: String(args.underlying) },
      kind: args.kind === "call" ? "covered-call" : "cash-secured-put",
      collateral: args.kind === "call" ? "TSLA" : "USDG",
      name: "Strike TSLA vault",
      symbol,
      depositCap: "1000000",
      mandate: {
        minDeltaBps: 1000,
        maxDeltaBps: 3500,
        minPremiumBps: 9500,
        minYieldBps: 5,
        maxShareSoldBps: 8000,
        minTenor: 86_400,
        maxTenor: 691_200,
        summary: "|delta| 0.10-0.35, premium >= 95% of fair value",
      },
      floors: { minPremiumBps: 9000, maxPremiumBps: 30_000, maxTenorDays: 35 },
      checks,
      txHash: sent ? "0xcreate" : null,
      explanation: opts.blocked
        ? "Not sent. Mandate inside the floors: minPremiumBps must be at least 9000."
        : args.dryRun
          ? `Dry run: would create ${symbol}.`
          : `Created ${symbol} at 0xVAULT.`,
      nextStep: `Deposit, then propose_epoch with vault "${symbol}".`,
    };
  };
}

describe("parsing the --register flags", () => {
  it("reads SYMBOL:call|put", () => {
    expect(parseVaultSpec("TSLA:put")).toEqual({ underlying: "TSLA", kind: "put" });
    expect(parseVaultSpec(" nvda : CALL ")).toEqual({ underlying: "NVDA", kind: "call" });
    expect(() => parseVaultSpec("TSLA")).toThrow(/SYMBOL:call or SYMBOL:put/);
    expect(() => parseVaultSpec("TSLA:straddle")).toThrow(/TSLA:put/);
  });

  it("reads a USDG bond", () => {
    expect(parseBond(undefined)).toBeUndefined();
    expect(parseBond("50")).toBe("50");
    expect(parseBond("12.5")).toBe("12.5");
    expect(parseBond("min")).toBe("min");
    expect(() => parseBond("0")).toThrow(/positive/);
    expect(() => parseBond("-5")).toThrow(/positive/);
    expect(() => parseBond("1.1234567")).toThrow(/positive/);
  });
});

describe("joinStrike (--register)", () => {
  it("dry-runs, then registers with the minimum bond by default", async () => {
    const { mcp, calls } = fakeMcp({ register_agent: registerTool() });
    const { lines, log } = recorder();
    const res = await joinStrike(mcp, {}, log);
    expect(res).toEqual({ agentId: "2", active: true, vault: null, vaultSymbol: null });
    expect(calls).toEqual([
      { name: "register_agent", args: { bond: "min", dryRun: true } },
      { name: "register_agent", args: { bond: "min" } },
    ]);
    const text = lines.join("\n");
    expect(text).toMatch(/Rules: bond at least 50 USDG to propose; each rejected proposal slashes 10 USDG/);
    expect(text).toMatch(/\[ok {2}\] USDG for the bond/);
    expect(text).toMatch(/register tx 0xreg/);
    expect(text).toMatch(/--create-vault TSLA:call/);
  });

  it("bonds the amount given with --bond", async () => {
    const { mcp, calls } = fakeMcp({ register_agent: registerTool() });
    await joinStrike(mcp, { bond: "75" }, recorder().log);
    expect(calls.map((c) => c.args.bond)).toEqual(["75", "75"]);
  });

  it("stops before sending when a blocking check fails", async () => {
    const { mcp, calls } = fakeMcp({ register_agent: registerTool({ balance: 10 }) });
    const { lines, log } = recorder();
    await expect(joinStrike(mcp, {}, log)).rejects.toThrow(/not joining: Not sent\. USDG for the bond/);
    expect(calls).toHaveLength(1); // the dry run only
    expect(lines.join("\n")).toMatch(/\[FAIL\] USDG for the bond: holds 10 USDG/);
  });

  it("leaves an agent that is already bonded alone, and tops up one that is not", async () => {
    const bonded = fakeMcp({ register_agent: registerTool({ existing: "4", bond: 60 }) });
    const { lines, log } = recorder();
    expect(await joinStrike(bonded.mcp, {}, log)).toMatchObject({ agentId: "4", active: true });
    expect(bonded.calls).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/already agent #4, bonded 60 USDG and active; nothing to register/);
    expect(lines.join("\n")).toMatch(/setVaultAgent\(vault, 4\)/);

    const unbonded = fakeMcp({ register_agent: registerTool({ existing: "4", bond: 20 }) });
    const res = await joinStrike(unbonded.mcp, {}, recorder().log);
    expect(unbonded.calls.map((c) => c.args)).toEqual([{ bond: "min", dryRun: true }, { bond: "min" }]);
    expect(res).toMatchObject({ agentId: "4", active: true });
  });

  it("creates a vault run by the new agent after a dry run", async () => {
    const { mcp, calls } = fakeMcp({ register_agent: registerTool(), create_vault: createTool() });
    const { lines, log } = recorder();
    const res = await joinStrike(mcp, { createVault: { underlying: "TSLA", kind: "put" } }, log);
    expect(res).toEqual({ agentId: "2", active: true, vault: "0xVAULT", vaultSymbol: "sTSLA-CSP-A2" });
    expect(calls.filter((c) => c.name === "create_vault").map((c) => c.args)).toEqual([
      { underlying: "TSLA", kind: "put", agentId: "2", dryRun: true },
      { underlying: "TSLA", kind: "put", agentId: "2" },
    ]);
    const text = lines.join("\n");
    expect(text).toMatch(/Mandate \(fixed for the vault's lifetime\): \|delta\| 0\.10-0\.35/);
    expect(text).toMatch(/Protocol floors: premium at least 90% of fair value, tenor at most 35 days/);
    expect(text).toMatch(/createVault tx 0xcreate/);
    expect(text).toMatch(/propose_epoch with vault "sTSLA-CSP-A2"/);
  });

  it("does not create a vault whose dry run fails", async () => {
    const { mcp, calls } = fakeMcp({
      register_agent: registerTool(),
      create_vault: createTool({ blocked: true }),
    });
    await expect(
      joinStrike(mcp, { createVault: { underlying: "TSLA", kind: "call" } }, recorder().log),
    ).rejects.toThrow(/not creating the vault: .*9000/);
    expect(calls.filter((c) => c.name === "create_vault")).toHaveLength(1);
  });
});
