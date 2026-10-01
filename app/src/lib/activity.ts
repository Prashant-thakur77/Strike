import {
  USDG_DECIMALS,
  createStrikeClient,
  deployments,
  epochManagerAbi,
  formatAmount,
  mandateReasonName,
  type SeriesState,
  type VaultState,
} from "@strike/sdk";
import { getAddress, type Address, type Hex, type PublicClient } from "viem";

// Live EpochManager activity on Robinhood Chain testnet (v2), read straight from contract logs.
// The scan and wording follow bots/telegram/src/logs.ts and format.ts (same events, same range back-off), copied
// here because the app does not depend on the bot package.

/** Chain the activity feed reads: Robinhood Chain testnet. */
export const ACTIVITY_CHAIN_ID = 46630;
export const ACTIVITY_EXPLORER = "https://explorer.testnet.chain.robinhood.com";

const deployment = deployments[String(ACTIVITY_CHAIN_ID)];
if (!deployment) throw new Error(`No Strike deployment for chain ${ACTIVITY_CHAIN_ID}`);

/** v2 EpochManager (sdk/src/deployments.generated.ts, generated from contracts/deployments/46630.json). */
export const ACTIVITY_EPOCH_MANAGER: Address = deployment.epochManager;

/** First block to scan: the deploy block in the SDK deployment map (`block`). */
export const ACTIVITY_FROM_BLOCK: bigint = (() => {
  const block = (deployment as { block?: unknown }).block;
  return typeof block === "number" && block > 0 ? BigInt(block) : 0n;
})();

export const txUrl = (hash: string) => `${ACTIVITY_EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${ACTIVITY_EXPLORER}/address/${address}`;

/** The EpochManager events the feed shows. */
export const ACTIVITY_EVENT_NAMES = [
  "EpochOpened",
  "SeriesProposed",
  "ProposalRejected",
  "OptionsBought",
  "EpochSettled",
  "EpochAborted",
  "SeriesCancelled",
] as const;

export type ActivityEventName = (typeof ACTIVITY_EVENT_NAMES)[number];

type EpochManagerEvent = Extract<(typeof epochManagerAbi)[number], { type: "event" }>;

/** ABI items of the feed's events (for `getLogs({ events })`). */
export const activityEventsAbi = epochManagerAbi.filter(
  (item): item is EpochManagerEvent =>
    item.type === "event" && (ACTIVITY_EVENT_NAMES as readonly string[]).includes(item.name),
);

/** Decoded arguments of each event (viem decodes uint64/uint256 as bigint, uint8/uint16 as number). */
export interface ActivityEventArgs {
  EpochOpened: { vault: Address; epoch: bigint; spot: bigint };
  SeriesProposed: {
    vault: Address;
    epoch: bigint;
    seriesId: bigint;
    strike: bigint;
    expiry: bigint;
    size: bigint;
    premiumBps: number;
    fairValue: bigint;
    delta: bigint;
  };
  ProposalRejected: {
    vault: Address;
    epoch: bigint;
    agentId: bigint;
    reason: number;
    slashed: bigint;
    strike: bigint;
    expiry: bigint;
    size: bigint;
    premiumBps: number;
  };
  OptionsBought: { seriesId: bigint; buyer: Address; recipient: Address; amount: bigint; premium: bigint };
  EpochSettled: {
    vault: Address;
    epoch: bigint;
    seriesId: bigint;
    settlementPrice: bigint;
    payout: bigint;
    premium: bigint;
    fee: bigint;
  };
  EpochAborted: { vault: Address; epoch: bigint };
  SeriesCancelled: { vault: Address; epoch: bigint; seriesId: bigint };
}

/** A decoded log, as viem's `getLogs({ events, strict: true })` returns it. */
export type ActivityLog = {
  [K in ActivityEventName]: {
    eventName: K;
    args: ActivityEventArgs[K];
    transactionHash: Hex;
    blockNumber: bigint;
    logIndex: number;
  };
}[ActivityEventName];

/** Fetch decoded logs for an inclusive block range. */
export type LogFetcher = (fromBlock: bigint, toBlock: bigint) => Promise<ActivityLog[]>;

