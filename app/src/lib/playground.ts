import {
  agentRegistryAbi,
  blackScholesRefAbi,
  createStrikeClient,
  epochManagerAbi,
  epochStateName,
  floorToCent,
  getDeployment,
  marketCalendarAbi,
  stockOracleAbi,
  strikeChains,
  vaultCapacity,
  type AgentInfo,
  type AgentRegistryParams,
  type EpochState,
  type MandateReason,
  type OracleStatus,
  type ProposalPreview,
  type StrikeClient,
  type VaultState,
} from "@strike/sdk";
import { createPublicClient, formatUnits, getAddress, type Abi, type Address, type PublicClient } from "viem";
import { readTransport } from "@/lib/rpc/client";
import {
  decodeRevertWith,
  parseDecimal,
  sizeText,
  trimDecimal,
  type DecodedRevert,
} from "@/components/app/playground/model";

// Pure helpers (no SDK import, so the Playwright specs can load them) live beside the components.
export * from "@/components/app/playground/model";

// ---------------------------------------------------------------------------------------------- network

/** The playground always reads Robinhood Chain testnet (v2 deployment), whatever network the app is set to. */
export const PLAYGROUND_CHAIN_ID = 46630 as const;
export const PLAYGROUND_CHAIN = strikeChains.robinhoodTestnet;
export const PLAYGROUND_RPC = PLAYGROUND_CHAIN.rpcUrls.default.http[0];
export const PLAYGROUND_EXPLORER = "https://explorer.testnet.chain.robinhood.com";

export const MANDATE_GUARD_URL =
  "https://github.com/Prashant-thakur77/Strike/blob/main/contracts/src/libraries/MandateGuard.sol";
export const EPOCH_MANAGER_URL =
  "https://github.com/Prashant-thakur77/Strike/blob/main/contracts/src/core/EpochManager.sol";
/** The live `ProposalRejected` on the put vault (agent #1 slashed). */
export const LIVE_REJECTION_TX = "0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0";
export const LIVE_REJECTION_URL = `${PLAYGROUND_EXPLORER}/tx/${LIVE_REJECTION_TX}`;

export const explorerAddress = (a: string) => `${PLAYGROUND_EXPLORER}/address/${a}`;

export type VaultKey = "call" | "put";

export interface PlaygroundVault {
  key: VaultKey;
  address: Address;
  label: string;
  short: string;
}

const deployment = getDeployment(PLAYGROUND_CHAIN_ID);
const vaultMap = deployment.vaults as Record<string, string>;

export const PLAYGROUND_VAULTS: readonly PlaygroundVault[] = [
  {
    key: "call",
    address: getAddress(vaultMap.TSLA_covered_call ?? "0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e"),
    label: "TSLA covered call",
    short: "Covered call",
  },
  {
    key: "put",
    address: getAddress(vaultMap.TSLA_cash_secured_put ?? "0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7"),
    label: "TSLA cash-secured put",
    short: "Cash-secured put",
  },
];

export function vaultByKey(key: VaultKey): PlaygroundVault {
  return PLAYGROUND_VAULTS.find((v) => v.key === key) ?? PLAYGROUND_VAULTS[0];
}

let strike: StrikeClient | null = null;

/** Read-only Strike client on its own public client (no wallet). Reads are batched through Multicall3. */
export function playgroundClient(): StrikeClient {
  if (!strike) {
    const publicClient = createPublicClient({
      chain: PLAYGROUND_CHAIN,
      transport: readTransport(PLAYGROUND_CHAIN_ID, {
        timeout: 20_000,
        retryCount: 2,
      }),
      batch: { multicall: { wait: 16 } },
    }) as PublicClient;
    strike = createStrikeClient({ publicClient, chainId: PLAYGROUND_CHAIN_ID });
  }
  return strike;
}

// ---------------------------------------------------------------------------------------------- reverts

/** Every custom error a preview can bubble up: EpochManager, StockOracle (SafeStockFeed), pricer, calendar. */
type AbiError = Extract<Abi[number], { type: "error" }>;

