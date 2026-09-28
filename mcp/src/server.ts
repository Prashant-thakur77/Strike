import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BPS,
  ERROR_HINTS,
  FEED_STATUS_DESCRIPTIONS,
  type ProposalPreview,
  STRIKE_SDK_VERSION,
  type SeriesState,
  type StrikeClient,
  StrikeError,
  type VaultState,
  clampDeltaToMandate,
  explainError,
  explainMandateReason,
  floorToCent,
  formatAmount,
  maxProposalSize,
  numberToWad,
  parseAmount,
  parseWad,
  strikeChains,
  strikeForDelta,
  vaultCapacity,
  wadToNumber,
} from "@strike/sdk";
import { type Address, getAddress, isAddress } from "viem";
import { z } from "zod";
import { absDelta, failure, iso, mandateView, result, usd, usdg, vaultView } from "./format.js";
import {
  agentSchema,
  hedgePlanShape,
  hedgeSchema,
  riskCheckShape,
  suggestionSchema,
  vaultSchema,
} from "./schemas.js";

export const SERVER_VERSION = "0.1.0";
export const SKILL_URI = "strike://skill";

/** Options for {@link createStrikeMcpServer}. */
export interface StrikeMcpOptions {
  chainId: number;
  /**
   * Returns the Strike client. Called per tool call, so the server still starts (and `strike_info` still works)
   * when the client cannot be built, for example on a chain without a deployment.
   */
  client: () => StrikeClient;
  /** Where STRIKE_SKILL.md lives (default: docs/STRIKE_SKILL.md in the repository). */
  skillPath?: string | URL;
}

const DEFAULT_SKILL_PATH = new URL("../../docs/STRIKE_SKILL.md", import.meta.url);
const DEFAULT_TARGET_DELTA = 0.2;

const vaultInput = z
  .string()
  .min(1)
  .describe("Vault address (0x...) or share symbol such as sTSLA-CC (see list_vaults)");
const decimalInput = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?$/)]);
const proposalInput = {
  vault: vaultInput,
  strike: decimalInput
    .optional()
    .describe("Explicit strike in USD per token (e.g. 390.5). Give this or targetDeltaBps, not both."),
  targetDeltaBps: z
    .number()
    .int()
    .min(1)
    .max(9999)
    .optional()
    .describe(
      "Target |delta| in bps of 1 (2000 = 0.20); the contract solves the strike on-chain. Preferred.",
    ),
  expiry: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Unix seconds of an NYSE close; default: the next weekly expiry inside the mandate's tenor"),
  size: decimalInput
    .optional()
    .describe(
      "Options to offer, in underlying tokens (e.g. 8); default: the mandate's maximum share of capacity",
    ),
  premiumBps: z
    .number()
    .int()
    .min(1)
    .max(30_000)
    .optional()
    .describe(
      "Price as a share of Black-Scholes fair value (10000 = 100%); default max(mandate minimum, 10000)",
    ),
};
type ProposalInput = {
  vault: string;
  strike?: number | string;
  targetDeltaBps?: number;
  expiry?: number;
  size?: number | string;
  premiumBps?: number;
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

async function run(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return failure(explainError(err));
  }
}

const round = (x: number, digits = 4) => Number(x.toFixed(digits));

/** A vault address from an address or a share symbol / name. */
async function resolveVault(strike: StrikeClient, ref: string): Promise<Address> {
  if (isAddress(ref)) return getAddress(ref);
  const vaults = await strike.listVaults();
  const wanted = ref.trim().toLowerCase();
  const match = vaults.find((v) => v.symbol.toLowerCase() === wanted || v.name.toLowerCase() === wanted);
  if (!match) {
    throw new StrikeError(
      `unknown vault "${ref}"; known vaults: ${vaults.map((v) => v.symbol).join(", ") || "none"}`,
    );
  }
  return match.address;
}

function requireWallet(strike: StrikeClient): Address {
  const address = strike.viem.walletClient?.account?.address;
  if (!address) {
    throw new StrikeError(
      "the Strike MCP server is in read-only mode: set STRIKE_AGENT_PRIVATE_KEY to the agent signer's key to send transactions",
    );
  }
  return address;
}

const DEFAULT_SLIPPAGE_BPS = 100;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const addressInput = z
  .string()
  .refine((s) => isAddress(s), "must be a 0x address")
  .describe("0x address");

/** USDG base units as a WAD USD amount. */
const usdgToWad = (amount: bigint, usdgDecimals: number) => amount * 10n ** BigInt(18 - usdgDecimals);
/** USDG premium per option for `amount` options (underlying base units). */
const perOption = (premium: bigint, amount: bigint, underlyingDecimals: number) =>
  (premium * 10n ** BigInt(underlyingDecimals)) / amount;
/** A WAD USD value of `amount` tokens (base units) at `price` (WAD per token). */
const valueOf = (amount: bigint, price: bigint, decimals: number) =>
  (amount * price) / 10n ** BigInt(decimals);
const optionWord = (isCall: boolean) => (isCall ? "call" : "put");

/**
 * Why a vault's live series cannot be bought now, from the facts `EpochManager.buy` checks (null when it can).
 * The market-hours check is separate: it is the same for every series.
 */
function saleBlocker(v: VaultState, now: bigint, saleCutoff: number): string | null {
  const s = v.series;
  if (v.epoch.state !== "Selling" || !s)
    return `${v.symbol} has no series on sale (epoch is ${v.epoch.state})`;
  if (now >= s.expiry) return `series ${s.id} expired at ${iso(s.expiry)} and waits for settle_epoch`;
  const closes = s.expiry - BigInt(saleCutoff);
  if (now >= closes) {
    return `sales of series ${s.id} closed at ${iso(closes)}, ${saleCutoff / 60} minutes before expiry`;
  }
  if (s.sold >= s.size) return `series ${s.id} is sold out`;
  return null;
}

/**
 * The series of a vault to redeem for `holder`: the newest settled or cancelled one they hold options of, else the
 * newest one they hold that is not final yet (the caller reports it).
 */
async function redeemableSeries(strike: StrikeClient, v: VaultState, holder: Address): Promise<SeriesState> {
  let ids: bigint[];
  try {
    ids = await strike.vaultSeriesIds(v.address);
  } catch (err) {
    throw new StrikeError(
      `could not read ${v.symbol}'s series from the chain's logs (${explainError(err)}); pass the seriesId from buy_options`,
    );
  }
  let pending: SeriesState | null = null;
  for (const id of ids) {
    const [s, balance] = await Promise.all([strike.getSeries(id), strike.optionBalance(id, holder)]);
    if (!s || balance === 0n) continue;
    if (s.settled || s.cancelled) return s;
    pending ??= s;
  }
  if (pending) return pending;
  throw new StrikeError(`${holder} holds no options of ${v.symbol}`);
}

