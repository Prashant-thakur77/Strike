import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { anchorRecord, chainAnchorSender, decisionLogAddress, readAnchorEpoch } from "./anchor.js";
import { DEFAULT_BUDGET, DEFAULT_SLIPPAGE_BPS, buyOptions, redeemOptions } from "./buyer.js";
import { epochSnapshot, lastSettlement, readClient } from "./chain.js";
import { Journal, marketInputs } from "./journal.js";
import { type PlannerMcp, planWithClaudeCode } from "./claudeCode.js";
import { CLAUDE_MODEL, describeClaudeError, planWithClaude } from "./llm.js";
import { type StrikeMcp, connectStrikeMcp, strikeMcpCommand } from "./mcp.js";
import { joinStrike, parseBond, parseVaultSpec } from "./onboard.js";
import { type PlannerKind, parsePlanner, plannerLabel, selectPlanner } from "./planner.js";
import { type RecordAction, type RecordAnchorer, txUrl, writeRecord } from "./record.js";
import {
  DEFAULT_TARGET_DELTA,
  PROFILES,
  type Plan,
  type Profile,
  atTheMoneyStrike,
  capSize,
  deterministicPlan,
  enforceMandate,
  parseProfile,
  pickVault,
  profileLabel,
  profilePlan,
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
  --llm              Let Claude choose the target delta and premium factor; falls back to the
                     default strategy. Uses the Claude API when ANTHROPIC_API_KEY is set, else the
                     Claude Code CLI (\`claude\`, logged in with a Claude subscription, or
                     CLAUDE_CODE_OAUTH_TOKEN from \`claude setup-token\`).
  --planner <p>      With --llm: force the planner, api or claude-code.
  --dry-run          Propose run up to the final dry run, then stop: nothing is sent (works
                     without STRIKE_AGENT_PRIVATE_KEY).
  --settle           Settle the vault's expired series.
  --status           Print the vault and agent state only.
  --vault <v>        Vault address or share symbol (default: the first vault this agent runs
                     that can take a proposal, covered calls first).
  --target-delta <d> Target |delta| for the default strategy (default ${DEFAULT_TARGET_DELTA}).
  --profile <p>      A named rule instead of the default: ${Object.keys(PROFILES).join(" or ")}.
                     conservative: ${PROFILES.conservative!.targetDelta} delta at ${PROFILES.conservative!.premiumBps / 100}% of fair value, at
                     most ${PROFILES.conservative!.sizeShare * 100}% of the vault's capacity. The record names the planner
                     "rule: <profile>".
  --log <dir>        After a propose, --reckless or --settle run, write a decision record to
                     <dir>/<YYYY-MM-DD>-<vault symbol>.md and .json (relative to the directory the
                     command was run from; inputs, reasoning, dry run,
                     transactions, result, track record). With --settle, a series the keeper already
                     settled this week is recorded instead of failing.
  --anchor           With --log: also anchor the record on-chain. The agent's signer sends
                     DecisionLog.record(agentId, vault, epoch, keccak256 of the JSON record, its
                     GitHub URL); the transaction is added to the record. STRIKE_DECISION_LOG
                     overrides the contract, STRIKE_RECORD_BASE_URL the URL's directory.

Buyer modes (STRIKE_AGENT_PRIVATE_KEY is the buyer's key; it pays the premium in USDG):
  --buy              Find a live series (--vault to choose) and buy options within the budget,
                     explaining the premium, max loss and breakeven.
  --budget <usdg>    Most USDG to spend, slippage included (default ${DEFAULT_BUDGET}).
  --amount <n>       Buy at most this many options (default: what the budget allows).
  --hedge <tokens>   With --buy: protect a holding of this many stock tokens; hedge_plan picks
                     the put series and sizes the purchase.
  --redeem           Redeem this wallet's options of settled series (--vault, or every vault).

Join as a new agent (STRIKE_AGENT_PRIVATE_KEY becomes the agent's owner and signer; it pays the bond):
  --register         Dry-run register_agent (signer free, USDG for the bond, the minimum bond,
                     slash and strike rules), then register and bond. Safe to re-run.
  --bond <usdg>      With --register: USDG to bond (default: the registry's minimum bond; an
                     agent that is already bonded is left alone).
  --create-vault <SYMBOL:call|put>
                     With --register: then dry-run and create your own vault on that stock
                     (e.g. TSLA:put), run by this agent, with the default mandate.

Environment: STRIKE_CHAIN_ID, STRIKE_RPC_URL, STRIKE_AGENT_PRIVATE_KEY (passed to the MCP server),
STRIKE_MCP_COMMAND (server command; default: pnpm --silent --filter @strike/mcp dev).
Claude Code planner: STRIKE_CLAUDE_CODE_MODEL (default ${CLAUDE_MODEL}), CLAUDE_CODE_PATH (the CLI),
STRIKE_PLANNER_MCP_URL (a read-only HTTP MCP endpoint instead of a local read-only server).`;

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

async function readVault(
  mcp: StrikeMcp,
  vault: string,
  log: Narrator,
  journal?: Journal,
): Promise<VaultState> {
  log.step("Read the vault");
  const s = await mcp.call<VaultState>("vault_state", { vault });
  journal?.vaultRead(s);
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

async function trackRecord(mcp: StrikeMcp, log: Narrator, agentId: string, journal?: Journal) {
  log.step("Track record");
  const a = await mcp.call<AgentStats>("agent_stats", { agentId });
  journal?.tracked(a);
  log.say(
    `Agent #${a.agentId} (${a.status}${a.active ? "" : ", cannot propose"}): ${a.accepted} accepted, ${a.rejected} rejected, ${a.strikes}/${a.maxStrikes} strikes, bond ${a.bond} USDG`,
  );
  log.say(
    `Settled epochs ${a.settledEpochs}, cumulative depositor PnL ${a.cumulativePnl} USDG, claimable fees ${a.claimableFees} USDG${a.erc8004Id !== "0" ? `, ERC-8004 id ${a.erc8004Id}` : ""}`,
  );
}

/** What `--llm` asked for: whether Claude plans, and which planner (undefined: pick one, see selectPlanner). */
interface DecideOptions {
  llm: boolean;
  planner?: PlannerKind;
  targetDelta: number;
  /** The rule-based profile (`--profile`), used when Claude does not plan. */
  profile: Profile;
  /** Stop after the dry run; send nothing. */
  dryRun?: boolean;
}

/** Where the Claude Code planner reaches the Strike MCP server: STRIKE_PLANNER_MCP_URL, else a local read-only one. */
function plannerMcp(): PlannerMcp {
  const url = process.env.STRIKE_PLANNER_MCP_URL?.trim();
  return url ? { kind: "http", url } : { kind: "stdio", ...strikeMcpCommand() };
}

/** Ask Claude (through the API or Claude Code) for a plan; null with a note when there is none. */
async function planWithLlm(
  mcp: StrikeMcp,
  state: VaultState,
  opts: DecideOptions,
  log: Narrator,
  notes: string[],
): Promise<{ plan: Plan; kind: PlannerKind; model: string } | null> {
  const choice = selectPlanner(opts.planner);
  if (!choice.kind) {
    log.say(`Claude is unavailable (${choice.reason}); using the default strategy.`);
    notes.push(`Claude was unavailable (${choice.reason}); the agent used the default strategy.`);
    return null;
  }
  const kind = choice.kind;
  const via = kind === "api" ? "the Claude API" : "the Claude Code CLI";
  log.step(`Ask Claude for this epoch's plan (via ${via})`);
  const skill = await mcp.client.readResource({ uri: "strike://skill" });
  const text = skill.contents.map((c) => ("text" in c ? c.text : "")).join("\n");
  const narrate = (l: string) => log.say(l);
  if (kind === "claude-code") {
    const res = await planWithClaudeCode({
      vault: state.vault.address,
      skill: text,
      narrate,
      mcp: plannerMcp(),
      model: process.env.STRIKE_CLAUDE_CODE_MODEL?.trim() || undefined,
    });
    if (res.plan) return { plan: res.plan, kind, model: res.model };
    log.say(`Claude Code gave no plan (${res.reason}); using the default strategy.`);
    notes.push(`Claude Code gave no plan (${res.reason}); the agent used the default strategy.`);
    return null;
  }
  try {
    const plan = await planWithClaude({ mcp: mcp.client, vault: state.vault.address, skill: text, narrate });
    if (plan) return { plan, kind, model: CLAUDE_MODEL };
    log.say("Claude submitted no plan; using the default strategy.");
    notes.push("Claude submitted no plan; the agent used the default strategy.");
  } catch (err) {
    log.say(`Claude is unavailable (${describeClaudeError(err)}); using the default strategy.`);
    notes.push(`Claude was unavailable (${describeClaudeError(err)}); the agent used the default strategy.`);
  }
  return null;
}

async function decide(
  mcp: StrikeMcp,
  state: VaultState,
  opts: DecideOptions,
  log: Narrator,
  journal: Journal,
): Promise<Plan> {
  const mandate = state.vault.mandate;
  const notes: string[] = [];
  const llm = opts.llm ? await planWithLlm(mcp, state, opts, log, notes) : null;
  if (llm) {
    const { plan: enforced, adjustments } = enforceMandate(llm.plan, mandate);
    const label = plannerLabel(llm.kind, llm.model);
    for (const a of adjustments) log.say(`Mandate guard in the agent code adjusted Claude's plan: ${a}`);
    log.say(
      `Claude's plan: ${delta(enforced.targetDeltaBps)} delta at ${pct(enforced.premiumBps)} of fair value (${label})`,
    );
    log.say(`Why: ${enforced.reasoning}`);
    journal.decided({
      strategy: "claude",
      targetDeltaBps: enforced.targetDeltaBps,
      premiumBps: enforced.premiumBps,
      reasoning: enforced.reasoning,
      notes: [
        `${label}.`,
        ...adjustments.map((a) => `Mandate guard in the agent code adjusted Claude's plan: ${a}.`),
      ],
      planner: { kind: llm.kind, model: llm.model, label },
    });
    return enforced;
  }
  const profile = opts.profile;
  const named = profile.name !== "default";
  log.step(`Choose the target delta${named ? ` (profile: ${profile.name})` : ""}`);
  const plan = named ? profilePlan(profile, mandate) : deterministicPlan(mandate, opts.targetDelta);
  log.say(plan.reasoning);
  journal.decided({
    strategy: "default",
    targetDeltaBps: plan.targetDeltaBps,
    premiumBps: plan.premiumBps,
    reasoning: plan.reasoning,
    notes,
    planner: { kind: "rule", model: profile.name, label: profileLabel(profile) },
  });
  return plan;
}

async function propose(mcp: StrikeMcp, vault: string, opts: DecideOptions, log: Narrator, journal: Journal) {
  const state = await readVault(mcp, vault, log, journal);
  if (state.vault.epochState === "Selling") {
    const message = `${state.vault.symbol} is already selling this week's series; settle it after expiry first`;
    journal.finish({ status: "skipped", summary: `${message}.`, seriesId: state.vault.series?.id ?? null });
    throw new Error(message);
  }
  if (!state.agent.active) throw new Error(`agent #${state.agent.agentId} cannot propose (bond or strikes)`);

  let plan = await decide(mcp, state, opts, log, journal);

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
  // A profile that offers less than the mandate allows caps the size at its share of capacity.
  const share = opts.profile.sizeShare;
  const sized = (offered: string): string => {
    if (share >= 1) return offered;
    const capped = capSize(offered, check.measured.capacity, share);
    if (capped === offered) return offered;
    const pctText = `${Math.round(share * 100)}% of capacity`;
    log.say(`Profile "${opts.profile.name}" offers at most ${pctText}: size ${offered} → ${capped}.`);
    journal.note(`Profile "${opts.profile.name}" capped the size at ${pctText}: ${offered} → ${capped}.`);
    return capped;
  };
  let size = sized(check.proposal.size);
  if (!check.ok) {
    log.say(`Not compliant (${check.reason}): ${check.explanation}`);
    const s = check.suggestion;
    journal.dryRan(check);
    journal.note(`The first dry run was not compliant (${check.reason}): ${check.explanation}`);
    if (!s?.ok) {
      journal.finish({
        status: "not-sent",
        summary: "No compliant proposal found, so the agent did not propose.",
        reason: check.reason,
      });
      throw new Error("no compliant proposal found; not proposing");
    }
    log.say(`Taking the suggestion: ${delta(s.targetDeltaBps)} delta, strike $${s.strike}, size ${s.size}.`);
    journal.note(
      `Took the risk check's suggestion: ${delta(s.targetDeltaBps)} delta at ${pct(s.premiumBps)} of fair value, size ${s.size}.`,
    );
    if (journal.decision) {
      journal.decision.targetDeltaBps = s.targetDeltaBps;
      journal.decision.premiumBps = s.premiumBps;
    }
    plan = { ...plan, targetDeltaBps: s.targetDeltaBps, premiumBps: s.premiumBps };
    size = sized(s.size);
  }

  log.step("Dry run the exact proposal");
  const args = { vault, targetDeltaBps: plan.targetDeltaBps, size, premiumBps: plan.premiumBps };
  check = await mcp.call<RiskCheck>("risk_check", args);
  log.say(`Verdict: ${check.reason}. ${check.explanation}`);
  journal.dryRan(check);
  if (!check.ok) {
    journal.finish({
      status: "not-sent",
      summary: `The dry run failed (${check.reason}); a careful agent does not propose.`,
      reason: check.reason,
    });
    throw new Error("the dry run failed; a careful agent does not propose");
  }
  if (opts.dryRun) {
    log.say("--dry-run: stopping here; nothing was sent.");
    journal.finish({
      status: "not-sent",
      summary: "Dry run only (--dry-run): the proposal passed the risk check and was not sent.",
      strike: check.proposal.strike,
      expiryIso: check.proposal.expiryIso,
      size: check.proposal.size,
    });
    return;
  }

  log.step("Propose on-chain (proposeByDelta)");
  const res = await mcp.call<ProposeResult>("propose_epoch", args);
  journal.proposed(res, "proposeByDelta", check.proposal.expiryIso);
  if (res.openTxHash) log.say(`Opened the epoch (tx ${res.openTxHash}); the vault is locked.`);
  log.say(res.explanation);
  if (res.txHash) log.say(`tx ${res.txHash}`);
  if (!res.accepted) throw new Error(`proposal rejected: ${res.reason}`);
  await trackRecord(mcp, log, state.agent.agentId, journal);
}

async function reckless(mcp: StrikeMcp, vault: string, log: Narrator, journal: Journal) {
  const state = await readVault(mcp, vault, log, journal);
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
  journal.decided({
    strategy: "reckless",
    targetDeltaBps: null,
    premiumBps: null,
    reasoning: `Strike $${strike} against spot $${state.spot.price}: |delta| near 0.5, far outside the mandate's band. Sent with force: true on purpose, to show the contract rejecting it and slashing the agent's bond.`,
    notes: [],
  });

  log.step("Dry run (risk_check)");
  const check = await mcp.call<RiskCheck>("risk_check", { vault, strike });
  log.say(`Verdict: ${check.reason} (|delta| ${check.measured.delta}). ${check.explanation}`);
  journal.dryRan(check);
  log.say("A careful agent stops here. --reckless sends it anyway with force: true.");

  log.step("Force the proposal on-chain (proposeSeries)");
  const res = await mcp.call<ProposeResult>("propose_epoch", {
    vault,
    strike,
    size: check.proposal.size,
    premiumBps: check.proposal.premiumBps,
    force: true,
  });
  journal.proposed(res, "proposeSeries", check.proposal.expiryIso);
  if (res.openTxHash) log.say(`Opened the epoch (tx ${res.openTxHash}).`);
  if (res.accepted) throw new Error("the reckless proposal was accepted, which the mandate should prevent");
  log.say(
    `The contract REJECTED it: ${res.reason}. Slashed ${res.slashed} USDG from the agent's bond (tx ${res.txHash}).`,
  );
  log.say(res.explanation);
  log.say(
    `Agent now: bond ${res.agent.bond} USDG, strikes ${res.agent.strikes}/${res.agent.maxStrikes}, ${res.agent.active ? "still active" : "can no longer propose"}.`,
  );
  await trackRecord(mcp, log, state.agent.agentId, journal);
}

/** Days back a settlement still counts as this week's, for a --settle --log run after the keeper settled. */
const RECENT_SETTLEMENT_DAYS = 7;

async function settle(mcp: StrikeMcp, vault: string, log: Narrator, journal: Journal, recording: boolean) {
  const state = await readVault(mcp, vault, log, journal);
  if (recording && state.vault.epochState !== "Selling") {
    // The keeper (keeper.yml, every 10 minutes) settles expired series itself; record its settlement.
    await recordKeeperSettlement(mcp, state, log, journal);
    return;
  }
  if (recording) await readMarket(state, journal); // the running epoch's opening snapshot, before it closes
  log.step("Settle the expired series");
  const res = await mcp.call<SettleResult>("settle_epoch", { vault });
  log.say(res.explanation);
  log.say(`Series ${res.seriesId}, settlement round ${res.roundId}, tx ${res.txHash}`);
  journal.tx("settle", res.txHash);
  journal.finish({
    status: "settled",
    summary: res.explanation,
    seriesId: res.seriesId,
    settlementPrice: res.settlementPrice,
    payout: `${res.payout} ${state.vault.asset.symbol}`,
    premium: res.premium,
    fee: res.fee,
    settledBy: "agent",
  });
  await trackRecord(mcp, log, state.agent.agentId, journal);
}

async function recordKeeperSettlement(mcp: StrikeMcp, state: VaultState, log: Narrator, journal: Journal) {
  log.step("Look up this week's settlement");
  const last = await lastSettlement(readClient(chainEnv(journal.chainId)), state.vault.address);
  const now = Date.parse(state.blockTimeIso) / 1000;
  if (!last || last.expiry < now - RECENT_SETTLEMENT_DAYS * 86_400) {
    const summary = `${state.vault.symbol} has no live series (epoch ${state.vault.epochState}) and no settlement in the last ${RECENT_SETTLEMENT_DAYS} days: nothing to settle.`;
    log.say(summary);
    journal.finish({ status: "skipped", summary });
  } else {
    const summary =
      last.settlementPrice === null
        ? `Already settled by the keeper without a price: nothing was sold. The vault is unlocked.`
        : `Already settled by the keeper at $${last.settlementPrice}: ${last.payout} to option holders, ${last.premium} USDG premium collected, ${last.fee} USDG fee. The vault is unlocked.`;
    log.say(summary);
    log.say(`Series ${last.seriesId}, tx ${last.txHash}`);
    journal.tx("settle (keeper)", last.txHash);
    journal.finish({
      status: "settled",
      summary,
      seriesId: last.seriesId,
      settlementPrice: last.settlementPrice,
      payout: last.payout,
      premium: last.premium,
      fee: last.fee,
      settledBy: "keeper",
    });
  }
  await trackRecord(mcp, log, state.agent.agentId, journal);
}

/** STRIKE_* environment for direct chain reads, pinned to the chain the MCP server reported. */
const chainEnv = (chainId: number) => ({ ...process.env, STRIKE_CHAIN_ID: String(chainId) });

/** Fill the record's market inputs (once): the epoch's opening snapshot while one runs, else live values. */
async function readMarket(state: VaultState, journal: Journal) {
  if (journal.market) return;
  const snapshot = await epochSnapshot(readClient(chainEnv(journal.chainId)), state.vault.address);
  journal.market = marketInputs(state, snapshot);
}

/** `--anchor`: hash the record, send DecisionLog.record with the agent's signer, add the transaction. */
function chainAnchorer(chainId: number): RecordAnchorer {
  const contract = decisionLogAddress(chainId);
  const send = chainAnchorSender(chainId, contract);
  return async (record, fileName) => {
    const epoch = await readAnchorEpoch(chainId, record.vault.address, record.action);
    const anchored = await anchorRecord(record, fileName, {
      contract,
      epoch,
      send,
      baseUrl: process.env.STRIKE_RECORD_BASE_URL || undefined,
      txUrl: (h) => txUrl(chainId, h),
    });
    console.log(
      `\nAnchored the record on-chain: DecisionLog.record tx ${anchored.anchor?.txHash} (epoch ${epoch})`,
    );
    return anchored;
  };
}

/** Write the decision record of a finished (or stopped) run; never hides the run's own error. */
async function writeDecisionRecord(
  mcp: StrikeMcp,
  journal: Journal,
  dir: string,
  error?: string,
  anchor?: RecordAnchorer,
) {
  const state = journal.state;
  if (!state) return;
  try {
    await readMarket(state, journal);
  } catch (err) {
    journal.market = marketInputs(state, null);
    console.error(`(decision record: could not read the epoch snapshot, using live inputs: ${String(err)})`);
  }
  if (!journal.track) {
    try {
      journal.tracked(await mcp.call<AgentStats>("agent_stats", { agentId: state.agent.agentId }));
    } catch {
      // leave the track record out rather than fail the record
    }
  }
  const record = journal.build(error);
  if (!record) return;
  const paths = await writeRecord(dir, record, anchor);
  console.log(`\nDecision record: ${paths.md} (and ${paths.json})`);
  if (paths.anchorError)
    console.error(`Could not anchor the record on-chain (written unanchored): ${paths.anchorError}`);
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
      planner: { type: "string" },
      "dry-run": { type: "boolean" },
      settle: { type: "boolean" },
      status: { type: "boolean" },
      vault: { type: "string" },
      "target-delta": { type: "string" },
      profile: { type: "string" },
      buy: { type: "boolean" },
      redeem: { type: "boolean" },
      budget: { type: "string" },
      amount: { type: "string" },
      hedge: { type: "string" },
      log: { type: "string" },
      anchor: { type: "boolean" },
      register: { type: "boolean" },
      bond: { type: "string" },
      "create-vault": { type: "string" },
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
  const profile = parseProfile(values.profile);
  if (values.profile !== undefined && values["target-delta"] !== undefined)
    throw new Error("--profile and --target-delta both set the target delta: use one of them");
  if (values.profile !== undefined && values.llm)
    throw new Error("--profile is a rule; it does not go with --llm");
  const positive = (flag: string, value: string | undefined) => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!(n > 0)) throw new Error(`--${flag} must be a positive number, got "${value}"`);
    return n;
  };
  const budget = positive("budget", values.budget) ?? DEFAULT_BUDGET;
  const amount = positive("amount", values.amount);
  const hedge = positive("hedge", values.hedge);
  if (values.log !== undefined && !values.log.trim()) throw new Error("--log needs a directory");
  // Relative to where the command was run: pnpm runs the script in agents/example but sets INIT_CWD to the caller's
  // directory, so `pnpm --filter @strike/agent-example start --log docs/agent-log` from the repo root works.
  const logArg = values.log?.trim();
  const logDir = logArg ? resolve(process.env.INIT_CWD ?? process.cwd(), logArg) : undefined;
  if (values.anchor && !logDir) throw new Error("--anchor goes with --log <dir>");

  if (!values.register && (values.bond !== undefined || values["create-vault"] !== undefined)) {
    throw new Error("--bond and --create-vault go with --register");
  }
  const planner = parsePlanner(values.planner);
  if (planner && !values.llm) throw new Error("--planner goes with --llm");
  const dryRun = values["dry-run"] === true;
  if (
    dryRun &&
    (values.reckless || values.settle || values.status || values.buy || values.redeem || values.register)
  ) {
    throw new Error("--dry-run goes with a propose run (the default mode or --llm)");
  }
  if (dryRun && values.anchor) throw new Error("--dry-run sends nothing, so it cannot --anchor");
  const bond = values.register ? parseBond(values.bond) : undefined;
  const createVault =
    values["create-vault"] !== undefined ? parseVaultSpec(values["create-vault"]) : undefined;

  const log = new Narrator();
  const mode = values.register
    ? " (joining as a new agent)"
    : values.buy
      ? " (buyer mode)"
      : values.redeem
        ? " (buyer: redeem)"
        : values.reckless
          ? " (reckless mode)"
          : values.llm
            ? ` (Claude mode${dryRun ? ", dry run" : ""})`
            : profile.name !== "default"
              ? ` (${profileLabel(profile)}${dryRun ? ", dry run" : ""})`
              : dryRun
                ? " (dry run)"
                : "";
  console.log(`Strike example agent${mode}`);
  const mcp = await connectStrikeMcp();
  try {
    const info = await mcp.call<StrikeInfo>("strike_info");
    console.log(
      `Connected to the Strike MCP server: chain ${info.chainId}, ${info.mode} mode${info.agentAddress ? ` as ${info.agentAddress}` : ""}.`,
    );
    if (values.register) {
      if (info.mode === "read-only")
        throw new Error("set STRIKE_AGENT_PRIVATE_KEY (the new agent's key) to register");
      const joined = await joinStrike(mcp, { bond, createVault }, log);
      console.log(
        `\nAgent #${joined.agentId} ${joined.active ? "is bonded and may propose" : "is registered but cannot propose yet"}${joined.vault ? `; it runs ${joined.vaultSymbol} (${joined.vault})` : ""}.`,
      );
      return;
    }
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
    if (info.mode === "read-only" && !dryRun)
      throw new Error("set STRIKE_AGENT_PRIVATE_KEY (the agent signer's key) to act");
    const action: RecordAction = values.settle ? "settle" : values.reckless ? "reckless" : "propose";
    const journal = new Journal(action, info.chainId, info.agentAddress);
    const anchor = values.anchor ? chainAnchorer(info.chainId) : undefined;
    let failure: string | undefined;
    try {
      if (values.settle) await settle(mcp, vault, log, journal, logDir !== undefined);
      else if (values.reckless) await reckless(mcp, vault, log, journal);
      else
        await propose(
          mcp,
          vault,
          { llm: values.llm === true, planner, targetDelta, profile, dryRun },
          log,
          journal,
        );
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (logDir) {
        try {
          await writeDecisionRecord(mcp, journal, logDir, failure && `Agent stopped: ${failure}`, anchor);
        } catch (err) {
          console.error(`\nCould not write the decision record: ${String(err)}`);
          process.exitCode = 1;
        }
      }
    }
  } finally {
    await mcp.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nAgent stopped: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
