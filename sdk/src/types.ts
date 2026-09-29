import type { Address, Hex, TransactionReceipt } from "viem";
import type { AgentStatus, EpochState, FeedStatus, MandateReason } from "./names.js";

/** A vault's immutable limits (`MandateGuard.Mandate`). Bps are of 1 (1000 = 0.10 delta, 9500 = 95%). */
export interface Mandate {
  minDeltaBps: number;
  maxDeltaBps: number;
  minPremiumBps: number;
  minYieldBps: number;
  maxShareSoldBps: number;
  /** Seconds. */
  minTenor: number;
  maxTenor: number;
}

/** One option series (`EpochManager.Series`). Prices are WAD per raw token. */
export interface SeriesState {
  id: bigint;
  vault: Address;
  underlying: Address;
  agentId: bigint;
  /** Unix seconds (an NYSE session close). */
  expiry: bigint;
  /** Price as a share of fair value, bps. */
  premiumBps: number;
  isCall: boolean;
  settled: boolean;
  cancelled: boolean;
  strike: bigint;
  /** Options for sale and sold (underlying base units). */
  size: bigint;
  sold: bigint;
  /** USDG escrowed from buyers. */
  premium: bigint;
  /** Vault collateral locked for sold options. */
  collateral: bigint;
  settlementPrice: bigint;
  /** Calls: token fraction per option (WAD); puts: USD per token (WAD). */
  payoutPerOption: bigint;
  /** Payout (or premium refund) still owed to holders. */
  escrow: bigint;
}

/** The running epoch of a vault (`EpochManager.epochs`). */
export interface EpochInfo {
  state: EpochState;
  openedAt: bigint;
  /** 0 unless the epoch is Selling. */
  seriesId: bigint;
}

/** Everything a UI or agent needs about one vault, read in one call. */
export interface VaultState {
  address: Address;
  name: string;
  symbol: string;
  /** Share decimals (equal to the asset's). */
  decimals: number;
  kind: "covered-call" | "cash-secured-put";
  isCall: boolean;
  /** Collateral token: the stock token (calls) or USDG (puts). */
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  underlying: Address;
  underlyingSymbol: string;
  underlyingDecimals: number;
  premiumToken: Address;
  /** Collateral under management (asset base units). */
  totalAssets: bigint;
  totalSupply: bigint;
  /** Assets (base units) redeemable for one whole share (`10 ** decimals` shares). */
  pricePerShare: bigint;
  depositCap: bigint;
  /** True while an epoch runs: deposits and redemptions queue. */
  locked: boolean;
  currentEpoch: bigint;
  lastProcessedEpoch: bigint;
  pendingDepositAssets: bigint;
  pendingRedeemShares: bigint;
  curator: Address;
  agentId: bigint;
  mandate: Mandate;
  /** Implied volatility the EpochManager prices with (WAD, annualised). */
  sigma: bigint;
  /** Slashed agent bonds waiting to be paid to this vault's depositors at epoch close (USDG). */
  compensation: bigint;
  epoch: EpochInfo;
  /** The live series while Selling, otherwise null. */
  series: SeriesState | null;
}

/** An agent (`AgentRegistry.Agent`) plus whether it may propose right now. */
export interface AgentInfo {
  agentId: bigint;
  owner: Address;
  signer: Address;
  payout: Address;
  status: AgentStatus;
  strikes: number;
  accepted: number;
  rejected: number;
  unbondAt: bigint;
  erc8004Id: bigint;
  /** USDG bond (slashable). */
  bond: bigint;
  unbonding: bigint;
  /** Active, bonded at least `minBond` and under `maxStrikes`. */
  active: boolean;
  /** On-chain track record (`AgentRegistry.track`): epochs settled under this agent. */
  settledEpochs: number;
  /** Cumulative depositor PnL of those epochs (premium minus payouts, before fees), USDG base units. */
  cumulativePnl: bigint;
}

/** Registry-wide agent economics. */
export interface AgentRegistryParams {
  /** USDG an agent must keep bonded to propose. */
  minBond: bigint;
  /** USDG slashed per rejected proposal. */
  slashAmount: bigint;
  /** Strikes (rejections) that suspend an agent. */
  maxStrikes: number;
  /** Seconds between an unbond request and withdrawal. */
  unbondDelay: number;
  /** ERC-8004 Identity Registry agents link to (zero address when disabled). */
  identityRegistry: Address;
  /** ERC-8004 Reputation Registry that receives epoch PnL and rejections as feedback (zero when disabled). */
  reputationRegistry: Address;
}

/** An agent's track record and how much room it has left. */
export interface AgentStats extends AgentInfo {
  params: AgentRegistryParams;
  proposals: number;
  /** accepted / proposals, or null before the first proposal. */
  acceptanceRate: number | null;
  strikesLeft: number;
  /** Rejections the agent can absorb before it can no longer propose (bond or strikes). */
  rejectionsUntilInactive: number;
  /** USDG performance fees claimable by the payout address. */
  claimableFees: bigint;
}

/** `SafeStockFeed` status of a token's price. */
export interface OracleStatus {
  status: FeedStatus;
  ok: boolean;
  /** WAD per raw token (0 when unavailable). */
  price: bigint;
  updatedAt: bigint;
}