/** "10 TSLA", "10" or 10 → amount and optional symbol. */
function parsePosition(position: string | number): { amount: string; symbol: string | null } {
  if (typeof position === "number") return { amount: String(position), symbol: null };
  const m = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9.-]*)?\s*$/.exec(position);
  if (!m) throw new StrikeError(`position must look like "10 TSLA" or "10", got "${position}"`);
  return { amount: m[1] as string, symbol: m[2] ?? null };
}

interface Evaluation {
  vault: VaultState;
  mode: "strike" | "delta";
  strike: bigint;
  targetDeltaBps: number | null;
  expiry: bigint;
  size: bigint;
  premiumBps: number;
  preview: ProposalPreview;
  report: Record<string, unknown> & { ok: boolean; reason: string; explanation: string; suggestion: unknown };
}

/** The shared core of risk_check and propose_epoch: measure a proposal with previewProposal and explain it. */
async function evaluate(strike: StrikeClient, input: ProposalInput): Promise<Evaluation> {
  if (input.strike !== undefined && input.targetDeltaBps !== undefined) {
    throw new StrikeError("give either strike or targetDeltaBps, not both");
  }
  const vault = await strike.getVault(await resolveVault(strike, input.vault));
  const { mandate, isCall, underlyingDecimals: dec } = vault;
  const oracle = await strike.oracleStatus(vault.underlying);
  if (!oracle.ok) {
    throw new StrikeError(
      `the ${vault.underlyingSymbol} price feed is not usable (${oracle.status}): ${FEED_STATUS_DESCRIPTIONS[oracle.status]}`,
    );
  }
  const [now, usdgDecimals] = await Promise.all([strike.blockTimestamp(), strike.usdgDecimals()]);
  const expiry = input.expiry !== undefined ? BigInt(input.expiry) : await strike.nextExpiry(mandate);
  if (expiry === null) {
    throw new StrikeError("no weekly expiry fits the mandate's tenor right now; pass an explicit expiry");
  }

  const mode = input.strike !== undefined ? "strike" : "delta";
  const targetDeltaBps =
    mode === "delta" ? (input.targetDeltaBps ?? Math.round(DEFAULT_TARGET_DELTA * BPS)) : null;
  const strikeWad =
    input.strike !== undefined
      ? parseWad(input.strike)
      : await strike.solveStrike(vault.address, { targetDeltaBps: targetDeltaBps as number, expiry });
  const capacityAt = (k: bigint) =>
    vaultCapacity({
      isCall,
      totalAssets: vault.totalAssets,
      strike: k,
      underlyingDecimals: dec,
      usdgDecimals,
    });
  const size =
    input.size !== undefined ? parseAmount(input.size, dec) : maxProposalSize(capacityAt(strikeWad), mandate);
  const premiumBps = input.premiumBps ?? Math.max(mandate.minPremiumBps, BPS);
  const preview = await strike.previewProposal(vault.address, {
    strike: strikeWad,
    expiry,
    size,
    premiumBps,
  });

  const spot = wadToNumber(oracle.price);
  const strikeUsd = wadToNumber(strikeWad);
  const fair = wadToNumber(preview.fairValue);
  const collateralValue = isCall ? spot : strikeUsd;
  const yieldFraction = collateralValue > 0 ? (fair * premiumBps) / BPS / collateralValue : 0;
  let explanation = explainMandateReason(preview.reason, {
    mandate,
    isCall,
    spot,
    strike: strikeUsd,
    delta: absDelta(preview.delta),
    tenorSeconds: Number(expiry - now),
    size: Number(formatAmount(size, dec)),
    capacity: Number(formatAmount(preview.capacity, dec)),
    premiumBps,
    yieldFraction,
  });
  if (preview.capacity === 0n)
    explanation += " The vault holds no collateral yet, so it cannot sell options.";
  if (!preview.accepted) {
    explanation += " Proposing it anyway would be rejected on-chain and slash the agent's bond.";
  }

  // A compliant alternative: the target delta (clamped into the band), solved by the on-chain pricer.
  const target = clampDeltaToMandate(
    targetDeltaBps !== null ? targetDeltaBps / BPS : DEFAULT_TARGET_DELTA,
    mandate,
  );
  const suggestedBps = Math.round(target * BPS);
  let suggestedStrike: bigint;
  let source: "on-chain pricer" | "float model" = "on-chain pricer";
  try {
    suggestedStrike = await strike.solveStrike(vault.address, { targetDeltaBps: suggestedBps, expiry });
  } catch {
    source = "float model";
    const tenor = Number(expiry - now);
    suggestedStrike = floorToCent(
      numberToWad(strikeForDelta(spot, target, tenor, wadToNumber(vault.sigma), isCall)),
    );
  }
  const suggestedSize = maxProposalSize(capacityAt(suggestedStrike), mandate);
  const suggestedPremium = Math.max(mandate.minPremiumBps, BPS);
  const check = await strike.previewProposal(vault.address, {
    strike: suggestedStrike,
    expiry,
    size: suggestedSize,
    premiumBps: suggestedPremium,
  });
  const suggestion = {
    targetDeltaBps: suggestedBps,
    strike: usd(suggestedStrike),
    delta: round(absDelta(check.delta)),
    size: formatAmount(suggestedSize, dec),
    premiumBps: suggestedPremium,
    expiry: Number(expiry),
    fairValue: usd(check.fairValue),
    ok: check.accepted,
    reason: check.reason,
    source,
  };

  const report = {
    vault: vault.address,
    vaultSymbol: vault.symbol,
    isCall,
    proposal: {
      mode,
      strike: usd(strikeWad),
      targetDeltaBps,
      expiry: Number(expiry),
      expiryIso: iso(expiry),
      tenorDays: round(Number(expiry - now) / 86_400, 3),
      size: formatAmount(size, dec),
      premiumBps,
    },
    ok: preview.accepted,
    reason: preview.reason,
    explanation,
    measured: {
      fairValue: usd(preview.fairValue),
      delta: round(absDelta(preview.delta)),
      capacity: formatAmount(preview.capacity, dec),
      yieldBps: round(yieldFraction * BPS, 2),
    },
    spot: usd(oracle.price),
    mandate: mandateView(mandate),
    suggestion,
  };
  return { vault, mode, strike: strikeWad, targetDeltaBps, expiry, size, premiumBps, preview, report };
}

