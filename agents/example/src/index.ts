import { parseArgs } from "node:util";
import { DEFAULT_BUDGET, DEFAULT_SLIPPAGE_BPS, buyOptions, redeemOptions } from "./buyer.js";
import { describeClaudeError, planWithClaude } from "./llm.js";
import { type StrikeMcp, connectStrikeMcp } from "./mcp.js";
import {
  DEFAULT_TARGET_DELTA,
  type Plan,
  atTheMoneyStrike,
  deterministicPlan,
  enforceMandate,
  pickVault,
} from "./strategy.js";
import type {
  AgentStats,
  ProposeResult,
  RiskCheck,
  SettleResult,
  StrikeInfo,
  VaultState,
  VaultView,
} from "./types.js";

const HELP = `Strike example agent: picks a weekly strike through the Strike MCP server.

Usage: pnpm --filter @strike/agent-example start [options]

  (default)          Propose this epoch's option at 0.20 delta, after a dry run.
  --reckless         Propose an at-the-money strike with force: true to show the contract
                     rejecting it and slashing the agent's bond.
  --llm              Let Claude choose the target delta and premium factor (needs Claude API
                     credentials, e.g. ANTHROPIC_API_KEY); falls back to the default strategy.
  --settle           Settle the vault's expired series.
  --status           Print the vault and agent state only.
  --vault <v>        Vault address or share symbol (default: the first vault this agent runs
                     that can take a proposal, covered calls first).
  --target-delta <d> Target |delta| for the default strategy (default ${DEFAULT_TARGET_DELTA}).

Buyer modes (STRIKE_AGENT_PRIVATE_KEY is the buyer's key; it pays the premium in USDG):
  --buy              Find a live series (--vault to choose) and buy options within the budget,
                     explaining the premium, max loss and breakeven.
  --budget <usdg>    Most USDG to spend, slippage included (default ${DEFAULT_BUDGET}).
  --amount <n>       Buy at most this many options (default: what the budget allows).
  --hedge <tokens>   With --buy: protect a holding of this many stock tokens; hedge_plan picks
                     the put series and sizes the purchase.
  --redeem           Redeem this wallet's options of settled series (--vault, or every vault).

Environment: STRIKE_CHAIN_ID, STRIKE_RPC_URL, STRIKE_AGENT_PRIVATE_KEY (passed to the MCP server),
STRIKE_MCP_COMMAND (server command; default: pnpm --silent --filter @strike/mcp dev).`;

