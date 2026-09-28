export const STRIKE_SDK_VERSION = "0.1.0";

export * from "./abi/index.js";
export * from "./chains.js";
export * from "./deployments.js";
export { createStrikeClient, resolveAddresses } from "./client.js";
export type { StrikeAddresses, StrikeClient, StrikeClientConfig, StrikeViemClients } from "./client.js";
export { ERROR_HINTS, StrikeError, describeError, explainError, revertErrorName } from "./errors.js";
export {
  AGENT_STATUSES,
  EPOCH_STATES,
  FEED_STATUSES,
  FEED_STATUS_DESCRIPTIONS,
  MANDATE_REASONS,
  MANDATE_REASON_DESCRIPTIONS,
  agentStatusName,
  epochStateName,
  explainMandateReason,
  feedStatusName,
  mandateReasonCode,
  mandateReasonName,
} from "./names.js";
export type { AgentStatus, EpochState, FeedStatus, MandateReason, ReasonContext } from "./names.js";
export {
  blackScholes,
  clampDeltaToMandate,
  floorToCent,
  roundStrikeToCent,
  maxProposalSize,
  normCdf,
  strikeForDelta,
  suggestProposal,
  tenorYears,
  vaultCapacity,
} from "./pricing.js";
export type { BlackScholesQuote, ProposalSuggestion, ProposalSuggestionInput } from "./pricing.js";
export { type CorporateAction, findSettlementHints, findSettlementRound } from "./settlement.js";
export type { FeedRound, RoundReader } from "./settlement.js";
export type * from "./types.js";
export {
  BPS,
  MAX_PREMIUM_BPS,
  SECONDS_PER_YEAR,
  USDG_DECIMALS,
  WAD,
  bpsToFraction,
  formatAmount,
  formatUsdg,
  formatWad,
  fractionToBps,
  numberToWad,
  parseAmount,
  parseUsdg,
  parseWad,
  wadToNumber,
} from "./units.js";
