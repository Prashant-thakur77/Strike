export const STRIKE_SDK_VERSION = "0.1.0";

export * from "./abi/index.js";
export * from "./chains.js";
export {
  STRIKE_CONFIG_FILE,
  loadStrikeConfig,
  locateStrikeConfig,
  strikeChainConfig,
  strikeExplorerUrl,
  strikeSecretName,
  validateStrikeConfig,
} from "./config.js";
export type {
  LoadStrikeConfigOptions,
  StrikeChainConfig,
  StrikeConfig,
  StrikeSecretRole,
  StrikeX402Asset,
  StrikeX402Config,
} from "./config.js";
export {
  AGENT_REGISTRY_EIP712,
  DEFAULT_CONSENT_TTL,
  REGISTER_CONSENT_TYPES,
  SET_SIGNER_CONSENT_TYPES,
  consentSignerOf,
  defaultAgentRegistryDomain,
  registerConsentTypedData,
  setSignerConsentTypedData,
} from "./consent.js";
export type {
  AgentRegistryDomain,
  RegisterConsentMessage,
  RegisterConsentTypedData,
  RegistryVersion,
  SetSignerConsentMessage,
  SetSignerConsentTypedData,
  SignerConsent,
} from "./consent.js";
export * from "./deployments.js";
export {
  ANCHOR_SECTION_HEADING,
  ANCHOR_TX_LABEL,
  checkAnchorReceipt,
  decisionRecordHash,
  decisionRecordedEvents,
  epochLogHash,
  hashText,
  rawGithubUrl,
  recordAnchorOf,
  recordIdentityOf,
  recordMatchRank,
  unanchoredRecordJson,
  verifyAnchorTx,
  verifyDecisionAnchor,
} from "./decisionRecord.js";
export type {
  AnchorExpectation,
  AnchorReader,
  AnchorReceipt,
  AnchorTxResult,
  AnchorTxStatus,
  DecisionAnchorCheck,
  DecisionRecordAnchor,
  DecisionRecordedEvent,
  RecordIdentity,
  SeriesTarget,
} from "./decisionRecord.js";
export { DECISION_TOPICS, answerDecisionQuestion, decisionTopicOf } from "./decisionQa.js";
export type { DecisionAnswer, DecisionCitation, DecisionTopic } from "./decisionQa.js";
export { createStrikeClient, resolveAddresses } from "./client.js";
export {
  ALCHEMY_NETWORKS,
  RPC_COOLDOWN_MS,
  alchemyApiKey,
  alchemyEndpoint,
  describeRpc,
  describeRpcEndpoint,
  isLocalRpcUrl,
  publicRpcUrl,
  redactRpcUrl,
  rpcEndpointsFor,
  rpcTransportFor,
  rpcUrlFor,
  transportFromEndpoints,
} from "./rpc.js";
export type { RpcEndpoint, RpcProvider } from "./rpc.js";
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
export {
  DEFAULT_MANDATE,
  MAX_TENOR_CAP,
  MIN_PREMIUM_FLOOR_BPS,
  isValidMandate,
  mandateProblems,
} from "./mandate.js";
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
export {
  DEFAULT_SHOCKS,
  PRICER_INPUT_ERRORS,
  explainSeriesRisk,
  riskEngineError,
  settlementPayout,
  shockedSpot,
  vaultExposure,
} from "./risk.js";
export type { Greeks, LastBuyImpliedVol, RiskScenario, SeriesRisk, SeriesRiskOptions } from "./risk.js";
export {
  DEPLOY_SEED_PRICES,
  MAINNET_CHAINLINK_FEEDS,
  MAINNET_FEEDS_CHAIN_ID,
  MIRROR_ROUND_STATUSES,
  MULTICALL3,
  aggregatorProxyAbi,
  auditMirror,
  auditSettlement,
  classifyMirrorRounds,
  fmtAnswer,
  largestPushGap,
  mirrorFeedTargets,
  mirrorRpcEndpoints,
} from "./mirror.js";
export type {
  CheckedStatus,
  MainnetRound,
  ManagerOracleCheck,
  MirrorAudit,
  MirrorAuditOptions,
  MirrorClientOptions,
  MirrorCounts,
  MirrorFeedAudit,
  MirrorFeedTarget,
  MirrorGap,
  MirrorRoundCheck,
  MirrorRoundStatus,
  OracleFeedCheck,
  SeriesSettlementCheck,
  SettlementAudit,
  SettlementAuditOptions,
  SettlementCheckStatus,
} from "./mirror.js";
export {
  STATEMENT_ACTIONS,
  STATEMENT_ACTION_DESCRIPTIONS,
  STATEMENT_CSV_COLUMNS,
  StatementInputError,
  buildRows,
  buildStatement,
  checkCommand,
  csvCell,
  deploymentId,
  eventSignature,
  optionSymbol,
  parseStatementQuery,
  statement,
  statementBound,
  statementChainIds,
  statementChecks,
  statementCsv,
  statementTotals,
} from "./statement.js";
export type {
  StatementAction,
  StatementAmount,
  StatementCheck,
  StatementContext,
  StatementLog,
  StatementOptions,
  StatementRow,
  StatementSeriesMeta,
  StatementSource,
  StatementTotal,
  StatementVaultMeta,
  WalletStatement,
} from "./statement.js";
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
