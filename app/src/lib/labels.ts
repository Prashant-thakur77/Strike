/** MandateGuard.Reason, in enum order. */
export const REASONS = [
  { name: "None", text: "Inside the mandate" },
  { name: "ZeroSize", text: "Asked to sell zero options" },
  { name: "TenorOutOfRange", text: "Expiry too near or too far" },
  { name: "InvalidExpiry", text: "Expiry is not an NYSE close" },
  { name: "StrikeWrongSide", text: "Strike on the wrong side of spot" },
  { name: "SizeTooLarge", text: "Sells more of the vault than allowed" },
  { name: "PremiumBelowFair", text: "Priced below the fair-value floor" },
  { name: "PremiumAboveCap", text: "Priced above 3× fair value" },
  { name: "DeltaOutOfBand", text: "Delta outside the mandate band" },
  { name: "PremiumTooSmall", text: "Premium too small for the collateral" },
] as const;

export function reasonOf(code: number) {
  return REASONS[code] ?? { name: `Reason ${code}`, text: "Unknown reason" };
}

/** EpochManager.EpochState */
export const EPOCH_STATES = [
  { name: "Idle", text: "Unlocked · between epochs" },
  { name: "Open", text: "Locked · waiting for the agent" },
  { name: "Selling", text: "Locked · options on sale" },
] as const;

/** AgentRegistry.Status */
export const AGENT_STATUS = ["None", "Active", "Suspended", "Retired"] as const;

/** SafeStockFeed.Status */
export const FEED_STATUS = [
  "Ok",
  "Invalid price",
  "Stale price",
  "Token paused",
  "Feed paused",
  "Corporate action pending",
] as const;