/** A proposal, in on-chain units. */
export interface ProposalParams {
  /** WAD per token. */
  strike: bigint;
  /** Unix seconds (an NYSE session close). */
  expiry: bigint;
  /** Options (underlying base units). */
  size: bigint;
  /** Price as a share of fair value (10_000 = 100%). */
  premiumBps: number;
}

/** A proposal by target delta; the contract solves the strike at execution time. */
export interface DeltaProposalParams {
  /** |delta| in bps of 1 (2000 = 0.20). */
  targetDeltaBps: number;
  expiry: bigint;
  size: bigint;
  premiumBps: number;
}

/** `EpochManager.previewProposal`: the verdict the contract would give now. */
export interface ProposalPreview {
  reason: MandateReason;
  reasonCode: number;
  /** reason === "None". */
  accepted: boolean;
  /** Black-Scholes fair value per option (WAD USD). */
  fairValue: bigint;
  /** WAD, negative for puts. */
  delta: bigint;
  /** Options the vault's collateral can back at this strike. */
  capacity: bigint;
}

/** A preview for a delta proposal: the strike the pricer solves now, and the verdict for it. */
export interface DeltaProposalPreview extends ProposalPreview {
  strike: bigint;
}

/** USDG premium and vault collateral for a purchase. */
export interface BuyQuote {
  premium: bigint;
  collateral: bigint;
}

/** Claimable balances of one account in one vault. */
export interface Claimables {
  /** USDG premium ready to claim (`claimPremium`). */
  premium: bigint;
  /** Shares from a processed deposit request (`claimDeposit`). */
  depositShares: bigint;
  /** Assets from a processed redemption (`claimRedeem`). */
  redeemAssets: bigint;
  depositRequest: { epoch: bigint; amount: bigint };
  redeemRequest: { epoch: bigint; amount: bigint };
  /** Vault shares held. */
  shares: bigint;
}

/** A mined transaction. */
export interface TxResult {
  hash: Hex;
  receipt: TransactionReceipt;
}

/** Deposit or redemption: instant when the vault is unlocked, queued while an epoch runs. */
export interface QueueableTxResult extends TxResult {
  queued: boolean;
}

/** Outcome of `proposeSeries` / `proposeByDelta`, decoded from the `SeriesProposed` / `ProposalRejected` event. */
export interface ProposeResult extends TxResult {
  accepted: boolean;
  reason: MandateReason;
  epoch: bigint;
  strike: bigint;
  expiry: bigint;
  size: bigint;
  premiumBps: number;
  /** The new series (null if rejected). */
  seriesId: bigint | null;
  /** Fair value and delta the contract measured (null if rejected). */
  fairValue: bigint | null;
  delta: bigint | null;
  /** USDG slashed from the agent's bond (0 if accepted). */
  slashed: bigint;
}

/** Outcome of `buy`. */
export interface BuyResult extends TxResult {
  seriesId: bigint;
  amount: bigint;
  /** USDG paid. */
  premium: bigint;
}

/** Outcome of `settle`, from the `EpochSettled` event. */
export interface SettleResult extends TxResult {
  seriesId: bigint;
  epoch: bigint;
  /** The feed round used (0 when nothing was sold and no price was needed). */
  roundId: bigint;
  settlementPrice: bigint;
  payout: bigint;
  premium: bigint;
  fee: bigint;
}

/** Outcome of `redeemOptions`. */
export interface RedeemOptionsResult extends TxResult {
  amount: bigint;
  /** Stock tokens (calls) or USDG (puts, cancelled series) paid. */
  paid: bigint;
}

/** Input of `registerAgent`. The sending wallet becomes the agent's owner. */
export interface RegisterAgentParams {
  /** The key that will propose for the agent's vaults. One agent per signer. */
  signer: Address;
  /** Where the agent's share of performance fees goes. */
  payout: Address;
  /** ERC-8004 identity to link (0 or omitted: none). The sending wallet must own it on the identity registry. */
  erc8004Id?: bigint;
}

/** Outcome of `registerAgent`, from the `AgentRegistered` event. */
export interface RegisterAgentResult extends TxResult {
  agentId: bigint;
  owner: Address;
  signer: Address;
  erc8004Id: bigint;
}

/** Input of `createVault` (`VaultFactory.CreateParams`). The sending wallet becomes the vault's curator. */
export interface CreateVaultParams {
  /** An allow-listed stock token (`EpochManager.underlyings(token).allowed`). */
  underlying: Address;
  /** true: covered calls (collateral: the stock token); false: cash-secured puts (collateral: USDG). */
  isCall: boolean;
  /** The agent whose signer will open epochs and propose. */
  agentId: bigint;
  /** Most collateral the vault takes, in the collateral's base units (at most `VaultFactory.maxDepositCap`). */
  depositCap: bigint;
  name: string;
  symbol: string;
  /** Fixed for the vault's lifetime; see `mandateProblems` for the protocol's floors. */
  mandate: Mandate;
}

/** Outcome of `createVault`, from the `VaultCreated` event. */
export interface CreateVaultResult extends TxResult {
  vault: Address;
  curator: Address;
  agentId: bigint;
}
