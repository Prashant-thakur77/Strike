import {
  type StrikeClient,
  createStrikeClient,
  epochManagerAbi,
  formatAmount,
  formatWad,
  getDeployment,
  getStrikeChain,
  loadStrikeConfig,
  mirrorFeedAbi,
  rpcEndpointsFor,
  stockOracleAbi,
  transportFromEndpoints,
  wadToNumber,
} from "@strike/sdk";
import { type Address, createPublicClient, getAddress } from "viem";

// Direct, read-only chain reads the MCP tools do not expose: the epoch's opening snapshot, the NYSE session and the
// last settlement of a vault. Same STRIKE_CHAIN_ID / STRIKE_RPC_URL / ALCHEMY_API_KEY rules as the MCP server.

/**
 * A read-only Strike client for STRIKE_CHAIN_ID (default: strike.config.json's defaultChainId, 46630) over the SDK's
 * endpoints: Alchemy when ALCHEMY_API_KEY is set (key in a header), then STRIKE_RPC_URL, then the chain's public RPC.
 */
export function readClient(env: NodeJS.ProcessEnv = process.env): StrikeClient {
  const chainId = Number(env.STRIKE_CHAIN_ID ?? loadStrikeConfig().defaultChainId);
  const base = getStrikeChain(chainId);
  const endpoints = rpcEndpointsFor(chainId, env);
  const chain = { ...base, rpcUrls: { default: { http: [endpoints[0]!.url] } } };
  const publicClient = createPublicClient({ chain, transport: transportFromEndpoints(endpoints) });
  return createStrikeClient({ publicClient, chainId });
}

const EPOCH_STATES = ["Idle", "Open", "Selling"] as const;

/** `EpochManager.epochs(vault)`, including the opening snapshot the SDK's EpochInfo leaves out. */
export interface EpochSnapshot {
  state: (typeof EPOCH_STATES)[number];
  openedAt: number;
  seriesId: bigint;
  /** USD per token at open (WAD), as a decimal string. */
  openSpot: string;
  /** Annualised sigma at open, as a fraction. */
  openSigma: number;
}

export async function epochSnapshot(strike: StrikeClient, vault: string): Promise<EpochSnapshot> {
  const [state, openedAt, seriesId, openSpot, openSigma] = await strike.viem.publicClient.readContract({
    address: strike.addresses.epochManager,
    abi: epochManagerAbi,
    functionName: "epochs",
    args: [getAddress(vault)],
  });
  return {
    state: EPOCH_STATES[state] ?? "Idle",
    openedAt: Number(openedAt),
    seriesId,
    openSpot: formatWad(openSpot, 4),
    openSigma: wadToNumber(BigInt(openSigma)),
  };
}

/** The vault's most recent `EpochSettled` event, with the settling transaction, or null. */
export interface LastSettlement {
  seriesId: string;
  settlementPrice: string | null;
  /** In the vault's collateral asset. */
  payout: string;
  premium: string;
  fee: string;
  expiry: number;
  txHash: string;
}

export async function lastSettlement(strike: StrikeClient, vault: string): Promise<LastSettlement | null> {
  const v = await strike.getVault(getAddress(vault) as Address);
  let fromBlock = 0n;
  try {
    const block = (getDeployment(strike.chainId) as unknown as { block?: number }).block;
    if (block) fromBlock = BigInt(block);
  } catch {
    // no deployment record: scan from genesis
  }
  const logs = await strike.viem.publicClient.getContractEvents({
    address: strike.addresses.epochManager,
    abi: epochManagerAbi,
    eventName: "EpochSettled",
    args: { vault: v.address },
    fromBlock,
    toBlock: "latest",
    strict: true,
  });
  const last = logs.at(-1);
  if (!last) return null;
  const { seriesId, settlementPrice, payout, premium, fee } = last.args;
  const series = await strike.getSeries(seriesId);
  const usdgDecimals = await strike.usdgDecimals();
  return {
    seriesId: seriesId.toString(),
    settlementPrice: settlementPrice === 0n ? null : formatWad(settlementPrice, 4),
    payout: `${formatAmount(payout, v.assetDecimals)} ${v.assetSymbol}`,
    premium: formatAmount(premium, usdgDecimals, 6),
    fee: formatAmount(fee, usdgDecimals, 6),
    expiry: Number(series?.expiry ?? 0n),
    txHash: last.transactionHash,
  };
}