const byChainOrder = (a: ActivityLog, b: ActivityLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

/** A {@link LogFetcher} over viem `getLogs` on the EpochManager. */
export function viemLogFetcher(
  client: PublicClient,
  epochManager: Address = ACTIVITY_EPOCH_MANAGER,
): LogFetcher {
  return async (fromBlock, toBlock) => {
    const logs = await client.getLogs({
      address: epochManager,
      events: activityEventsAbi,
      fromBlock,
      toBlock,
      strict: true,
    });
    return (logs as unknown as ActivityLog[])
      .filter((l) => (ACTIVITY_EVENT_NAMES as readonly string[]).includes(l.eventName))
      .sort(byChainOrder);
  };
}

/** True when an RPC error looks like a block-range or result-size limit (retry with a smaller range). */
export function isRangeLimitError(err: unknown): boolean {
  const text =
    err instanceof Error
      ? `${err.message} ${String((err as { details?: unknown }).details ?? "")}`
      : String(err);
  return /block range|range (is )?too (large|wide|big)|range limit|exceed(s|ed)? .*range|more than \d+ (results|logs|blocks)|too many (results|logs|blocks)|limit exceeded|response size|query timeout|log response/i.test(
    text,
  );
}

/** Exponential backoff: base, 2x base, 4x base, ... capped at `maxMs`. `attempt` starts at 1. */
export function backoffMs(attempt: number, baseMs: number, maxMs = 8_000): number {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ScanOptions<T = ActivityLog> {
  /** First and last block, inclusive. */
  from: bigint;
  to: bigint;
  /** Largest range per `getLogs` call. Halved on errors, grown back after successes. */
  maxRange: bigint;
  fetchLogs: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>;
  /** Consecutive non-range failures allowed before giving up (default 3: a page should not hang for long). */
  retries?: number;
  /** First backoff delay (default 500 ms), doubled per failure. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Walk `[from, to]` in chunks and return every log, oldest first. A failing chunk is retried with half the range
 * (so RPC range and result limits are found automatically) and, for errors that are not range limits, after an
 * exponential backoff. Throws once `retries` consecutive failures pile up.
 */
export async function scanLogs<T = ActivityLog>(opts: ScanOptions<T>): Promise<T[]> {
  const retries = opts.retries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  const max = opts.maxRange > 0n ? opts.maxRange : 1n;
  const out: T[] = [];
  let size = max;
  let failures = 0;
  let start = opts.from;
  while (start <= opts.to) {
    const end = start + size - 1n < opts.to ? start + size - 1n : opts.to;
    let logs: T[];
    try {
      logs = await opts.fetchLogs(start, end);
    } catch (err) {
      const rangeLimit = isRangeLimitError(err) && size > 1n;
      size = size > 1n ? size / 2n : 1n;
      if (!rangeLimit) {
        failures += 1;
        if (failures > retries) throw err;
        await sleep(backoffMs(failures, baseDelay));
      }
      continue;
    }
    out.push(...logs);
    failures = 0;
    start = end + 1n;
    if (size < max) size = size * 2n > max ? max : size * 2n;
  }
  return out;
}

/* ------------------------------------------------------------------ plain-English descriptions */

/** What a description needs to know about a vault. */
export interface VaultInfo {
  address: Address;
  symbol: string;
  isCall: boolean;
  underlyingSymbol: string;
  underlyingDecimals: number;
  /** Collateral token: the stock token (calls) or USDG (puts). */
  assetSymbol: string;
  assetDecimals: number;
}

/** What a description needs to know about a series (strike and expiry never change after the proposal). */
export interface SeriesInfo {
  vault: Address;
  agentId: bigint;
  strike: bigint;
  expiry: bigint;
  isCall: boolean;
}

export function toVaultInfo(v: VaultState): VaultInfo {
  return {
    address: v.address,
    symbol: v.symbol,
    isCall: v.isCall,
    underlyingSymbol: v.underlyingSymbol,
    underlyingDecimals: v.underlyingDecimals,
    assetSymbol: v.assetSymbol,
    assetDecimals: v.assetDecimals,
  };
}

export function toSeriesInfo(s: SeriesState): SeriesInfo {
  return { vault: s.vault, agentId: s.agentId, strike: s.strike, expiry: s.expiry, isCall: s.isCall };
}

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A WAD USD value: "$369.86", "$1,204.50" (cents, rounded half up). */
export function usd(wad: bigint): string {
  const negative = wad < 0n;
  const abs = negative ? -wad : wad;
  const cents = (abs + 5n * 10n ** 15n) / 10n ** 16n;
  return `${negative ? "-" : ""}$${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** USDG base units rounded to the cent, without a trailing ".00": "10", "10.01", "1,250.50". */
export function usdg(value: bigint, decimals = USDG_DECIMALS): string {
  const scale = decimals > 2 ? 10n ** BigInt(decimals - 2) : 1n;
  const cents = decimals > 2 ? (value + scale / 2n) / scale : value * 10n ** BigInt(2 - decimals);
  const whole = group((cents / 100n).toString());
  const frac = (cents % 100n).toString().padStart(2, "0");
  return frac === "00" ? whole : `${whole}.${frac}`;
}

/** Unix seconds as "2026-10-02 20:00 UTC". */
export function utc(seconds: bigint | number): string {
  const iso = new Date(Number(seconds) * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const kindOf = (isCall: boolean) => (isCall ? "call" : "put");

/** "1 TSLA call", "4 TSLA calls", "0.0453 TSLA puts". */
function options(value: bigint, v: VaultInfo, isCall: boolean): string {
  const n = formatAmount(value, v.underlyingDecimals, 4);
  return `${n} ${v.underlyingSymbol} ${kindOf(isCall)}${n === "1" ? "" : "s"}`;
}

/** |delta| of a WAD delta with 2 decimals ("0.20"). */
function absDelta(delta: bigint): string {
  const abs = delta < 0n ? -delta : delta;
  const hundredths = (abs * 100n + 5n * 10n ** 15n) / 10n ** 18n;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

function reasonName(code: number): string {
  try {
    return mandateReasonName(code);
  } catch {
    return `reason ${code}`;
  }
}

/** Everything {@link describe} needs: the log plus its vault (and series, where the event only carries an id). */
export interface DescribeInput {
  log: ActivityLog;
  vault: VaultInfo;
  series?: SeriesInfo;
}

/** One plain line per event, e.g. "Agent #1 proposal rejected: DeltaOutOfBand, 10 USDG slashed to depositors". */
export function describe({ log, vault: v, series }: DescribeInput): string {
  switch (log.eventName) {
    case "EpochOpened":
      return `Epoch ${log.args.epoch} opened with ${v.underlyingSymbol} at ${usd(log.args.spot)}; the vault is locked until it settles`;
    case "SeriesProposed": {
      const a = log.args;
      const who = series ? `Agent #${series.agentId}` : "The agent";
      return `${who} proposed ${options(a.size, v, v.isCall)} at strike ${usd(a.strike)}, ${absDelta(a.delta)} delta, expiring ${utc(a.expiry)}: accepted and on sale`;
    }
    case "ProposalRejected": {
      const a = log.args;
      const slash = a.slashed > 0n ? `${usdg(a.slashed)} USDG slashed to depositors` : "no bond slashed";
      return `Agent #${a.agentId} proposal rejected: ${reasonName(a.reason)}, ${slash}`;
    }
    case "OptionsBought": {
      const a = log.args;
      return `${options(a.amount, v, series?.isCall ?? v.isCall)} bought for ${usdg(a.premium)} USDG`;
    }
    case "EpochSettled": {
      const a = log.args;
      if (a.settlementPrice === 0n) return `Epoch ${a.epoch} closed with no options sold`;
      const outcome =
        a.payout > 0n
          ? `in the money, ${formatAmount(a.payout, v.assetDecimals, 4)} ${v.assetSymbol} paid to holders`
          : "out of the money, the options expired worthless";
      return `Epoch ${a.epoch} settled at ${usd(a.settlementPrice)}: ${outcome}; ${usdg(a.premium)} USDG premium`;
    }
    case "EpochAborted":
      return `Epoch ${log.args.epoch} aborted: no series was accepted, the vault is unlocked`;
    case "SeriesCancelled":
      return `Series #${log.args.seriesId} cancelled: no settlement price in time, holders can redeem for a premium refund`;
  }
}

/** Good news, a penalty, or a neutral step (drives the row's tag colour). */
export function toneOf(log: ActivityLog): "ok" | "bad" | "neutral" {
  switch (log.eventName) {
    case "SeriesProposed":
    case "OptionsBought":
    case "EpochSettled":
      return "ok";
    case "ProposalRejected":
    case "EpochAborted":
    case "SeriesCancelled":
      return "bad";
    default:
      return "neutral";
  }
}

/** Short tag per event. */
export const EVENT_LABEL: Record<ActivityEventName, string> = {
  EpochOpened: "Epoch opened",
  SeriesProposed: "Proposed",
  ProposalRejected: "Rejected",
  OptionsBought: "Bought",
  EpochSettled: "Settled",
  EpochAborted: "Aborted",
  SeriesCancelled: "Cancelled",
};

/* ------------------------------------------------------------------ reader */

export interface ActivityRow {
  /** `${txHash}:${logIndex}`: unique per event. */
  id: string;
  event: ActivityEventName;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  /** Block timestamp, unix seconds. */
  timestamp: number;
  vault: Address;
  vaultSymbol: string;
  text: string;
  tone: "ok" | "bad" | "neutral";
}

export interface ActivitySnapshot {
  /** Newest first, cut to the requested limit. */
  rows: ActivityRow[];
  /** Events found in the whole scanned range (before the limit). */
  total: number;
  fromBlock: bigint;
  toBlock: bigint;
}

/** Largest `getLogs` range tried first. The public testnet RPC answers the whole v2 history in one call today. */
export const MAX_RANGE = 500_000n;

/**
 * Reads the feed incrementally: the first call scans from the deploy block, later calls only the blocks since.
 * Vaults, series and block timestamps are cached (the fields used never change).
 */
export class ActivityReader {
  private logs: ActivityLog[] = [];
  private scannedTo: bigint;
  private readonly vaults = new Map<Address, Promise<VaultInfo>>();
  private readonly series = new Map<bigint, Promise<SeriesInfo>>();
  private readonly times = new Map<bigint, Promise<number>>();
  private readonly strike;
  private readonly fetchLogs: LogFetcher;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly opts: { fromBlock?: bigint; epochManager?: Address; maxRange?: bigint } = {},
  ) {
    this.scannedTo = (opts.fromBlock ?? ACTIVITY_FROM_BLOCK) - 1n;
    this.fetchLogs = viemLogFetcher(client, opts.epochManager ?? ACTIVITY_EPOCH_MANAGER);
    this.strike = createStrikeClient({ publicClient: client, chainId: ACTIVITY_CHAIN_ID });
  }

  /** Scan any new blocks (one scan at a time; concurrent callers share it). */
  private async catchUp(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const head = await this.client.getBlockNumber();
      if (head <= this.scannedTo) return;
      const fresh = await scanLogs({
        from: this.scannedTo + 1n,
        to: head,
        maxRange: this.opts.maxRange ?? MAX_RANGE,
        fetchLogs: this.fetchLogs,
      });
      const seen = new Set(this.logs.map((l) => `${l.transactionHash}:${l.logIndex}`));
      this.logs = [
        ...this.logs,
        ...fresh.filter((l) => !seen.has(`${l.transactionHash}:${l.logIndex}`)),
      ].sort(byChainOrder);
      this.scannedTo = head;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private cached<K, V>(map: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> {
    let hit = map.get(key);
    if (!hit) {
      hit = load();
      hit.catch(() => map.delete(key));
      map.set(key, hit);
    }
    return hit;
  }

  private vault(address: Address): Promise<VaultInfo> {
    const key = getAddress(address);
    return this.cached(this.vaults, key, () => this.strike.getVault(key).then(toVaultInfo));
  }

  private seriesInfo(id: bigint): Promise<SeriesInfo> {
    return this.cached(this.series, id, async () => {
      const s = await this.strike.getSeries(id);
      if (!s) throw new Error(`series ${id} not found`);
      return toSeriesInfo(s);
    });
  }

  private blockTime(block: bigint): Promise<number> {
    return this.cached(this.times, block, async () =>
      Number((await this.client.getBlock({ blockNumber: block })).timestamp),
    );
  }

  private async row(log: ActivityLog): Promise<ActivityRow> {
    const series =
      log.eventName === "OptionsBought" || log.eventName === "SeriesProposed"
        ? await this.seriesInfo(log.args.seriesId).catch(() => undefined)
        : undefined;
    const vaultAddress = "vault" in log.args ? log.args.vault : series?.vault;
    if (!vaultAddress) throw new Error(`vault of ${log.eventName} in ${log.transactionHash} not found`);
    const [vault, timestamp] = await Promise.all([this.vault(vaultAddress), this.blockTime(log.blockNumber)]);
    return {
      id: `${log.transactionHash}:${log.logIndex}`,
      event: log.eventName,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      timestamp,
      vault: vault.address,
      vaultSymbol: vault.symbol,
      text: describe({ log, vault, series }),
      tone: toneOf(log),
    };
  }

  /** The newest `limit` events (all of them when `limit` is undefined), newest first. */
  async read(limit?: number): Promise<ActivitySnapshot> {
    await this.catchUp();
    const newest = [...this.logs].reverse();
    const shown = limit === undefined ? newest : newest.slice(0, Math.max(0, limit));
    const rows = await Promise.all(shown.map((l) => this.row(l)));
    return {
      rows,
      total: this.logs.length,
      fromBlock: this.opts.fromBlock ?? ACTIVITY_FROM_BLOCK,
      toBlock: this.scannedTo,
    };
  }
}