/** Numbered narrative steps on stdout. */
class Narrator {
  private n = 0;
  step(title: string) {
    this.n += 1;
    console.log(`\n[${this.n}] ${title}`);
  }
  say(line: string) {
    for (const l of line.split("\n")) console.log(`    ${l}`);
  }
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const delta = (bps: number) => (bps / 10_000).toFixed(2);

async function chooseVault(
  mcp: StrikeMcp,
  requested: string | undefined,
  agentId: string | null,
): Promise<string> {
  if (requested) return requested;
  const { vaults } = await mcp.call<{ vaults: VaultView[] }>("list_vaults");
  if (agentId) {
    const mine = pickVault(vaults, agentId);
    if (mine) return mine.address;
  }
  const first = vaults[0];
  if (!first) throw new Error("no Strike vaults on this chain");
  return first.address;
}

async function readVault(mcp: StrikeMcp, vault: string, log: Narrator): Promise<VaultState> {
  log.step("Read the vault");
  const s = await mcp.call<VaultState>("vault_state", { vault });
  const v = s.vault;
  log.say(
    `${v.symbol} (${v.name}), ${v.kind}: epoch ${v.epochState}, ${v.totalAssets} ${v.asset.symbol} of collateral`,
  );
  log.say(
    `Spot ${v.underlying.symbol} $${s.spot.price ?? "?"} (oracle ${s.spot.status}), market ${s.marketOpen ? "open" : "closed"}, chain time ${s.blockTimeIso}`,
  );
  log.say(`Mandate: ${v.mandate.summary}`);
  log.say(
    `Agent #${s.agent.agentId}: ${s.agent.active ? "active" : "NOT active"}, bond ${s.agent.bond} USDG, ${s.agent.strikes} strike(s)`,
  );
  log.say(`Next: ${s.nextStep}`);
  return s;
}

async function trackRecord(mcp: StrikeMcp, log: Narrator, agentId: string) {
  log.step("Track record");
  const a = await mcp.call<AgentStats>("agent_stats", { agentId });
  log.say(
    `Agent #${a.agentId} (${a.status}${a.active ? "" : ", cannot propose"}): ${a.accepted} accepted, ${a.rejected} rejected, ${a.strikes}/${a.maxStrikes} strikes, bond ${a.bond} USDG`,
  );
  log.say(
    `Settled epochs ${a.settledEpochs}, cumulative depositor PnL ${a.cumulativePnl} USDG, claimable fees ${a.claimableFees} USDG${a.erc8004Id !== "0" ? `, ERC-8004 id ${a.erc8004Id}` : ""}`,
  );
}

async function decide(
  mcp: StrikeMcp,
  state: VaultState,
  opts: { llm: boolean; targetDelta: number },
  log: Narrator,
): Promise<Plan> {
  const mandate = state.vault.mandate;
  if (opts.llm) {
    log.step("Ask Claude for this epoch's plan");
    try {
      const skill = await mcp.client.readResource({ uri: "strike://skill" });
      const text = skill.contents.map((c) => ("text" in c ? c.text : "")).join("\n");
      const plan = await planWithClaude({
        mcp: mcp.client,
        vault: state.vault.address,
        skill: text,
        narrate: (l) => log.say(l),
      });
      if (plan) {
        const { plan: enforced, adjustments } = enforceMandate(plan, mandate);
        for (const a of adjustments) log.say(`Mandate guard in the agent code adjusted Claude's plan: ${a}`);
        log.say(
          `Claude's plan: ${delta(enforced.targetDeltaBps)} delta at ${pct(enforced.premiumBps)} of fair value`,
        );
        log.say(`Why: ${enforced.reasoning}`);
        return enforced;
      }
      log.say("Claude submitted no plan; using the default strategy.");
    } catch (err) {
      log.say(`Claude is unavailable (${describeClaudeError(err)}); using the default strategy.`);
    }
  }
  log.step("Choose the target delta");
  const plan = deterministicPlan(mandate, opts.targetDelta);
  log.say(plan.reasoning);
  return plan;
}

async function propose(
  mcp: StrikeMcp,
  vault: string,
  opts: { llm: boolean; targetDelta: number },
  log: Narrator,
) {
  const state = await readVault(mcp, vault, log);
  if (state.vault.epochState === "Selling") {
    throw new Error(
      `${state.vault.symbol} is already selling this week's series; settle it after expiry first`,
    );
  }
  if (!state.agent.active) throw new Error(`agent #${state.agent.agentId} cannot propose (bond or strikes)`);

  let plan = await decide(mcp, state, opts, log);

  log.step("Compute the strike (risk_check suggestion)");
  let check = await mcp.call<RiskCheck>("risk_check", {
    vault,
    targetDeltaBps: plan.targetDeltaBps,
    premiumBps: plan.premiumBps,
  });
  const kind = check.isCall ? "call" : "put";
  log.say(
    `At spot $${check.spot}, a ${delta(plan.targetDeltaBps)}-delta ${kind} expiring ${check.proposal.expiryIso} strikes at $${check.proposal.strike}.`,
  );
  log.say(
    `Fair value $${check.measured.fairValue} per option (${pct(check.measured.yieldBps)} of collateral); offer ${check.proposal.size} of ${check.measured.capacity} options.`,
  );
  let size = check.proposal.size;
  if (!check.ok) {
    log.say(`Not compliant (${check.reason}): ${check.explanation}`);
    const s = check.suggestion;
    if (!s?.ok) throw new Error("no compliant proposal found; not proposing");
    log.say(`Taking the suggestion: ${delta(s.targetDeltaBps)} delta, strike $${s.strike}, size ${s.size}.`);
    plan = { ...plan, targetDeltaBps: s.targetDeltaBps, premiumBps: s.premiumBps };
    size = s.size;
  }

  log.step("Dry run the exact proposal");
  const args = { vault, targetDeltaBps: plan.targetDeltaBps, size, premiumBps: plan.premiumBps };
  check = await mcp.call<RiskCheck>("risk_check", args);
  log.say(`Verdict: ${check.reason}. ${check.explanation}`);
  if (!check.ok) throw new Error("the dry run failed; a careful agent does not propose");

  log.step("Propose on-chain (proposeByDelta)");
  const res = await mcp.call<ProposeResult>("propose_epoch", args);
  if (res.openTxHash) log.say(`Opened the epoch (tx ${res.openTxHash}); the vault is locked.`);
  log.say(res.explanation);
  if (res.txHash) log.say(`tx ${res.txHash}`);
  if (!res.accepted) throw new Error(`proposal rejected: ${res.reason}`);
  await trackRecord(mcp, log, state.agent.agentId);
}

async function reckless(mcp: StrikeMcp, vault: string, log: Narrator) {
  const state = await readVault(mcp, vault, log);
  if (state.vault.epochState === "Selling") {
    throw new Error(
      `${state.vault.symbol} is already selling; pick a vault in the Idle or Open state (--vault)`,
    );
  }
  log.step("Choose a reckless at-the-money strike");
  const isCall = state.vault.kind === "covered-call";
  const strike = atTheMoneyStrike(Number(state.spot.price), isCall);
  log.say(
    `Strike $${strike} against spot $${state.spot.price}: |delta| near 0.5, far outside the mandate's band.`,
  );

  log.step("Dry run (risk_check)");
  const check = await mcp.call<RiskCheck>("risk_check", { vault, strike });
  log.say(`Verdict: ${check.reason} (|delta| ${check.measured.delta}). ${check.explanation}`);
  log.say("A careful agent stops here. --reckless sends it anyway with force: true.");

  log.step("Force the proposal on-chain (proposeSeries)");
  const res = await mcp.call<ProposeResult>("propose_epoch", {
    vault,
    strike,
    size: check.proposal.size,
    premiumBps: check.proposal.premiumBps,
    force: true,
  });
  if (res.openTxHash) log.say(`Opened the epoch (tx ${res.openTxHash}).`);
  if (res.accepted) throw new Error("the reckless proposal was accepted, which the mandate should prevent");
  log.say(
    `The contract REJECTED it: ${res.reason}. Slashed ${res.slashed} USDG from the agent's bond (tx ${res.txHash}).`,
  );
  log.say(res.explanation);
  log.say(
    `Agent now: bond ${res.agent.bond} USDG, strikes ${res.agent.strikes}/${res.agent.maxStrikes}, ${res.agent.active ? "still active" : "can no longer propose"}.`,
  );
  await trackRecord(mcp, log, state.agent.agentId);
}

async function settle(mcp: StrikeMcp, vault: string, log: Narrator) {
  const state = await readVault(mcp, vault, log);
  log.step("Settle the expired series");
  const res = await mcp.call<SettleResult>("settle_epoch", { vault });
  log.say(res.explanation);
  log.say(`Series ${res.seriesId}, settlement round ${res.roundId}, tx ${res.txHash}`);
  await trackRecord(mcp, log, state.agent.agentId);
}

async function main() {
  // `pnpm start -- --flag` forwards the "--"; drop it so both invocation styles work.
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const { values } = parseArgs({
    args: argv,
    options: {
      reckless: { type: "boolean" },
      llm: { type: "boolean" },
      settle: { type: "boolean" },
      status: { type: "boolean" },
      vault: { type: "string" },
      "target-delta": { type: "string" },
      buy: { type: "boolean" },
      redeem: { type: "boolean" },
      budget: { type: "string" },
      amount: { type: "string" },
      hedge: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const targetDelta = Number(values["target-delta"] ?? DEFAULT_TARGET_DELTA);
  if (!(targetDelta > 0 && targetDelta < 1))
    throw new Error("--target-delta must be between 0 and 1 (e.g. 0.2)");
  const positive = (flag: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!(n > 0)) throw new Error(`--${flag} must be a positive number, got "${value}"`);
    return n;
  };
  const budget = positive("budget", values.budget) ?? DEFAULT_BUDGET;
  const amount = positive("amount", values.amount);
  const hedge = positive("hedge", values.hedge);

  const log = new Narrator();
  const mode = values.buy
    ? " (buyer mode)"
    : values.redeem
      ? " (buyer: redeem)"
      : values.reckless
        ? " (reckless mode)"
        : values.llm
          ? " (Claude mode)"
          : "";
  console.log(`Strike example agent${mode}`);
  const mcp = await connectStrikeMcp();
  try {
    const info = await mcp.call<StrikeInfo>("strike_info");
    console.log(
      `Connected to the Strike MCP server: chain ${info.chainId}, ${info.mode} mode${info.agentAddress ? ` as ${info.agentAddress}` : ""}.`,
    );
    if (values.buy || values.redeem) {
      if (info.mode === "read-only")
        throw new Error("set STRIKE_AGENT_PRIVATE_KEY (the buyer's key) to buy or redeem");
      if (values.buy) {
        await buyOptions(
          mcp,
          { vault: values.vault, budget, amount, hedge, slippageBps: DEFAULT_SLIPPAGE_BPS },
          log,
        );
      } else await redeemOptions(mcp, { vault: values.vault }, log);
      return;
    }
    const agentId = info.agentAddress ? (await mcp.call<AgentStats>("agent_stats")).agentId : null;
    const vault = await chooseVault(mcp, values.vault, agentId);

    if (values.status) {
      const state = await readVault(mcp, vault, log);
      await trackRecord(mcp, log, state.agent.agentId);
      return;
    }
    if (info.mode === "read-only")
      throw new Error("set STRIKE_AGENT_PRIVATE_KEY (the agent signer's key) to act");
    if (values.settle) await settle(mcp, vault, log);
    else if (values.reckless) await reckless(mcp, vault, log);
    else await propose(mcp, vault, { llm: values.llm === true, targetDelta }, log);
  } finally {
    await mcp.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nAgent stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
