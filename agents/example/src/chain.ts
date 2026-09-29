import {
  type StrikeClient,
  createStrikeClient,
  epochManagerAbi,
  formatAmount,
  formatWad,
  getDeployment,
  getStrikeChain,
  wadToNumber,
} from "@strike/sdk";
import { type Address, createPublicClient, getAddress, http } from "viem";

// Direct, read-only chain reads the MCP tools do not expose: the epoch's opening snapshot, the NYSE session and the
// last settlement of a vault. Same STRIKE_CHAIN_ID / STRIKE_RPC_URL defaults as the MCP server.

/** A read-only Strike client for STRIKE_CHAIN_ID (default 46630) and STRIKE_RPC_URL (default: the chain's RPC). */
export function readClient(env: NodeJS.ProcessEnv = process.env): StrikeClient {
  const chainId = Number(env.STRIKE_CHAIN_ID ?? 46630);
  const base = getStrikeChain(chainId);
  const rpcUrl = env.STRIKE_RPC_URL || base.rpcUrls.default.http[0];
  if (!rpcUrl) throw new Error(`no RPC URL for chain ${chainId}: set STRIKE_RPC_URL`);
  const chain = { ...base, rpcUrls: { default: { http: [rpcUrl] } } };
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
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
