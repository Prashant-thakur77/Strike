import { type SeriesState, type VaultState, epochManagerAbi } from "@strike/sdk";
import { type Address, type Hex, type PublicClient, getAddress } from "viem";
import type { Alert, AlertName, SeriesInfo, VaultInfo } from "./format.js";
import { type Sleep, backoffMs, sleep as defaultSleep } from "./retry.js";

/** The EpochManager events the bot turns into alerts. */
export const ALERT_EVENT_NAMES = [
  "EpochOpened",
  "SeriesProposed",
  "ProposalRejected",
  "OptionsBought",
  "EpochSettled",
  "EpochAborted",
  "SeriesCancelled",
] as const satisfies readonly AlertName[];

type EpochManagerEvent = Extract<(typeof epochManagerAbi)[number], { type: "event" }>;

/** ABI items of the alert events (for `getLogs({ events })`). */
export const alertEventsAbi = epochManagerAbi.filter(
  (item): item is EpochManagerEvent =>
    item.type === "event" && (ALERT_EVENT_NAMES as readonly string[]).includes(item.name),
);

/** Decoded arguments of each alert event (viem decodes uint64/uint256 as bigint, uint8/uint16 as number). */
export interface AlertEventArgs {
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
export type DecodedLog = {
  [K in AlertName]: {
    eventName: K;
    args: AlertEventArgs[K];
    transactionHash: Hex;
    blockNumber: bigint;
    logIndex: number;
  };
}[AlertName];

/** Fetch decoded alert logs for an inclusive block range. */
export type LogFetcher = (fromBlock: bigint, toBlock: bigint) => Promise<DecodedLog[]>;

/** A {@link LogFetcher} over viem `getLogs` on the EpochManager. */
export function viemLogFetcher(publicClient: PublicClient, epochManager: Address): LogFetcher {
  return async (fromBlock, toBlock) => {
    const logs = await publicClient.getLogs({
      address: epochManager,
      events: alertEventsAbi,
      fromBlock,
      toBlock,
      strict: true,
    });
    return (logs as unknown as DecodedLog[])
      .filter((l) => (ALERT_EVENT_NAMES as readonly string[]).includes(l.eventName))
      .sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      );
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

export interface ScanOptions {
  /** First and last block, inclusive. */
  from: bigint;
  to: bigint;
  /** Largest range per `getLogs` call. Halved on errors, grown back after successes. */
  maxRange: bigint;
  fetchLogs: LogFetcher;
  /** Called once per successful chunk, in order. `toBlock` is the chunk's last block. */
  onChunk: (logs: DecodedLog[], toBlock: bigint) => Promise<void>;
  /** Consecutive non-range failures allowed before giving up (default 5). */
  retries?: number;
  /** First backoff delay (default 1000 ms), doubled per failure up to 30 s. */
  baseDelayMs?: number;
  sleep?: Sleep;
  log?: (message: string) => void;
}

/**
 * Walk `[from, to]` in chunks. A failing chunk is retried with half the range (so RPC range and result limits
 * are found automatically) and, for errors that are not range limits, after an exponential backoff. Throws once
 * `retries` consecutive failures pile up; the caller keeps its cursor and tries again later.
 */
export async function scanLogs(opts: ScanOptions): Promise<void> {
  const retries = opts.retries ?? 5;
  const baseDelay = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? defaultSleep;
  const max = opts.maxRange > 0n ? opts.maxRange : 1n;
  let size = max;
  let failures = 0;
  let start = opts.from;
  while (start <= opts.to) {
    const end = start + size - 1n < opts.to ? start + size - 1n : opts.to;
    let logs: DecodedLog[];
    try {
      logs = await opts.fetchLogs(start, end);
    } catch (err) {
      const rangeLimit = isRangeLimitError(err) && size > 1n;
      size = size > 1n ? size / 2n : 1n;
      if (!rangeLimit) {
        failures += 1;
        if (failures > retries) throw err;
        const delay = backoffMs(failures, baseDelay);
        opts.log?.(
          `getLogs ${start}-${end} failed (${shortError(err)}); retry ${failures}/${retries} in ${delay} ms with range ${size}`,
        );
        await sleep(delay);
      } else {
        opts.log?.(`getLogs ${start}-${end} hit an RPC limit; retrying with range ${size}`);
      }
      continue;
    }
    await opts.onChunk(logs, end);
    failures = 0;
    start = end + 1n;
    if (size < max) size = size * 2n > max ? max : size * 2n;
  }
}

function shortError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e.shortMessage ?? e.message ?? String(err)).split("\n")[0] ?? "error";
}

/** The chain reads the alert builder needs (a subset of `StrikeClient`). */
export interface ChainReader {
  getVault(vault: Address): Promise<VaultState>;
  getSeries(seriesId: bigint): Promise<SeriesState | null>;
}

/** Joins decoded logs with vault and series details, caching both (the fields used never change). */
export class AlertBuilder {
  private vaults = new Map<Address, Promise<VaultInfo>>();
  private series = new Map<bigint, Promise<SeriesState>>();

  constructor(private readonly reader: ChainReader) {}

  vault(address: Address): Promise<VaultInfo> {
    const key = getAddress(address);
    let cached = this.vaults.get(key);
    if (!cached) {
      cached = this.reader.getVault(key).then(toVaultInfo);
      cached.catch(() => this.vaults.delete(key));
      this.vaults.set(key, cached);
    }
    return cached;
  }

  private seriesState(id: bigint): Promise<SeriesState> {
    let cached = this.series.get(id);
    if (!cached) {
      cached = this.reader.getSeries(id).then((s) => {
        if (!s) throw new Error(`series ${id} not found`);
        return s;
      });
      cached.catch(() => this.series.delete(id));
      this.series.set(id, cached);
    }
    return cached;
  }

  async build(log: DecodedLog): Promise<Alert> {
    const base = { txHash: log.transactionHash, blockNumber: log.blockNumber, logIndex: log.logIndex };
    switch (log.eventName) {
      case "EpochOpened": {
        const { vault, ...a } = log.args;
        return { ...base, ...a, name: log.eventName, vault: await this.vault(vault) };
      }
      case "SeriesProposed": {
        const { vault, ...a } = log.args;
        return { ...base, ...a, name: log.eventName, vault: await this.vault(vault) };
      }
      case "ProposalRejected": {
        const { vault, ...a } = log.args;
        return { ...base, ...a, name: log.eventName, vault: await this.vault(vault) };
      }
      case "OptionsBought": {
        const s = await this.seriesState(log.args.seriesId);
        return {
          ...base,
          ...log.args,
          name: log.eventName,
          vault: await this.vault(s.vault),
          series: toSeriesInfo(s),
        };
      }
      case "EpochSettled": {
        const { vault, ...a } = log.args;
        const s = await this.seriesState(a.seriesId);
        return {
          ...base,
          ...a,
          name: log.eventName,
          vault: await this.vault(vault),
          series: toSeriesInfo(s),
        };
      }
      case "EpochAborted": {
        const { vault, ...a } = log.args;
        return { ...base, ...a, name: log.eventName, vault: await this.vault(vault) };
      }
      case "SeriesCancelled": {
        const { vault, ...a } = log.args;
        const s = await this.seriesState(a.seriesId);
        return {
          ...base,
          ...a,
          name: log.eventName,
          vault: await this.vault(vault),
          series: toSeriesInfo(s),
        };
      }
    }
  }
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

function toSeriesInfo(s: SeriesState): SeriesInfo {
  return { strike: s.strike, expiry: s.expiry, isCall: s.isCall };
}
