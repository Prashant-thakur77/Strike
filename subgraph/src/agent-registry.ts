// AgentRegistry: agents, their keys, USDG bond, strikes, slashing and track record.
import { BigDecimal, BigInt, ethereum } from "@graphprotocol/graph-ts";
import {
  AgentRegistered,
  AgentRegistry,
  BondPosted,
  EpochResultRecorded,
  ParamsSet,
  PayoutSet,
  ProposalRecorded,
  ReputationFeedback as ReputationFeedbackEvent,
  SignerSet,
  Slashed,
  StatusSet,
  UnbondRequested,
  Unbonded,
} from "../generated/AgentRegistry/AgentRegistry";
import { Agent, ReputationFeedback } from "../generated/schema";
import { BD_ZERO, ZERO, agentStatusName, eventId, getProtocol, minBigInt, uint256Id } from "./helpers";

function loadAgent(agentId: BigInt): Agent | null {
  return Agent.load(uint256Id(agentId));
}

function acceptanceRate(accepted: i32, rejected: i32): BigDecimal {
  const total = accepted + rejected;
  if (total == 0) return BD_ZERO;
  return BigDecimal.fromString(accepted.toString()).div(BigDecimal.fromString(total.toString()));
}

function touch(agent: Agent, event: ethereum.Event): void {
  agent.updatedAt = event.block.timestamp;
  agent.save();
}

export function handleAgentRegistered(event: AgentRegistered): void {
  const agentId = event.params.agentId;
  let agent = loadAgent(agentId);
  if (agent != null) {
    // setIdentity re-emits AgentRegistered with the new ERC-8004 id.
    agent.erc8004Id = event.params.erc8004Id;
    touch(agent, event);
    return;
  }

  agent = new Agent(uint256Id(agentId));
  agent.agentId = agentId;
  agent.owner = event.params.owner;
  agent.signer = event.params.signer;
  // `register` sets the payout address without emitting it.
  const payout = AgentRegistry.bind(event.address).try_payoutOf(agentId);
  agent.payout = payout.reverted ? event.params.owner : payout.value;
  agent.erc8004Id = event.params.erc8004Id;
  agent.status = "Active";
  agent.bond = ZERO;
  agent.unbonding = ZERO;
  agent.strikes = 0;
  agent.accepted = 0;
  agent.rejected = 0;
  agent.acceptanceRate = BD_ZERO;
  agent.totalSlashed = ZERO;
  agent.totalPremiumGenerated = ZERO;
  agent.totalPayoutValue = ZERO;
  agent.cumulativePnl = ZERO;
  agent.settledEpochs = 0;
  agent.totalFeesEarned = ZERO;
  agent.reputationFeedbackCount = 0;
  agent.registeredAt = event.block.timestamp;
  agent.registeredAtBlock = event.block.number;
  touch(agent, event);

  const p = getProtocol();
  p.agentCount += 1;
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleSignerSet(event: SignerSet): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  agent.signer = event.params.signer;
  touch(agent, event);
}

export function handlePayoutSet(event: PayoutSet): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  agent.payout = event.params.payout;
  touch(agent, event);
}

export function handleBondPosted(event: BondPosted): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  agent.bond = agent.bond.plus(event.params.amount);
  touch(agent, event);

  const p = getProtocol();
  p.totalBonded = p.totalBonded.plus(event.params.amount);
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleUnbondRequested(event: UnbondRequested): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  const amount = minBigInt(event.params.amount, agent.bond);
  agent.bond = agent.bond.minus(amount);
  agent.unbonding = agent.unbonding.plus(event.params.amount);
  agent.unbondAt = event.params.availableAt;
  touch(agent, event);
}

export function handleUnbonded(event: Unbonded): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  const amount = minBigInt(event.params.amount, agent.unbonding);
  agent.unbonding = agent.unbonding.minus(amount);
  touch(agent, event);

  const p = getProtocol();
  p.totalBonded = p.totalBonded.minus(minBigInt(event.params.amount, p.totalBonded));
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleSlashed(event: Slashed): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  const amount = event.params.amount;
  // AgentRegistry.slash takes the bond first, then the unbonding queue.
  const fromBond = minBigInt(amount, agent.bond);
  agent.bond = agent.bond.minus(fromBond);
  agent.unbonding = agent.unbonding.minus(minBigInt(amount.minus(fromBond), agent.unbonding));
  agent.strikes = event.params.strikes.toI32();
  agent.rejected += 1;
  agent.acceptanceRate = acceptanceRate(agent.accepted, agent.rejected);
  agent.totalSlashed = agent.totalSlashed.plus(amount);
  touch(agent, event);

  const p = getProtocol();
  p.totalSlashed = p.totalSlashed.plus(amount);
  p.totalBonded = p.totalBonded.minus(minBigInt(amount, p.totalBonded));
  p.updatedAt = event.block.timestamp;
  p.save();
}

export function handleStatusSet(event: StatusSet): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  const status = agentStatusName(event.params.status);
  agent.status = status;
  // Reinstating an agent clears its strikes (AgentRegistry.setStatus).
  if (status == "Active") agent.strikes = 0;
  touch(agent, event);
}

export function handleProposalRecorded(event: ProposalRecorded): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  // Only accepted proposals are recorded here; rejections are counted by Slashed.
  if (!event.params.accepted) return;
  agent.accepted += 1;
  agent.acceptanceRate = acceptanceRate(agent.accepted, agent.rejected);
  touch(agent, event);
}

export function handleParamsSet(event: ParamsSet): void {
  const p = getProtocol();
  p.minBond = event.params.minBond;
  p.slashAmount = event.params.slashAmount;
  p.maxStrikes = event.params.maxStrikes.toI32();
  p.unbondDelay = event.params.unbondDelay.toI32();
  p.updatedAt = event.block.timestamp;
  p.save();
}

/// Emitted by EpochManager.settle for the proposing agent (before the manager's EpochSettled).
export function handleEpochResultRecorded(event: EpochResultRecorded): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;
  agent.lastEpochPnl = event.params.pnl;
  agent.cumulativePnl = event.params.cumulativePnl;
  agent.settledEpochs = event.params.settledEpochs.toI32();
  touch(agent, event);
}

/// ERC-8004 feedback for a settled epoch ("strike.epoch.pnl") or a mandate rejection ("strike.mandate.rejection").
export function handleReputationFeedback(event: ReputationFeedbackEvent): void {
  const agent = loadAgent(event.params.agentId);
  if (agent == null) return;

  const f = new ReputationFeedback(eventId(event));
  f.agent = agent.id;
  f.agentId = event.params.agentId;
  f.erc8004Id = event.params.erc8004Id;
  f.value = event.params.value;
  f.tag = event.params.tag;
  f.posted = event.params.posted;
  f.timestamp = event.block.timestamp;
  f.blockNumber = event.block.number;
  f.transactionHash = event.transaction.hash;
  f.save();

  agent.reputationFeedbackCount += 1;
  touch(agent, event);
}