/** What an agent should do next with a vault, in one sentence. */
function nextStep(v: VaultState, now: bigint, marketOpen: boolean, feedOk: boolean): string {
  switch (v.epoch.state) {
    case "Idle":
      if (!feedOk)
        return "Idle, but the price feed is not usable: wait for a fresh print before opening an epoch.";
      if (!marketOpen)
        return "Idle; the NYSE is closed. Epochs open during regular hours (09:30-16:00 New York).";
      return "Idle and ready: run risk_check, then propose_epoch (it opens the epoch first).";
    case "Open":
      return "Epoch open and waiting for a proposal: run risk_check, then propose_epoch.";
    case "Selling": {
      const expiry = v.series?.expiry ?? 0n;
      if (now >= expiry) return "The series has expired: call settle_epoch.";
      return `Selling until ${iso(expiry)}; buyers can use quote, hedge_plan and buy_options. Settle with settle_epoch after expiry.`;
    }
  }
}

/**
 * Build the Strike MCP server: tools to list and inspect vaults, quote, plan hedges with, buy and redeem options,
 * dry-run and send an agent's proposal, settle epochs and read agent track records, plus the STRIKE_SKILL.md
 * resource.
 */
export function createStrikeMcpServer(options: StrikeMcpOptions): McpServer {
  const { chainId, client } = options;
  const skillPath = options.skillPath ?? DEFAULT_SKILL_PATH;
  const server = new McpServer({ name: "strike", version: SERVER_VERSION });

  server.registerResource(
    "strike-skill",
    SKILL_URI,
    {
      title: "Strike skill for AI agents",
      description: "How Strike works, the mandate rules, slashing, the tools and a safe proposal loop.",
      mimeType: "text/markdown",
    },
    async (uri) => {
      let text: string;
      try {
        text = await readFile(skillPath, "utf8");
      } catch {
        text =
          "# Strike\n\nSTRIKE_SKILL.md was not found next to this server. See docs/STRIKE_SKILL.md in the repo.";
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    },
  );

  server.registerTool(
    "strike_info",
    {
      title: "Strike protocol info",
      description:
        "Describe Strike, the chain this server is connected to, whether it can send transactions, and the chains Strike supports.",
      inputSchema: {},
      outputSchema: {
        protocol: z.string(),
        description: z.string(),
        sdkVersion: z.string(),
        serverVersion: z.string(),
        chainId: z.number(),
        mode: z.enum(["read-only", "agent"]),
        agentAddress: z.string().nullable(),
        deployed: z.boolean(),
        skillResource: z.string(),
        chains: z.array(z.object({ id: z.number(), name: z.string() })),
      },
      annotations: READ_ONLY,
    },
    async () => {
      let agentAddress: string | null = null;
      let deployed = true;
      try {
        agentAddress = client().viem.walletClient?.account?.address ?? null;
      } catch {
        deployed = false;
      }
      return result({
        protocol: "Strike",
        description:
          "Options vaults for Robinhood Chain stock tokens, paid in USDG. Agents propose weekly strikes; the contract enforces each vault's mandate and slashes the agent's bond for proposals outside it. Agents also buy the options, to hedge a stock position or for directional exposure (hedge_plan, buy_options, redeem_options).",
        sdkVersion: STRIKE_SDK_VERSION,
        serverVersion: SERVER_VERSION,
        chainId,
        mode: agentAddress ? "agent" : "read-only",
        agentAddress,
        deployed,
        skillResource: SKILL_URI,
        chains: Object.values(strikeChains).map((c) => ({ id: c.id, name: c.name })),
      });
    },
  );

  server.registerTool(
    "list_vaults",
    {
      title: "List vaults",
      description:
        "Every Strike vault: underlying stock, covered call or cash-secured put, collateral, epoch state, agent, mandate and live series.",
      inputSchema: {},
      outputSchema: { chainId: z.number(), vaults: z.array(vaultSchema) },
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const vaults = await client().listVaults();
        return result({ chainId, vaults: vaults.map(vaultView) });
      }),
  );

  server.registerTool(
    "vault_state",
    {
      title: "Vault state",
      description:
        "One vault in detail: mandate, epoch, live series, spot price and oracle status, market hours, the next valid expiry, the vault's agent, and what to do next.",
      inputSchema: { vault: vaultInput },
      outputSchema: {
        vault: vaultSchema,
        spot: z.object({
          price: z.string().nullable(),
          status: z.string(),
          ok: z.boolean(),
          updatedAt: z.number(),
          updatedAtIso: z.string(),
          description: z.string(),
        }),
        marketOpen: z.boolean(),
        blockTimestamp: z.number(),
        blockTimeIso: z.string(),
        nextExpiry: z.number().nullable(),
        nextExpiryIso: z.string().nullable(),
        agent: z.object({
          agentId: z.string(),
          status: z.string(),
          active: z.boolean(),
          signer: z.string(),
          bond: z.string(),
          strikes: z.number(),
        }),
        nextStep: z.string(),
      },
      annotations: READ_ONLY,
    },
    async ({ vault }) =>
      run(async () => {
        const strike = client();
        const v = await strike.getVault(await resolveVault(strike, vault));
        const [oracle, marketOpen, now, expiry, agent] = await Promise.all([
          strike.oracleStatus(v.underlying),
          strike.marketOpen(),
          strike.blockTimestamp(),
          strike.nextExpiry(v.mandate),
          strike.getAgent(v.agentId),
        ]);
        return result({
          vault: vaultView(v),
          spot: {
            price: oracle.price === 0n ? null : usd(oracle.price),
            status: oracle.status,
            ok: oracle.ok,
            updatedAt: Number(oracle.updatedAt),
            updatedAtIso: iso(oracle.updatedAt),
            description: FEED_STATUS_DESCRIPTIONS[oracle.status],
          },
          marketOpen,
          blockTimestamp: Number(now),
          blockTimeIso: iso(now),
          nextExpiry: expiry === null ? null : Number(expiry),
          nextExpiryIso: expiry === null ? null : iso(expiry),
          agent: {
            agentId: agent.agentId.toString(),
            status: agent.status,
            active: agent.active,
            signer: agent.signer,
            bond: usdg(agent.bond),
            strikes: agent.strikes,
          },
          nextStep: nextStep(v, now, marketOpen, oracle.ok),
        });
      }),
  );

  server.registerTool(
    "quote",
    {
      title: "Quote options",
      description:
        "USDG premium to buy options of a vault's live series (or a series id) right now: fair value at the current spot × the series' premium factor.",
      inputSchema: {
        vault: vaultInput.optional(),
        seriesId: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Series id (decimal); default: the vault's live series"),
        amount: decimalInput.describe("Options to buy, in underlying tokens (e.g. 2)"),
      },
      outputSchema: {
        seriesId: z.string(),
        vault: z.string(),
        underlying: z.string(),
        strike: z.string(),
        expiry: z.number(),
        expiryIso: z.string(),
        premiumBps: z.number(),
        amount: z.string(),
        remaining: z.string(),
        premium: z.string().describe("USDG"),
        premiumPerOption: z.string().describe("USDG"),
        collateral: z.string().describe("Vault collateral locked (vault asset units)"),
      },
      annotations: READ_ONLY,
    },
    async ({ vault, seriesId, amount }) =>
      run(async () => {
        const strike = client();
        let id: bigint;
        if (seriesId !== undefined) id = BigInt(seriesId);
        else if (vault !== undefined) {
          const v = await strike.getVault(await resolveVault(strike, vault));
          if (!v.series)
            throw new StrikeError(`vault ${v.symbol} has no live series (epoch is ${v.epoch.state})`);
          id = v.series.id;
        } else throw new StrikeError("give a vault or a seriesId");
        const series = await strike.getSeries(id);
        if (!series) throw new StrikeError(`series ${id} does not exist`);
        const v = await strike.getVault(series.vault);
        const raw = parseAmount(amount, v.underlyingDecimals);
        if (raw === 0n) throw new StrikeError("amount must be positive");
        const q = await strike.quoteBuy(id, raw);
        const perOption = (q.premium * 10n ** BigInt(v.underlyingDecimals)) / raw;
        return result({
          seriesId: id.toString(),
          vault: v.address,
          underlying: v.underlyingSymbol,
          strike: usd(series.strike),
          expiry: Number(series.expiry),
          expiryIso: iso(series.expiry),
          premiumBps: series.premiumBps,
          amount: formatAmount(raw, v.underlyingDecimals),
          remaining: formatAmount(series.size - series.sold, v.underlyingDecimals),
          premium: usdg(q.premium),
          premiumPerOption: usdg(perOption),
          collateral: formatAmount(q.collateral, v.assetDecimals),
        });
      }),
  );

  server.registerTool(
    "hedge_plan",
    {
      title: "Plan a hedge",
      description:
        "Plan a hedge for a stock-token position without sending anything: how many puts (for tokens you hold) or calls (for a short position) of a live series cover it, the USDG premium now, the protected price and the worst case. Plain arithmetic from quoteBuy and the series. Says so when no suitable series is on sale. Buy the plan with buy_options.",
      inputSchema: {
        vault: vaultInput
          .optional()
          .describe(
            "Vault whose live series to use (a put vault hedges tokens you hold); or give underlying",
          ),
        underlying: z
          .string()
          .min(1)
          .optional()
          .describe("Stock token symbol such as TSLA: consider every vault on it"),
        position: z
          .union([z.number().positive(), z.string().min(1)])
          .describe('Tokens to hedge, e.g. "10 TSLA" or "10" (the symbol can stand in for underlying)'),
        side: z
          .enum(["long", "short"])
          .optional()
          .describe(
            "long: you hold the tokens and fear a drop (puts hedge). short: you are short and fear a rise (calls hedge). Default: long, or the given vault's kind",
          ),
      },
      outputSchema: hedgePlanShape,
      annotations: READ_ONLY,
    },
    async ({ vault, underlying, position, side }) =>
      run(async () => {
        const strike = client();
        const pos = parsePosition(position);
        const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
        if (underlying && pos.symbol && !same(underlying, pos.symbol)) {
          throw new StrikeError(`underlying ${underlying} and position ${pos.symbol} disagree`);
        }
        let vaults: VaultState[];
        let wanted: "long" | "short";
        if (vault !== undefined) {
          const v = await strike.getVault(await resolveVault(strike, vault));
          const other = underlying ?? pos.symbol;
          if (other && !same(other, v.underlyingSymbol)) {
            throw new StrikeError(`${v.symbol} is a ${v.underlyingSymbol} vault, not ${other}`);
          }
          wanted = side ?? (v.isCall ? "short" : "long");
          vaults = [v];
        } else {
          const ref = underlying ?? pos.symbol;
          if (!ref)
            throw new StrikeError('give a vault, an underlying symbol, or a position such as "10 TSLA"');
          const all = await strike.listVaults();
          vaults = all.filter((v) => same(v.underlyingSymbol, ref));
          if (vaults.length === 0) {
            const known = [...new Set(all.map((v) => v.underlyingSymbol))].join(", ") || "none";
            throw new StrikeError(`no Strike vault on ${ref}; vaults exist on: ${known}`);
          }
          wanted = side ?? "long";
        }
        const first = vaults[0] as VaultState;
        const symbol = first.underlyingSymbol;
        const dec = first.underlyingDecimals;
        const positionRaw = parseAmount(pos.amount, dec);
        if (positionRaw === 0n) throw new StrikeError("position must be positive");
        const [now, cutoff, marketOpen, oracle, usdgDecimals] = await Promise.all([
          strike.blockTimestamp(),
          strike.saleCutoff(),
          strike.marketOpen(),
          strike.oracleStatus(first.underlying),
          strike.usdgDecimals(),
        ]);

        const wantCall = wanted === "short";
        const kindWord = optionWord(wantCall);
        const considered: z.infer<typeof hedgePlanShape.considered> = [];
        const plans: { v: VaultState; s: SeriesState; options: bigint; premium: bigint }[] = [];
        for (const v of vaults) {
          const entry = { vault: v.address, vaultSymbol: v.symbol, kind: v.kind };
          if (v.isCall !== wantCall) {
            const note = `sells ${optionWord(v.isCall)}s, which do not hedge a ${wanted} position`;
            considered.push({ ...entry, usable: false, note });
            continue;
          }
          const blocked = saleBlocker(v, now, cutoff);
          if (blocked) {
            considered.push({ ...entry, usable: false, note: blocked });
            continue;
          }
          const s = v.series as SeriesState;
          const left = s.size - s.sold;
          const options = positionRaw < left ? positionRaw : left;
          try {
            const q = await strike.quoteBuy(s.id, options);
            plans.push({ v, s, options, premium: q.premium });
            const note = `series ${s.id}: strike $${usd(s.strike)}, ${formatAmount(left, dec)} options left, ${usdg(q.premium)} USDG for ${formatAmount(options, dec)}`;
            considered.push({ ...entry, usable: true, note });
          } catch (err) {
            considered.push({ ...entry, usable: false, note: explainError(err) });
          }
        }
        // Most coverage first, then the most protection (highest put strike, lowest call strike), then the cheapest.
        const cmp = (a: bigint, b: bigint) => (a === b ? 0 : a < b ? -1 : 1);
        plans.sort(
          (a, b) =>
            cmp(b.options, a.options) ||
            (wantCall ? cmp(a.s.strike, b.s.strike) : cmp(b.s.strike, a.s.strike)) ||
            cmp(a.premium, b.premium),
        );

        const spot = oracle.price === 0n ? null : oracle.price;
        const positionAmount = formatAmount(positionRaw, dec);
        const base = {
          underlying: symbol,
          side: wanted,
          position: positionAmount,
          spot: spot === null ? null : usd(spot),
          positionValue: spot === null ? null : usd(valueOf(positionRaw, spot, dec)),
          considered,
        };
        const best = plans[0];
        if (!best) {
          const why = considered.map((c) => `${c.vaultSymbol}: ${c.note}`).join("; ");
          return result({
            ...base,
            hedgeable: false,
            canBuyNow: false,
            hedge: null,
            explanation: `No ${symbol} ${kindWord} series can hedge a ${wanted} position right now (${why}). vault_state shows when the next series goes on sale.`,
          });
        }

        const { v, s, options, premium } = best;
        const spotWad = spot ?? 0n;
        const per = perOption(premium, options, dec);
        const perWad = usdgToWad(per, usdgDecimals);
        const premiumWad = usdgToWad(premium, usdgDecimals);
        const coveredValue = valueOf(options, spotWad, dec);
        const effective = wantCall ? s.strike + perWad : s.strike > perWad ? s.strike - perWad : 0n;
        // Puts: the tokens fall to the strike before the puts pay. Calls: the price rises to the strike.
        const maxLoss =
          valueOf(options, wantCall ? s.strike - spotWad : spotWad - s.strike, dec) + premiumWad;
        const costBps = coveredValue > 0n ? Number((premiumWad * 1_000_000n) / coveredValue) / 100 : 0;
        const closes = s.expiry - BigInt(cutoff);
        const opts = formatAmount(options, dec);
        const K = usd(s.strike);
        const protection = wantCall
          ? `At expiry, buying back each covered token costs at most $${K} ($${usd(effective)} with the premium): above the strike each call pays (S − K) / S ${symbol}.`
          : `At expiry each covered token is worth at least $${K} ($${usd(effective)} after the premium): below the strike each put pays K − S in USDG.`;
        let explanation = `Hedge ${wantCall ? "a short of " : ""}${positionAmount} ${symbol} with ${opts} ${kindWord}s of ${v.symbol} (series ${s.id}, strike $${K}, expiry ${iso(s.expiry)}): ${usdg(premium)} USDG now (${usdg(per)} per option, ${round(costBps / 100, 2)}% of the covered value at $${usd(spotWad)}). ${protection} Worst case versus today, premium included: a loss of $${usd(maxLoss)}.`;
        if (options < positionRaw) {
          explanation += ` Only ${opts} options are left, so ${formatAmount(positionRaw - options, dec)} ${symbol} stay unhedged.`;
        }
        explanation += marketOpen
          ? ` Buy it with buy_options { "vault": "${v.symbol}", "amount": "${opts}" } before ${iso(closes)}.`
          : ` Not buyable right now: ${ERROR_HINTS.MarketClosed}`;
        return result({
          ...base,
          hedgeable: true,
          canBuyNow: marketOpen && oracle.ok,
          explanation,
          hedge: {
            vault: v.address,
            vaultSymbol: v.symbol,
            seriesId: s.id.toString(),
            optionType: kindWord,
            strike: K,
            expiry: Number(s.expiry),
            expiryIso: iso(s.expiry),
            options: opts,
            coverage: Number((options * 10_000n) / positionRaw) / 10_000,
            premium: usdg(premium),
            premiumPerOption: usdg(per),
            costBps,
            protectedPrice: K,
            effectivePrice: usd(effective),
            maxLoss: usd(maxLoss),
            saleClosesAt: Number(closes),
            saleClosesAtIso: iso(closes),
          } satisfies z.infer<typeof hedgeSchema>,
        });
      }),
  );

  server.registerTool(
    "buy_options",
    {
      title: "Buy options",
      description:
        "Buy options of a vault's live series as this server's wallet: to hedge a stock position (puts protect tokens you hold; see hedge_plan) or for directional exposure. Quotes first and refuses when the series is not on sale, its sales have closed (shortly before expiry), the NYSE is closed, the price feed is unusable or the wallet lacks the USDG premium; then approves USDG and buys with a slippage bound. Returns the premium paid, the max loss (the premium) and the breakeven price.",
      inputSchema: {
        vault: vaultInput,
        amount: decimalInput.describe(
          'Options to buy, in underlying tokens (e.g. "2"; one option covers one token)',
        ),
        maxSlippageBps: z
          .number()
          .int()
          .min(0)
          .max(10_000)
          .optional()
          .describe("Allowed premium rise over the quote, bps (default 100 = 1%)"),
        recipient: addressInput
          .optional()
          .describe("Who receives the options (default: this server's wallet)"),
      },
      outputSchema: {
        vault: z.string(),
        vaultSymbol: z.string(),
        seriesId: z.string(),
        underlying: z.string(),
        isCall: z.boolean(),
        strike: z.string().describe("USD per token"),
        expiry: z.number(),
        expiryIso: z.string(),
        amount: z.string(),
        quotedPremium: z.string().describe("USDG"),
        maxPremium: z.string().describe("USDG: the quote plus slippage, the most the contract could charge"),
        premiumPaid: z.string().describe("USDG"),
        premiumPerOption: z.string().describe("USDG"),
        maxLoss: z.string().describe("USDG: a bought option can lose at most its premium"),
        breakeven: z
          .string()
          .describe("USD price at expiry: call strike + premium per option, put strike − it"),
        payoutAsset: z
          .string()
          .describe("What the options pay at settlement: the stock (calls) or USDG (puts)"),
        recipient: z.string(),
        txHash: z.string(),
        explanation: z.string(),
      },
      annotations: WRITE,
    },
    async ({ vault, amount, maxSlippageBps, recipient }) =>
      run(async () => {
        const strike = client();
        const me = requireWallet(strike);
        const to = recipient === undefined ? me : getAddress(recipient);
        const v = await strike.getVault(await resolveVault(strike, vault));
        const [now, cutoff, marketOpen, oracle, usdgDecimals] = await Promise.all([
          strike.blockTimestamp(),
          strike.saleCutoff(),
          strike.marketOpen(),
          strike.oracleStatus(v.underlying),
          strike.usdgDecimals(),
        ]);
        const blocked = saleBlocker(v, now, cutoff);
        if (blocked) throw new StrikeError(`not buying: ${blocked}`);
        if (!marketOpen) throw new StrikeError(`not buying: ${ERROR_HINTS.MarketClosed}`);
        if (!oracle.ok) {
          throw new StrikeError(
            `not buying: the ${v.underlyingSymbol} price feed is not usable (${oracle.status}): ${FEED_STATUS_DESCRIPTIONS[oracle.status]}`,
          );
        }
        const series = v.series as SeriesState;
        const dec = v.underlyingDecimals;
        const raw = parseAmount(amount, dec);
        if (raw === 0n) throw new StrikeError("amount must be positive");
        const left = series.size - series.sold;
        if (raw > left) {
          throw new StrikeError(`only ${formatAmount(left, dec)} options of series ${series.id} are left`);
        }

        const slippageBps = maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
        const quote = await strike.quoteBuy(series.id, raw);
        const maxPremium =
          quote.premium + (quote.premium * BigInt(slippageBps) + BigInt(BPS) - 1n) / BigInt(BPS);
        const balance = await strike.tokenBalance(strike.addresses.usdg, me);
        if (balance < quote.premium) {
          throw new StrikeError(
            `not buying: the premium is ${usdg(quote.premium)} USDG but ${me} holds ${usdg(balance)} USDG`,
          );
        }

        const res = await strike.buy(series.id, raw, { slippageBps, to });
        const per = perOption(res.premium, raw, dec);
        const perWad = usdgToWad(per, usdgDecimals);
        const breakeven = v.isCall
          ? series.strike + perWad
          : series.strike > perWad
            ? series.strike - perWad
            : 0n;
        const U = v.underlyingSymbol;
        const K = usd(series.strike);
        const n = formatAmount(raw, dec);
        const paid = usdg(res.premium);
        const payoff = v.isCall
          ? `Above $${K} at expiry each option pays (S − K) / S ${U}`
          : `Below $${K} at expiry each option pays K − S in USDG`;
        return result({
          vault: v.address,
          vaultSymbol: v.symbol,
          seriesId: series.id.toString(),
          underlying: U,
          isCall: v.isCall,
          strike: K,
          expiry: Number(series.expiry),
          expiryIso: iso(series.expiry),
          amount: n,
          quotedPremium: usdg(quote.premium),
          maxPremium: usdg(maxPremium),
          premiumPaid: paid,
          premiumPerOption: usdg(per),
          maxLoss: paid,
          breakeven: usd(breakeven),
          payoutAsset: v.isCall ? U : v.assetSymbol,
          recipient: to,
          txHash: res.hash,
          explanation: `Bought ${n} ${U} ${optionWord(v.isCall)}s (series ${series.id}, strike $${K}, expiry ${iso(series.expiry)}) for ${paid} USDG (${usdg(per)} per option). Max loss: the premium, ${paid} USDG. Breakeven at expiry: ${U} at $${usd(breakeven)}. ${payoff}; after settle_epoch, collect it with redeem_options.`,
        });
      }),
  );

  server.registerTool(
    "redeem_options",
    {
      title: "Redeem options",
      description:
        "Redeem this wallet's options of a settled (or cancelled) series and report the payout: stock tokens for calls, USDG for puts, a USDG premium refund for a cancelled series. Give a seriesId, or a vault to use its newest settled series you hold. Redeems all you hold unless amount is given.",
      inputSchema: {
        vault: vaultInput.optional().describe("Use this vault's newest settled series you hold options of"),
        seriesId: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Series id (decimal, from buy_options); default: found from the vault"),
        amount: decimalInput
          .optional()
          .describe("Options to redeem, in underlying tokens; default: all you hold"),
        recipient: addressInput
          .optional()
          .describe("Who receives the payout (default: this server's wallet)"),
      },
      outputSchema: {
        vault: z.string(),
        vaultSymbol: z.string(),
        seriesId: z.string(),
        isCall: z.boolean(),
        strike: z.string(),
        expiry: z.number(),
        expiryIso: z.string(),
        status: z.enum(["settled", "cancelled"]),
        settlementPrice: z.string().nullable(),
        amount: z.string().describe("Options redeemed (burned)"),
        paid: z.string().describe("Payout, in paidAsset"),
        paidAsset: z.string(),
        paidValue: z.string().describe("The payout's USD value at the settlement price"),
        remaining: z.string().describe("Options of this series still held"),
        recipient: z.string(),
        txHash: z.string(),
        explanation: z.string(),
      },
      annotations: WRITE,
    },
    async ({ vault, seriesId, amount, recipient }) =>
      run(async () => {
        const strike = client();
        const me = requireWallet(strike);
        const to = recipient === undefined ? me : getAddress(recipient);
        let series: SeriesState;
        if (seriesId !== undefined) {
          const s = await strike.getSeries(BigInt(seriesId));
          if (!s) throw new StrikeError(`series ${seriesId} does not exist`);
          series = s;
        } else if (vault !== undefined) {
          series = await redeemableSeries(
            strike,
            await strike.getVault(await resolveVault(strike, vault)),
            me,
          );
        } else throw new StrikeError("give a vault or a seriesId");
        const [v, balance, usdgDecimals] = await Promise.all([
          strike.getVault(series.vault),
          strike.optionBalance(series.id, me),
          strike.usdgDecimals(),
        ]);
        const dec = v.underlyingDecimals;
        if (!series.settled && !series.cancelled) {
          throw new StrikeError(
            `series ${series.id} is not settled yet: it expires ${iso(series.expiry)}; after expiry anyone can settle it with settle_epoch, then redeem (${formatAmount(balance, dec)} options held)`,
          );
        }
        if (balance === 0n) throw new StrikeError(`${me} holds no options of series ${series.id}`);
        const raw = amount === undefined ? balance : parseAmount(amount, dec);
        if (raw === 0n) throw new StrikeError("amount must be positive");
        if (raw > balance) {
          throw new StrikeError(
            `${me} holds only ${formatAmount(balance, dec)} options of series ${series.id}`,
          );
        }

        const res = await strike.redeemOptions(series.id, { amount: raw, to });
        const inStock = series.isCall && !series.cancelled;
        const paidAsset = inStock ? v.underlyingSymbol : "USDG";
        const paid = inStock ? formatAmount(res.paid, dec) : usdg(res.paid, usdgDecimals);
        const paidValue = inStock ? usd(valueOf(res.paid, series.settlementPrice, dec)) : paid;
        const price = series.settlementPrice === 0n ? null : usd(series.settlementPrice);
        const n = formatAmount(raw, dec);
        const what = `series ${series.id} (${v.underlyingSymbol} ${optionWord(series.isCall)}, strike $${usd(series.strike)})`;
        let explanation: string;
        if (series.cancelled) {
          explanation = `${what} was cancelled without a settlement price: ${n} options refunded ${paid} USDG of premium.`;
        } else if (res.paid === 0n) {
          explanation = `${what} settled at $${price}, out of the money: the ${n} options expired worthless and were burned. The premium paid was the whole loss.`;
        } else {
          explanation = `${what} settled at $${price}, in the money: ${n} options paid ${paid} ${paidAsset}${inStock ? ` (worth $${paidValue} at the settlement price)` : ""}.`;
        }
        return result({
          vault: v.address,
          vaultSymbol: v.symbol,
          seriesId: series.id.toString(),
          isCall: series.isCall,
          strike: usd(series.strike),
          expiry: Number(series.expiry),
          expiryIso: iso(series.expiry),
          status: series.cancelled ? "cancelled" : "settled",
          settlementPrice: price,
          amount: n,
          paid,
          paidAsset,
          paidValue,
          remaining: formatAmount(balance - raw, dec),
          recipient: to,
          txHash: res.hash,
          explanation,
        });
      }),
  );

  server.registerTool(
    "risk_check",
    {
      title: "Risk check (dry run)",
      description:
        "Dry-run a proposal against the vault's mandate with the contract's own previewProposal, without sending anything. Returns the verdict (MandateGuard reason), a plain-words explanation, the measured fair value, delta and capacity, and a compliant suggestion. Always run this before propose_epoch.",
      inputSchema: proposalInput,
      outputSchema: riskCheckShape,
      annotations: READ_ONLY,
    },
    async (input) => run(async () => result((await evaluate(client(), input)).report)),
  );

  server.registerTool(
    "propose_epoch",
    {
      title: "Propose this epoch's option",
      description:
        "As the vault's agent: dry-run the proposal, open the epoch if the vault is Idle, then propose by target delta (proposeByDelta, preferred) or explicit strike (proposeSeries). Refuses to send a proposal that fails the risk check unless force is true. A proposal the contract rejects slashes the agent's USDG bond, so never force in production.",
      inputSchema: {
        ...proposalInput,
        force: z
          .boolean()
          .optional()
          .describe(
            "Send even if the dry run fails (the contract will reject it and slash the bond). Demos only.",
          ),
      },
      outputSchema: {
        submitted: z.boolean(),
        forced: z.boolean(),
        accepted: z.boolean().nullable(),
        reason: z.string(),
        explanation: z.string(),
        vault: z.string(),
        seriesId: z.string().nullable(),
        mode: z.enum(["strike", "delta"]),
        strike: z.string(),
        targetDeltaBps: z.number().nullable(),
        expiry: z.number(),
        size: z.string(),
        premiumBps: z.number(),
        slashed: z.string().describe("USDG slashed from the agent's bond"),
        openTxHash: z.string().nullable(),
        txHash: z.string().nullable(),
        riskCheck: z.object({ ok: z.boolean(), reason: z.string(), explanation: z.string() }),
        suggestion: suggestionSchema.nullable(),
        agent: z.object({
          agentId: z.string(),
          bond: z.string(),
          strikes: z.number(),
          maxStrikes: z.number(),
          rejected: z.number(),
          active: z.boolean(),
        }),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ force, ...input }) =>
      run(async () => {
        const strike = client();
        const me = requireWallet(strike);
        if (input.strike === undefined && input.targetDeltaBps === undefined) {
          throw new StrikeError(
            "give a targetDeltaBps (2000 = 0.20 delta, preferred) or an explicit strike in USD",
          );
        }
        const vaultAddress = await resolveVault(strike, input.vault);
        const before = await strike.getVault(vaultAddress);
        if (before.epoch.state === "Selling") {
          throw new StrikeError(
            `vault ${before.symbol} is already selling series ${before.series?.id}; settle it after expiry before the next proposal`,
          );
        }
        const [agent, params] = await Promise.all([strike.getAgent(before.agentId), strike.registryParams()]);
        if (getAddress(agent.signer) !== getAddress(me)) {
          throw new StrikeError(
            `this server signs as ${me}, but vault ${before.symbol}'s agent #${agent.agentId} signs with ${agent.signer}`,
          );
        }
        if (!agent.active) {
          throw new StrikeError(
            `agent #${agent.agentId} cannot propose: status ${agent.status}, bond ${usdg(agent.bond)} USDG (minimum ${usdg(params.minBond)}), strikes ${agent.strikes}/${params.maxStrikes}. Top up the bond with AgentRegistry.postBond.`,
          );
        }

        const ev = await evaluate(strike, { ...input, vault: vaultAddress });
        const agentView = (a: typeof agent) => ({
          agentId: a.agentId.toString(),
          bond: usdg(a.bond),
          strikes: a.strikes,
          maxStrikes: params.maxStrikes,
          rejected: a.rejected,
          active: a.active,
        });
        const common = {
          vault: vaultAddress,
          mode: ev.mode,
          targetDeltaBps: ev.targetDeltaBps,
          expiry: Number(ev.expiry),
          size: formatAmount(ev.size, before.underlyingDecimals),
          premiumBps: ev.premiumBps,
          riskCheck: { ok: ev.report.ok, reason: ev.report.reason, explanation: ev.report.explanation },
          suggestion: ev.report.suggestion as z.infer<typeof suggestionSchema>,
          forced: force === true,
        };
        if (!ev.preview.accepted && force !== true) {
          return result({
            ...common,
            submitted: false,
            accepted: null,
            reason: ev.preview.reason,
            explanation: `Not sent: the dry run failed with ${ev.preview.reason}. ${ev.report.explanation} Use the suggestion, or pass force: true to send it anyway (it will be rejected and slashed).`,
            seriesId: null,
            strike: usd(ev.strike),
            slashed: "0",
            openTxHash: null,
            txHash: null,
            agent: agentView(agent),
          });
        }

        let openTxHash: string | null = null;
        if (before.epoch.state === "Idle") openTxHash = (await strike.openEpoch(vaultAddress)).hash;
        const res =
          ev.mode === "delta"
            ? await strike.proposeByDelta(vaultAddress, {
                targetDeltaBps: ev.targetDeltaBps as number,
                expiry: ev.expiry,
                size: ev.size,
                premiumBps: ev.premiumBps,
              })
            : await strike.proposeSeries(vaultAddress, {
                strike: ev.strike,
                expiry: ev.expiry,
                size: ev.size,
                premiumBps: ev.premiumBps,
              });
        const after = await strike.getAgent(before.agentId);
        const explanation = res.accepted
          ? `Accepted: series ${res.seriesId} is on sale (strike $${usd(res.strike)}, |delta| ${round(absDelta(res.delta ?? 0n))}, expiry ${iso(res.expiry)}).`
          : `Rejected on-chain (${res.reason}): ${explainMandateReason(res.reason, {
              mandate: before.mandate,
              delta: absDelta(ev.preview.delta),
            })} ${usdg(res.slashed)} USDG of the agent's bond was slashed to the vault's depositors; strikes ${after.strikes}/${params.maxStrikes}.${
              after.active
                ? ""
                : " The agent can no longer propose until its bond is topped up (or it is reinstated)."
            }`;
        return result({
          ...common,
          submitted: true,
          accepted: res.accepted,
          reason: res.reason,
          explanation,
          seriesId: res.seriesId?.toString() ?? null,
          strike: usd(res.strike),
          slashed: usdg(res.slashed),
          openTxHash,
          txHash: res.hash,
          agent: agentView(after),
        });
      }),
  );

  server.registerTool(
    "settle_epoch",
    {
      title: "Settle an expired epoch",
      description:
        "Settle the vault's expired series with the first price print at or after expiry (the round is found automatically), pay option holders, pay premium to depositors, and unlock the vault. Anyone may call; retrying is safe.",
      inputSchema: {
        vault: vaultInput,
        roundId: z
          .string()
          .regex(/^\d+$/)
          .optional()
          .describe("Feed round to settle with (decimal); default: discovered automatically"),
      },
      outputSchema: {
        vault: z.string(),
        seriesId: z.string(),
        epoch: z.number(),
        roundId: z.string(),
        settlementPrice: z.string().nullable(),
        payout: z.string().describe("Paid to option holders, in the vault's collateral asset"),
        premium: z.string().describe("USDG premium the epoch collected"),
        fee: z.string().describe("USDG performance fee"),
        txHash: z.string(),
        explanation: z.string(),
        agentTrack: z.object({ agentId: z.string(), settledEpochs: z.number(), cumulativePnl: z.string() }),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ vault, roundId }) =>
      run(async () => {
        const strike = client();
        requireWallet(strike);
        const v = await strike.getVault(await resolveVault(strike, vault));
        const res = await strike.settle(v.address, roundId === undefined ? {} : { roundId: BigInt(roundId) });
        const agent = await strike.getAgent(v.agentId);
        const price = res.settlementPrice === 0n ? null : usd(res.settlementPrice);
        const payout = formatAmount(res.payout, v.assetDecimals);
        return result({
          vault: v.address,
          seriesId: res.seriesId.toString(),
          epoch: Number(res.epoch),
          roundId: res.roundId.toString(),
          settlementPrice: price,
          payout,
          premium: usdg(res.premium),
          fee: usdg(res.fee),
          txHash: res.hash,
          explanation:
            price === null
              ? "Settled without a price: nothing was sold. The vault is unlocked."
              : `Settled at $${price}: ${payout} ${v.assetSymbol} to option holders, ${usdg(res.premium - res.fee)} USDG premium to depositors after a ${usdg(res.fee)} USDG fee. The vault is unlocked.`,
          agentTrack: {
            agentId: agent.agentId.toString(),
            settledEpochs: agent.settledEpochs,
            cumulativePnl: usdg(agent.cumulativePnl),
          },
        });
      }),
  );

  server.registerTool(
    "agent_stats",
    {
      title: "Agent stats",
      description:
        "An agent's bond, strikes, accepted and rejected proposals, on-chain track record (settled epochs, cumulative USDG PnL), fees and how many rejections it can absorb. Defaults to this server's agent, else the vault's agent.",
      inputSchema: {
        agentId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).optional(),
        vault: vaultInput.optional().describe("Use this vault's agent"),
      },
      outputSchema: agentSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ agentId, vault }) =>
      run(async () => {
        const strike = client();
        let id: bigint | undefined;
        if (agentId !== undefined) id = BigInt(agentId);
        else if (vault !== undefined) id = (await strike.getVault(await resolveVault(strike, vault))).agentId;
        else {
          const me = strike.viem.walletClient?.account?.address;
          if (me) id = await strike.agentOfSigner(me);
        }
        if (!id)
          throw new StrikeError("give an agentId or a vault (this server has no registered agent key)");
        const s = await strike.agentStats(id);
        return result({
          agentId: s.agentId.toString(),
          status: s.status,
          active: s.active,
          owner: s.owner,
          signer: s.signer,
          payout: s.payout,
          erc8004Id: s.erc8004Id.toString(),
          bond: usdg(s.bond),
          unbonding: usdg(s.unbonding),
          strikes: s.strikes,
          maxStrikes: s.params.maxStrikes,
          strikesLeft: s.strikesLeft,
          accepted: s.accepted,
          rejected: s.rejected,
          proposals: s.proposals,
          acceptanceRate: s.acceptanceRate,
          rejectionsUntilInactive: s.rejectionsUntilInactive,
          settledEpochs: s.settledEpochs,
          cumulativePnl: usdg(s.cumulativePnl),
          claimableFees: usdg(s.claimableFees),
          minBond: usdg(s.params.minBond),
          slashAmount: usdg(s.params.slashAmount),
          reputationRegistry: s.params.reputationRegistry,
        });
      }),
  );

  return server;
}
