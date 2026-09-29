import { BaseError, ContractFunctionRevertedError } from "viem";

/** Errors raised by the Strike SDK itself (bad input, missing wallet, unknown deployment). */
export class StrikeError extends Error {
  override name = "StrikeError";
}

/** What a Strike custom error usually means, and what to do about it. */
export const ERROR_HINTS: Record<string, string> = {
  MarketClosed:
    "NYSE is closed: epochs open and options sell only during regular hours (09:30-16:00 New York).",
  StalePrice:
    "The stock price feed is stale (weekend, holiday or a stalled feed); retry after the next print.",
  InvalidPrice: "The price feed returned an invalid answer.",
  TokenPaused: "The stock token is paused.",
  FeedPaused: "The stock token's oracle is paused.",
  CorporateActionPending: "A split or dividend is in progress; prices are blocked until it settles.",
  NotAgent: "The sending wallet is not the vault agent's signer (or a keeper).",
  AgentNotActive:
    "The agent cannot propose: its bond is below minBond, it has too many strikes, or it is suspended.",
  WrongState: "The vault's epoch is in a different state (Idle → Open → Selling → Idle).",
  NotExpired: "The series has not expired yet.",
  SaleClosed: "Sales have closed for this series (they stop shortly before expiry).",
  ExceedsSize: "Not enough options left in this series.",
  ExceedsCapacity: "The vault does not hold enough collateral for that many options.",
  PremiumTooHigh: "The premium moved past your slippage limit; quote again.",
  InvalidSettlementRound: "That feed round is not the first one at or after expiry.",
  VaultLocked: "The vault is locked while an epoch runs; use the queued request functions.",
  VaultNotLocked: "The vault is unlocked; deposit or redeem directly instead of queueing.",
  DepositCapExceeded: "The deposit would exceed the vault's cap.",
  ERC4626ExceededMaxDeposit: "The vault cannot take that deposit now (locked or over its cap).",
  ERC4626ExceededMaxRedeem: "The vault cannot redeem that many shares now (locked or not enough shares).",
  NoProcessedRequest: "There is no processed request to claim yet.",
  SeriesNotFinal: "The series is not settled or cancelled yet.",
  UnsupportedByOracle: "The token has no price feed registered.",
  PricerInputOutOfRange:
    "The pricer rejected an input (spot, strike, tenor, volatility or delta out of range).",
  EnforcedPause: "The protocol is paused by the guardian.",
  SignerTaken: "That signer key already belongs to an agent (one agent per signer); use a fresh key.",
  NotIdentityOwner: "The sending wallet does not own that ERC-8004 identity on the identity registry.",
  UnknownAgent: "No agent is registered under that id.",
  NotOwner: "Only the agent's owner (the wallet that registered it) can do that.",
  InvalidMandate:
    "The mandate breaks a protocol rule: delta band inside 0-1, premium 90%-300% of fair value, size share 0.01%-100%, tenor 1 second to 35 days.",
  UnderlyingNotAllowed: "That stock token is not allow-listed for vaults on this deployment.",
  DepositCapTooHigh: "The deposit cap is above the factory's maxDepositCap.",
};

function formatArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return `[${value.map(formatArg).join(", ")}]`;
  return String(value);
}

/** The reverted contract error inside a viem error, if any. */
function revertOf(err: unknown): ContractFunctionRevertedError | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const found = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return found instanceof ContractFunctionRevertedError ? found : undefined;
}

/** The custom error name of a contract revert (for example "MarketClosed"), if the error is one. */
export function revertErrorName(err: unknown): string | undefined {
  return revertOf(err)?.data?.errorName;
}

/**
 * A short description of any error: `ErrorName(arg, ...)` for a decoded contract revert, viem's short message for
 * other RPC errors, otherwise the message.
 */
export function describeError(err: unknown): string {
  const revert = revertOf(err);
  if (revert) {
    if (revert.data) {
      const args = (revert.data.args ?? []).map(formatArg).join(", ");
      return `${revert.data.errorName}(${args})`;
    }
    return revert.reason ?? revert.shortMessage;
  }
  if (err instanceof BaseError) return err.shortMessage;
  return err instanceof Error ? err.message : String(err);
}

/** {@link describeError} plus a plain-words hint when the revert is a known Strike error. */
export function explainError(err: unknown): string {
  const text = describeError(err);
  const name = revertErrorName(err);
  const hint = name ? ERROR_HINTS[name] : undefined;
  return hint ? `${text}: ${hint}` : text;
}
