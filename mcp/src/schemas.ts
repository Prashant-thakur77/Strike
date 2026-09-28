import { z } from "zod";

// Output schemas for the Strike MCP tools. Amounts are decimal strings in human units (tokens, USD, USDG);
// ids that can exceed 2^53 are strings; timestamps are unix seconds.

const address = z.string().describe("0x address");
const decimal = z.string().describe("Decimal number in human units");

export const mandateSchema = z.object({
  minDeltaBps: z.number(),
  maxDeltaBps: z.number(),
  minPremiumBps: z.number(),
  minYieldBps: z.number(),
  maxShareSoldBps: z.number(),
  minTenor: z.number(),
  maxTenor: z.number(),
  summary: z.string(),
});

export const seriesSchema = z.object({
  id: z.string(),
  strike: decimal,
  expiry: z.number(),
  expiryIso: z.string(),
  premiumBps: z.number(),
  size: decimal,
  sold: decimal,
  remaining: decimal,
  premiumCollected: decimal,
  settled: z.boolean(),
  cancelled: z.boolean(),
  settlementPrice: decimal.nullable(),
});

const tokenSchema = z.object({ address, symbol: z.string(), decimals: z.number() });

export const vaultSchema = z.object({
  address,
  name: z.string(),
  symbol: z.string(),
  kind: z.enum(["covered-call", "cash-secured-put"]),
  underlying: tokenSchema,
  asset: tokenSchema,
  totalAssets: decimal,
  depositCap: decimal,
  pricePerShare: decimal,
  locked: z.boolean(),
  currentEpoch: z.number(),
  epochState: z.enum(["Idle", "Open", "Selling"]),
  agentId: z.string(),
  curator: address,
  sigma: z.number().describe("Implied volatility used for fair value (0.6 = 60%)"),
  compensation: decimal.describe("Slashed agent bonds owed to depositors at epoch close (USDG)"),
  mandate: mandateSchema,
  series: seriesSchema.nullable(),
});

const reasonSchema = z.string().describe("MandateGuard.Reason name: None means inside the mandate");

export const suggestionSchema = z.object({
  targetDeltaBps: z.number(),
  strike: decimal,
  delta: z.number(),
  size: decimal,
  premiumBps: z.number(),
  expiry: z.number(),
  fairValue: decimal,
  ok: z.boolean(),
  reason: reasonSchema,
  source: z.enum(["on-chain pricer", "float model"]),
});

export const riskCheckShape = {
  vault: address,
  vaultSymbol: z.string(),
  isCall: z.boolean(),
  proposal: z.object({
    mode: z.enum(["strike", "delta"]),
    strike: decimal.describe("USD per token (for delta proposals: the strike the pricer solves now)"),
    targetDeltaBps: z.number().nullable(),
    expiry: z.number(),
    expiryIso: z.string(),
    tenorDays: z.number(),
    size: decimal,
    premiumBps: z.number(),
  }),
  ok: z.boolean(),
  reason: reasonSchema,
  explanation: z.string(),
  measured: z.object({
    fairValue: decimal.describe("Black-Scholes fair value per option, USD"),
    delta: z.number().describe("|delta| at proposal time"),
    capacity: decimal.describe("Options the vault's collateral can back"),
    yieldBps: z.number().describe("Premium per option over the collateral it locks, bps"),
  }),
  spot: decimal,
  mandate: mandateSchema,
  suggestion: suggestionSchema.nullable(),
};

export const agentSchema = z.object({
  agentId: z.string(),
  status: z.enum(["None", "Active", "Suspended", "Retired"]),
  active: z.boolean(),
  owner: address,
  signer: address,
  payout: address,
  erc8004Id: z.string(),
  bond: decimal.describe("USDG"),
  unbonding: decimal.describe("USDG"),
  strikes: z.number(),
  maxStrikes: z.number(),
  strikesLeft: z.number(),
  accepted: z.number(),
  rejected: z.number(),
  proposals: z.number(),
  acceptanceRate: z.number().nullable(),
  rejectionsUntilInactive: z.number(),
  settledEpochs: z.number(),
  cumulativePnl: decimal.describe("Depositor PnL of settled epochs, USDG (signed)"),
  claimableFees: decimal.describe("USDG"),
  minBond: decimal.describe("USDG"),
  slashAmount: decimal.describe("USDG"),
  reputationRegistry: address,
});
