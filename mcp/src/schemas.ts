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

export const hedgeSchema = z.object({
  vault: address,
  vaultSymbol: z.string(),
  seriesId: z.string(),
  optionType: z.enum(["put", "call"]),
  strike: decimal.describe("USD per token"),
  expiry: z.number(),
  expiryIso: z.string(),
  options: decimal.describe("Options to buy; one option covers one token"),
  coverage: z.number().describe("Share of the position the options cover (1 = all of it)"),
  premium: decimal.describe("USDG for all the options, quoted now"),
  premiumPerOption: decimal.describe("USDG"),
  costBps: z.number().describe("Premium over the covered tokens' value at spot, bps"),
  protectedPrice: decimal.describe("Puts: the floor per covered token at expiry. Calls: the cap. USD"),
  effectivePrice: decimal.describe("protectedPrice net of the premium per option, USD"),
  maxLoss: decimal.describe("Worst case on the covered tokens versus spot, premium included, USD"),
  saleClosesAt: z.number(),
  saleClosesAtIso: z.string(),
});

export const hedgePlanShape = {
  underlying: z.string(),
  side: z.enum(["long", "short"]).describe("long: you hold the tokens (puts hedge). short: calls hedge"),
  position: decimal.describe("Tokens to hedge"),
  spot: decimal.nullable(),
  positionValue: decimal.nullable().describe("USD at spot"),
  hedgeable: z.boolean(),
  canBuyNow: z.boolean(),
  explanation: z.string(),
  hedge: hedgeSchema.nullable(),
  considered: z.array(
    z.object({
      vault: address,
      vaultSymbol: z.string(),
      kind: z.enum(["covered-call", "cash-secured-put"]),
      usable: z.boolean(),
      note: z.string(),
    }),
  ),
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

/** One pre-flight check of an onboarding tool. A failed blocking check stops the transaction. */
export const checkSchema = z.object({
  check: z.string(),
  ok: z.boolean(),
  blocking: z.boolean().describe("true: sending is refused while this check fails; false: a warning"),
  detail: z.string(),
});

export const registerAgentShape = {
  dryRun: z.boolean(),
  registryVersion: z
    .enum(["v2", "v3"])
    .describe("v3 registries take an EIP-712 consent from a signer that is not the sender"),
  submitted: z.boolean().describe("Whether any transaction was sent"),
  alreadyRegistered: z.boolean(),
  agentId: z.string().nullable(),
  signer: address,
  owner: address,
  payout: address,
  erc8004Id: z.string(),
  bondPosted: decimal.describe("USDG added to the bond by this call"),
  bond: decimal.describe("USDG bond after this call"),
  minBond: decimal.describe("USDG an agent must keep bonded to propose"),
  slashAmount: decimal.describe("USDG slashed per rejected proposal"),
  maxStrikes: z.number(),
  active: z.boolean().describe("Whether the agent may propose now"),
  usdgBalance: decimal.describe("The wallet's USDG before this call"),
  checks: z.array(checkSchema),
  registerTxHash: z.string().nullable(),
  bondTxHash: z.string().nullable(),
  explanation: z.string(),
  nextStep: z.string(),
};

export const setSignerShape = {
  dryRun: z.boolean(),
  submitted: z.boolean().describe("Whether the setSigner transaction was sent"),
  registryVersion: z.enum(["v2", "v3"]),
  agentId: z.string(),
  owner: address.nullable(),
  previousSigner: address.nullable(),
  signer: address.describe("The new signer key"),
  consentRequired: z
    .boolean()
    .describe("v3 and the new signer is not this wallet: the new signer must sign the SetSigner consent"),
  consentTypedData: z
    .string()
    .nullable()
    .describe(
      "When a consent is required but missing or invalid: the EIP-712 typed data (JSON, integers as strings) for the new signer key to sign",
    ),
  checks: z.array(checkSchema),
  txHash: z.string().nullable(),
  explanation: z.string(),
  nextStep: z.string(),
};

export const createVaultShape = {
  dryRun: z.boolean(),
  submitted: z.boolean(),
  vault: address.nullable(),
  curator: address,
  agentId: z.string(),
  underlying: z.object({ address, symbol: z.string() }),
  kind: z.enum(["covered-call", "cash-secured-put"]),
  collateral: z.string().describe("What depositors put in: the stock token (calls) or USDG (puts)"),
  name: z.string(),
  symbol: z.string(),
  depositCap: decimal.describe("In collateral units"),
  maxDepositCap: decimal.describe("The factory's ceiling, in collateral units"),
  mandate: mandateSchema,
  floors: z.object({
    minPremiumBps: z.number().describe("Lowest minPremiumBps any mandate may set"),
    maxPremiumBps: z.number(),
    maxTenorDays: z.number().describe("Longest maxTenor any mandate may allow"),
  }),
  checks: z.array(checkSchema),
  txHash: z.string().nullable(),
  explanation: z.string(),
  nextStep: z.string(),
};

const greeksSchema = z.object({
  delta: z.number(),
  gamma: z.number().describe("Per $1 of spot"),
  vega: z.number().describe("USD per 1.00 (100 points) of volatility"),
  theta: z.number().describe("USD per calendar day"),
});

export const seriesRiskShape = {
  seriesId: z.string(),
  vault: address,
  vaultSymbol: z.string(),
  underlying: z.string().describe("Stock token symbol"),
  isCall: z.boolean(),
  strike: decimal,
  expiry: z.number(),
  expiryIso: z.string(),
  computedBy: z.object({
    riskEngine: address,
    contract: z.string(),
    explorer: z.string().nullable(),
    functions: z.array(z.string()),
  }),
  chainTime: z.number(),
  tenorDays: z.number().describe("0 once expired; the greeks are then 0"),
  spot: decimal,
  spotStatus: z.string().describe("Ok, or why the spot is only the feed's last print"),
  sigma: z.number().describe("Volatility the greeks use (0.6 = 60%)"),
  sigmaSource: z.enum(["epoch-open", "current"]),
  currentSigma: z.number(),
  sold: decimal,
  collateral: decimal,
  collateralUnit: z.string(),
  premiumCollected: decimal.describe("USDG"),
  perOption: greeksSchema.describe("Per option, option holder's side"),
  vaultExposure: greeksSchema.describe("Depositors' side: minus the greeks times the options sold"),
  explanations: z.object({ delta: z.string(), gamma: z.string(), vega: z.string(), theta: z.string() }),
  atCurrentSigma: z.object({ perOption: greeksSchema, vaultExposure: greeksSchema }).nullable(),
  scenarios: z.array(
    z.object({
      shockPct: z.number(),
      spot: decimal,
      payout: decimal.describe("USD the vault pays holders at expiry"),
      net: decimal.describe("Premium collected minus the payout, USD (the option leg only)"),
    }),
  ),
  worst: z.object({
    shockPct: z.number(),
    payout: decimal.describe("USD"),
    payoutInCollateral: decimal,
    shareOfCollateral: z.number().describe("0.187 = 18.7% of the locked collateral"),
  }),
  impliedVol: z
    .object({
      sigma: z.number(),
      fairValue: decimal,
      pricePaid: decimal,
      spot: decimal,
      pricedSpot: decimal,
      tenorDays: z.number(),
      txHash: z.string(),
    })
    .nullable(),
  impliedVolNote: z.string(),
  summary: z.string(),
};
