import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BPS,
  FEED_STATUS_DESCRIPTIONS,
  type ProposalPreview,
  STRIKE_SDK_VERSION,
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
import { agentSchema, riskCheckShape, suggestionSchema, vaultSchema } from "./schemas.js";

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
      return `Selling until ${iso(expiry)}; buyers can use quote. Settle with settle_epoch after expiry.`;
    }
  }
}

/**
 * Build the Strike MCP server: tools to list and inspect vaults, quote options, dry-run and send an agent's
 * proposal, settle epochs and read agent track records, plus the STRIKE_SKILL.md resource.
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
          "Options vaults for Robinhood Chain stock tokens, paid in USDG. Agents propose weekly strikes; the contract enforces each vault's mandate and slashes the agent's bond for proposals outside it.",
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