/**
 * Exit code of a `--settle` run whose series has expired while the price feed has no round at or after expiry yet
 * (EX_TEMPFAIL, "try again later"): settlement waits for the first mirrored print, at the next NYSE open. Nothing is
 * sent and no decision record is written; scripts/weekly-agent.sh and agent.yml turn it into a notice. A series that
 * has not expired yet is nothing to settle this week: exit 0, also without a record.
 */
export const SETTLE_WAITING_EXIT = 75;

/** What decides whether a Selling vault's series can be settled now (all times in unix seconds). */
export interface SettleInputs {
  now: number;
  expiry: number;
  /** Options sold: a series that sold none settles without a price, at any time after expiry. */
  sold: bigint;
  /** StockOracle already holds the settlement price for (underlying, expiry). */
  priceRecorded: boolean;
  /** `updatedAt` of the feed's latest round, or null when it was not read. */
  latestPriceAt: number | null;
}

/** Why a Selling series cannot settle now: before expiry, or after it with no feed round at or after expiry yet. */
export interface SettleWait {
  kind: "not-expired" | "no-print";
  reason: string;
}

const isoTime = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");

/** Why the series cannot be settled yet, or null when `settle` can run (SafeStockFeed rule 10: first round >= expiry). */
export function settleWaitReason(i: SettleInputs): SettleWait | null {
  if (i.now < i.expiry) {
    const hours = Math.ceil((i.expiry - i.now) / 3600);
    return {
      kind: "not-expired",
      reason: `its series is still selling until expiry at ${isoTime(i.expiry)} (in about ${hours} h); it settles after expiry`,
    };
  }
  if (i.sold === 0n || i.priceRecorded) return null;
  if (i.latestPriceAt !== null && i.latestPriceAt >= i.expiry) return null;
  const latest = i.latestPriceAt === null ? "" : ` (latest round published at ${isoTime(i.latestPriceAt)})`;
  return {
    kind: "no-print",
    reason: `its series expired at ${isoTime(i.expiry)} and the price feed has no round at or after expiry yet${latest}; it settles at the first mirrored print after expiry`,
  };
}

/** Reads `settleWaitReason`'s inputs for the vault's live series; null when it is not Selling or can be settled. */
export async function settleWait(strike: StrikeClient, vault: string): Promise<SettleWait | null> {
  const epoch = await epochSnapshot(strike, vault);
  if (epoch.state !== "Selling") return null;
  const series = await strike.getSeries(epoch.seriesId);
  if (!series) return null;
  const now = Number(await strike.blockTimestamp());
  let priceRecorded = false;
  let latestPriceAt: number | null = null;
  if (now >= Number(series.expiry) && series.sold > 0n) {
    const oracle = { address: strike.addresses.stockOracle, abi: stockOracleAbi } as const;
    const recorded = await strike.viem.publicClient.readContract({
      ...oracle,
      functionName: "settlementPrice",
      args: [series.underlying, series.expiry],
    });
    priceRecorded = recorded !== 0n;
    if (!priceRecorded) {
      const cfg = await strike.viem.publicClient.readContract({
        ...oracle,
        functionName: "feedConfig",
        args: [series.underlying],
      });
      const [, , , updatedAt] = await strike.viem.publicClient.readContract({
        address: cfg.feed,
        abi: mirrorFeedAbi,
        functionName: "latestRoundData",
      });
      latestPriceAt = Number(updatedAt);
    }
  }
  return settleWaitReason({
    now,
    expiry: Number(series.expiry),
    sold: series.sold,
    priceRecorded,
    latestPriceAt,
  });
}