const ERRORS_ABI: Abi = (() => {
  const seen = new Set<string>();
  const out: AbiError[] = [];
  for (const abi of [
    epochManagerAbi,
    stockOracleAbi,
    blackScholesRefAbi,
    marketCalendarAbi,
    agentRegistryAbi,
  ]) {
    for (const item of abi as Abi) {
      if (item.type !== "error") continue;
      const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
})();

/** The contract revert inside a viem error, decoded against every Strike error; null when it isn't a revert. */
export function decodeRevert(err: unknown): DecodedRevert | null {
  return decodeRevertWith(err, ERRORS_ABI);
}

// ---------------------------------------------------------------------------------------------- reads

export interface EpochSnapshot {
  state: EpochState;
  stateCode: number;
  openedAt: bigint;
  seriesId: bigint;
  /** Spot and sigma the epoch opened with (WAD). Meaningful while Open (and kept afterwards). */
  openSpot: bigint;
  openSigma: bigint;
}

export interface VaultContext {
  key: VaultKey;
  vault: VaultState;
  epoch: EpochSnapshot;
  /** Live SafeStockFeed spot, or null with the revert when the feed is unsafe. */
  liveSpot: bigint | null;
  liveSpotError: DecodedRevert | null;
  oracle: OracleStatus | null;
  /** True while Open: previewProposal judges against the opening snapshot, not live spot. */
  usesSnapshot: boolean;
  /** The spot and sigma the contract judges against right now. */
  refSpot: bigint | null;
  refSigma: bigint;
  expiries: { next: bigint; following: bigint };
}

export interface PlaygroundSnapshot {
  blockTimestamp: bigint;
  marketOpen: boolean;
  usdgDecimals: number;
  registry: AgentRegistryParams;
  agents: Record<string, AgentInfo>;
  vaults: Record<VaultKey, VaultContext>;
  fetchedAt: number;
}

const DAY = 86_400n;

async function readVaultContext(s: StrikeClient, pv: PlaygroundVault, now: bigint): Promise<VaultContext> {
  const pc = s.viem.publicClient;
  const [vault, ep] = await Promise.all([
    s.getVault(pv.address),
    pc.readContract({
      address: s.addresses.epochManager,
      abi: epochManagerAbi,
      functionName: "epochs",
      args: [pv.address],
    }),
  ]);
  const [stateCode, openedAt, seriesId, openSpot, openSigma] = ep;
  const epoch: EpochSnapshot = {
    state: epochStateName(stateCode),
    stateCode,
    openedAt,
    seriesId,
    openSpot,
    openSigma,
  };
  const [live, oracle, next] = await Promise.all([
    s.spot(vault.underlying).then(
      (v) => ({ spot: v, error: null }),
      (e: unknown) => {
        const r = decodeRevert(e);
        if (!r) throw e;
        return { spot: null, error: r };
      },
    ),
    s.oracleStatus(vault.underlying).catch(() => null),
    s.nextExpiry(vault.mandate),
  ]);
  const nextExpiry = next ?? (await s.weeklyExpiry(now + 7n * DAY));
  // Monday of the week after: MarketCalendar returns that week's Friday (or Thursday) close.
  const following = await s.weeklyExpiry(nextExpiry + 3n * DAY);
  const usesSnapshot = epoch.state === "Open";
  return {
    key: pv.key,
    vault,
    epoch,
    liveSpot: live.spot,
    liveSpotError: live.error,
    oracle,
    usesSnapshot,
    refSpot: usesSnapshot ? openSpot : live.spot,
    refSigma: usesSnapshot ? openSigma : vault.sigma,
    expiries: { next: nextExpiry, following },
  };
}

/** Both vaults, the registry's slash economics and each vault's agent, in one pass. */
export async function readPlayground(s: StrikeClient = playgroundClient()): Promise<PlaygroundSnapshot> {
  const [now, marketOpen, usdgDecimals, registry] = await Promise.all([
    s.blockTimestamp(),
    s.marketOpen(),
    s.usdgDecimals(),
    s.registryParams(),
  ]);
  const [call, put] = await Promise.all(PLAYGROUND_VAULTS.map((pv) => readVaultContext(s, pv, now)));
  const ids = [...new Set([call!.vault.agentId, put!.vault.agentId].map(String))];
  const agentList = await Promise.all(ids.map((id) => s.getAgent(BigInt(id))));
  const agents = Object.fromEntries(agentList.map((a) => [a.agentId.toString(), a]));
  return {
    blockTimestamp: now,
    marketOpen,
    usdgDecimals,
    registry,
    agents,
    vaults: { call: call!, put: put! },
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------- proposals

export type ProposeMode = "delta" | "strike";
export type ExpiryChoice = "next" | "following" | "early";

/** What the form holds, as text (exactly what the user typed). */
export interface ProposalForm {
  vault: VaultKey;
  mode: ProposeMode;
  /** |delta| as a decimal of 1 ("0.20"). */
  delta: string;
  /** USD per token ("369.64"). */
  strike: string;
  /** Options, in whole tokens ("2.5"). */
  size: string;
  /** Premium as a percentage of fair value ("100"). */
  premium: string;
  expiry: ExpiryChoice;
}

export interface ProposalInput {
  vault: Address;
  mode: ProposeMode;
  targetDeltaBps: number;
  strike: bigint;
  expiry: bigint;
  size: bigint;
  premiumBps: number;
}

export function expiryFor(choice: ExpiryChoice, ctx: VaultContext): bigint {
  if (choice === "following") return ctx.expiries.following;
  // An hour before the close: inside the tenor window, but not a session close.
  if (choice === "early") return ctx.expiries.next - 3600n;
  return ctx.expiries.next;
}

export type FormCheck =
  { ok: true; input: ProposalInput } | { ok: false; field: keyof ProposalForm; message: string };

/** Validate the form locally (units and ranges the contract's types impose) before asking the chain. */
export function formToInput(form: ProposalForm, ctx: VaultContext): FormCheck {
  const dec = ctx.vault.underlyingDecimals;
  let targetDeltaBps = 0;
  let strike = 0n;
  if (form.mode === "delta") {
    const d = parseDecimal(form.delta, 4);
    if (d === null || d <= 0n || d >= 10_000n) {
      return { ok: false, field: "delta", message: "Enter a |delta| between 0.0001 and 0.9999." };
    }
    targetDeltaBps = Number(d);
  } else {
    const k = parseDecimal(form.strike, 2);
    if (k === null || k === 0n) return { ok: false, field: "strike", message: "Enter a strike in dollars." };
    strike = k * 10n ** 16n; // cents → WAD
  }
  const size = parseDecimal(form.size, dec);
  if (size === null) return { ok: false, field: "size", message: "Enter a size in options." };
  const premium = parseDecimal(form.premium, 2);
  if (premium === null)
    return { ok: false, field: "premium", message: "Enter the premium as a % of fair value." };
  if (premium > 65_535n) {
    return { ok: false, field: "premium", message: "The contract takes at most 655.35% (a uint16 of bps)." };
  }
  return {
    ok: true,
    input: {
      vault: ctx.vault.address,
      mode: form.mode,
      targetDeltaBps,
      strike,
      expiry: expiryFor(form.expiry, ctx),
      size,
      premiumBps: Number(premium),
    },
  };
}

export type PreviewOutcome =
  | {
      kind: "verdict";
      preview: ProposalPreview;
      /** The strike judged (solved on-chain in delta mode). */
      strike: bigint;
      input: ProposalInput;
    }
  | {
      kind: "revert";
      revert: DecodedRevert;
      /** "solve": the strike solve (live spot or pricer) reverted; "preview": previewProposal did. */
      stage: "solve" | "preview";
      input: ProposalInput;
    };

/**
 * Ask the deployed EpochManager. Delta mode goes through the SDK's `previewProposeByDelta` (the pricer's
 * `strikeForDelta`, rounded to a cent the way `proposeByDelta` rounds); strike mode calls `previewProposal` directly.
 * Contract reverts come back as a decoded outcome; anything else (network) throws.
 */
export async function runPreview(
  input: ProposalInput,
  s: StrikeClient = playgroundClient(),
): Promise<PreviewOutcome> {
  let strikeWad = input.strike;
  if (input.mode === "delta") {
    try {
      strikeWad = await s.solveStrike(input.vault, {
        targetDeltaBps: input.targetDeltaBps,
        expiry: input.expiry,
      });
    } catch (e) {
      const revert = decodeRevert(e);
      if (!revert) throw e;
      return { kind: "revert", revert, stage: "solve", input };
    }
  }
  try {
    const preview = await s.previewProposal(input.vault, {
      strike: strikeWad,
      expiry: input.expiry,
      size: input.size,
      premiumBps: input.premiumBps,
    });
    return { kind: "verdict", preview, strike: strikeWad, input: { ...input, strike: strikeWad } };
  } catch (e) {
    const revert = decodeRevert(e);
    if (!revert) throw e;
    return { kind: "revert", revert, stage: "preview", input: { ...input, strike: strikeWad } };
  }
}

// ---------------------------------------------------------------------------------------------- presets

export type PresetId = "honest" | "reckless" | "big" | "cheap";

export interface Preset {
  id: PresetId;
  who: string;
  title: string;
  expect: MandateReason;
  note: string;
  build: (snap: PlaygroundSnapshot) => ProposalForm;
}

function usdText(wad: bigint): string {
  return trimDecimal(formatUnits(floorToCent(wad), 18));
}

/** Options the vault's collateral backs at `strike` (the contract's `_capacity`). */
export function capacityAt(ctx: VaultContext, strikeWad: bigint, usdgDecimals: number): bigint {
  return vaultCapacity({
    isCall: ctx.vault.isCall,
    totalAssets: ctx.vault.totalAssets,
    strike: strikeWad,
    underlyingDecimals: ctx.vault.underlyingDecimals,
    usdgDecimals,
  });
}

/** A share (bps) of what the vault can back near spot. */
function sizeShare(snap: PlaygroundSnapshot, key: VaultKey, bps: bigint, strikeWad?: bigint): string {
  const ctx = snap.vaults[key];
  const ref = strikeWad ?? ctx.refSpot ?? 0n;
  const cap = capacityAt(ctx, ref, snap.usdgDecimals);
  return sizeText((cap * bps) / 10_000n, ctx.vault.underlyingDecimals);
}

/** One cent inside the money line: the nearest strike the mandate's side rule allows. */
function atTheMoney(ctx: VaultContext): bigint {
  const spot = ctx.refSpot ?? 0n;
  const cent = 10n ** 16n;
  return ctx.vault.isCall ? floorToCent(spot) + cent : floorToCent(spot - 1n);
}

/**
 * The preferred vault if it holds collateral, else the other one: a preset sized against an empty vault would stop
 * at `ZeroSize` before the rule it is meant to show.
 */
function funded(snap: PlaygroundSnapshot, preferred: VaultKey): VaultKey {
  if (snap.vaults[preferred].vault.totalAssets > 0n) return preferred;
  return preferred === "put" ? "call" : "put";
}

export const PRESETS: readonly Preset[] = [
  {
    id: "honest",
    who: "Honest agent",
    title: "0.20-delta call",
    expect: "None",
    note: "Half the vault, fair price, a strike the pricer solves for |Δ| 0.20.",
    build: (snap) => ({
      vault: "call",
      mode: "delta",
      delta: "0.20",
      strike: "",
      size: sizeShare(snap, "call", 5000n),
      premium: "100",
      expiry: "next",
    }),
  },
  {
    id: "reckless",
    who: "Reckless agent",
    title: "At-the-money strike",
    expect: "DeltaOutOfBand",
    note: "Strike a cent out of the money: |Δ| near 0.50, far outside the 0.10–0.35 band.",
    build: (snap) => {
      const key = funded(snap, "put");
      const k = atTheMoney(snap.vaults[key]);
      return {
        vault: key,
        mode: "strike",
        delta: "0.20",
        strike: usdText(k),
        size: sizeShare(snap, key, 2500n, k),
        premium: "100",
        expiry: "next",
      };
    },
  },
  {
    id: "big",
    who: "Greedy agent",
    title: "Too big",
    expect: "SizeTooLarge",
    note: "Sells the whole vault; the mandate caps a proposal at a share of capacity.",
    build: (snap) => ({
      vault: "call",
      mode: "delta",
      delta: "0.20",
      strike: "",
      size: sizeText(snap.vaults.call.vault.totalAssets, snap.vaults.call.vault.underlyingDecimals),
      premium: "100",
      expiry: "next",
    }),
  },
  {
    id: "cheap",
    who: "Cheap agent",
    title: "50% of fair value",
    expect: "PremiumBelowFair",
    note: "Asks half the Black-Scholes price: a gift to the buyer, paid by depositors.",
    build: (snap) => {
      const key = funded(snap, "put");
      return {
        vault: key,
        mode: "delta",
        delta: "0.20",
        strike: "",
        size: sizeShare(snap, key, 2500n),
        premium: "50",
        expiry: "next",
      };
    },
  },
];
