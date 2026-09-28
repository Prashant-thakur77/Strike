// The parts of the Strike MCP tools' structured output this agent reads (see mcp/src/schemas.ts).
import type { Mandate } from "@strike/sdk";
import type { VaultChoice } from "./strategy.js";

export type MandateView = Mandate & { summary: string };

export interface VaultView extends VaultChoice {
  name: string;
  underlying: { symbol: string };
  asset: { symbol: string };
  totalAssets: string;
  mandate: MandateView;
  series: {
    id: string;
    strike: string;
    expiryIso: string;
    premiumBps: number;
    sold: string;
    size: string;
    remaining: string;
  } | null;
}

export interface StrikeInfo {
  chainId: number;
  mode: "read-only" | "agent";
  agentAddress: string | null;
}

export interface VaultState {
  vault: VaultView;
  spot: { price: string | null; status: string; ok: boolean };
  marketOpen: boolean;
  blockTimeIso: string;
  nextExpiryIso: string | null;
  agent: { agentId: string; active: boolean; bond: string; strikes: number };
  nextStep: string;
}

export interface Suggestion {
  targetDeltaBps: number;
  strike: string;
  delta: number;
  size: string;
  premiumBps: number;
  ok: boolean;
  reason: string;
}

export interface RiskCheck {
  vaultSymbol: string;
  isCall: boolean;
  proposal: {
    mode: string;
    strike: string;
    targetDeltaBps: number | null;
    expiryIso: string;
    size: string;
    premiumBps: number;
  };
  ok: boolean;
  reason: string;
  explanation: string;
  measured: { fairValue: string; delta: number; capacity: string; yieldBps: number };
  spot: string;
  suggestion: Suggestion | null;
}

export interface ProposeResult {
  submitted: boolean;
  accepted: boolean | null;
  reason: string;
  explanation: string;
  seriesId: string | null;
  strike: string;
  size: string;
  slashed: string;
  txHash: string | null;
  openTxHash: string | null;
  agent: { bond: string; strikes: number; maxStrikes: number; rejected: number; active: boolean };
}

export interface AgentStats {
  agentId: string;
  status: string;
  active: boolean;
  bond: string;
  strikes: number;
  maxStrikes: number;
  accepted: number;
  rejected: number;
  settledEpochs: number;
  cumulativePnl: string;
  claimableFees: string;
  erc8004Id: string;
  rejectionsUntilInactive: number;
}

export interface SettleResult {
  seriesId: string;
  roundId: string;
  settlementPrice: string | null;
  payout: string;
  premium: string;
  fee: string;
  txHash: string;
  explanation: string;
  agentTrack: { settledEpochs: number; cumulativePnl: string };
}

export interface QuoteResult {
  seriesId: string;
  underlying: string;
  strike: string;
  expiryIso: string;
  premiumBps: number;
  amount: string;
  remaining: string;
  premium: string;
  premiumPerOption: string;
}

export interface HedgePlan {
  underlying: string;
  side: "long" | "short";
  position: string;
  hedgeable: boolean;
  canBuyNow: boolean;
  explanation: string;
  hedge: {
    vaultSymbol: string;
    seriesId: string;
    optionType: "put" | "call";
    strike: string;
    options: string;
    coverage: number;
    premium: string;
    premiumPerOption: string;
    protectedPrice: string;
    effectivePrice: string;
    maxLoss: string;
  } | null;
}

export interface BuyResult {
  vaultSymbol: string;
  seriesId: string;
  underlying: string;
  isCall: boolean;
  strike: string;
  expiryIso: string;
  amount: string;
  premiumPaid: string;
  premiumPerOption: string;
  maxPremium: string;
  maxLoss: string;
  breakeven: string;
  txHash: string;
  explanation: string;
}

export interface RedeemResult {
  vaultSymbol: string;
  seriesId: string;
  status: "settled" | "cancelled";
  settlementPrice: string | null;
  amount: string;
  paid: string;
  paidAsset: string;
  paidValue: string;
  txHash: string;
  explanation: string;
}
