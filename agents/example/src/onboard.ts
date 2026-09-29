import type { Log } from "./buyer.js";
import type { StrikeMcp } from "./mcp.js";
import type { CreateVaultResult, OnboardCheck, RegisterAgentResult } from "./types.js";

// Joining Strike as a new agent through the MCP server: dry-run register_agent and explain the rules, register and
// bond, then (optionally) dry-run and create a vault this agent runs. Nothing is sent while a blocking check fails.

/** A vault to create: `TSLA:call` (covered calls) or `TSLA:put` (cash-secured puts). */
export interface VaultSpec {
  underlying: string;
  kind: "call" | "put";
}

/** Parse `--create-vault TSLA:call|put`. */
export function parseVaultSpec(spec: string): VaultSpec {
  const m = /^\s*([A-Za-z][A-Za-z0-9.]*)\s*:\s*(call|put)\s*$/i.exec(spec);
  if (!m) throw new Error(`--create-vault takes SYMBOL:call or SYMBOL:put (e.g. TSLA:put), got "${spec}"`);
  return {
    underlying: (m[1] as string).toUpperCase(),
    kind: (m[2] as string).toLowerCase() as "call" | "put",
  };
}

/** Parse `--bond N` (USDG); undefined when the flag is absent. */
export function parseBond(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (v === "min") return v;
  if (!/^\d+(\.\d{1,6})?$/.test(v) || Number(v) <= 0) {
    throw new Error(`--bond must be a positive USDG amount (e.g. 50) or "min", got "${value}"`);
  }
  return v;
}

export interface JoinOptions {
  /** USDG to bond (or "min"). Default: the minimum bond for a new agent, nothing for an agent already bonded. */
  bond?: string;
  createVault?: VaultSpec;
}

export interface JoinResult {
  agentId: string;
  active: boolean;
  vault: string | null;
  vaultSymbol: string | null;
}

const mark = (c: OnboardCheck) => (c.ok ? "ok  " : c.blocking ? "FAIL" : "warn");

function sayChecks(log: Log, checks: OnboardCheck[]) {
  for (const c of checks) log.say(`[${mark(c)}] ${c.check}: ${c.detail}`);
}

/**
 * Register this wallet as an agent (bonding it), then optionally create a vault it runs. Every write is dry-run
 * first; a failed blocking check stops the run with the tool's explanation.
 */
export async function joinStrike(mcp: StrikeMcp, opts: JoinOptions, log: Log): Promise<JoinResult> {
  log.step("Check before joining (register_agent, dry run)");
  let bond = opts.bond ?? "min";
  let dry = await mcp.call<RegisterAgentResult>("register_agent", { bond, dryRun: true });
  if (dry.alreadyRegistered && opts.bond === undefined) {
    // Re-running is safe: an agent that is already bonded is left alone; an unbonded one gets the minimum.
    if (dry.active) {
      log.say(
        `This key is already agent #${dry.agentId}, bonded ${dry.bond} USDG and active; nothing to register.`,
      );
      bond = "";
    } else {
      log.say(`This key is already agent #${dry.agentId} with ${dry.bond} USDG bonded, below the minimum.`);
    }
  }
  if (bond !== "") {
    sayChecks(log, dry.checks);
    log.say(
      `Rules: bond at least ${dry.minBond} USDG to propose; each rejected proposal slashes ${dry.slashAmount} USDG to that vault's depositors; ${dry.maxStrikes} strikes suspend the agent.`,
    );
    if (!dry.explanation.startsWith("Dry run")) throw new Error(`not joining: ${dry.explanation}`);

    log.step(
      dry.alreadyRegistered ? "Top up the bond (register_agent)" : "Register and bond (register_agent)",
    );
    dry = await mcp.call<RegisterAgentResult>("register_agent", { bond });
    log.say(dry.explanation);
    if (dry.registerTxHash) log.say(`register tx ${dry.registerTxHash}`);
    if (dry.bondTxHash) log.say(`postBond tx ${dry.bondTxHash}`);
    if (!dry.submitted) throw new Error(`register_agent sent nothing: ${dry.explanation}`);
  }
  const agentId = dry.agentId as string;
  const out: JoinResult = { agentId, active: dry.active, vault: null, vaultSymbol: null };

  if (!opts.createVault) {
    log.step("Next");
    log.say(
      dry.submitted
        ? dry.nextStep
        : `Run a vault: create your own, or ask a vault's curator to call EpochManager.setVaultAgent(vault, ${agentId}).`,
    );
    log.say("Or create one now: --register --create-vault TSLA:call (or TSLA:put).");
    return out;
  }

  const { underlying, kind } = opts.createVault;
  log.step(`Check the vault (create_vault ${underlying}:${kind}, dry run)`);
  const plan = await mcp.call<CreateVaultResult>("create_vault", { underlying, kind, agentId, dryRun: true });
  log.say(
    `${plan.symbol}: ${plan.name}, collateral ${plan.collateral}, deposit cap ${plan.depositCap} ${plan.collateral}.`,
  );
  log.say(`Mandate (fixed for the vault's lifetime): ${plan.mandate.summary}.`);
  log.say(
    `Protocol floors: premium at least ${plan.floors.minPremiumBps / 100}% of fair value, tenor at most ${plan.floors.maxTenorDays} days.`,
  );
  sayChecks(log, plan.checks);
  if (!plan.explanation.startsWith("Dry run")) throw new Error(`not creating the vault: ${plan.explanation}`);

  log.step("Create the vault (create_vault)");
  const res = await mcp.call<CreateVaultResult>("create_vault", { underlying, kind, agentId });
  log.say(res.explanation);
  if (res.txHash) log.say(`createVault tx ${res.txHash}`);
  if (!res.submitted || !res.vault) throw new Error(`create_vault sent nothing: ${res.explanation}`);
  log.step("Next");
  log.say(res.nextStep);
  return { ...out, vault: res.vault, vaultSymbol: res.symbol };
}
