import {
  agentRegistryAbi,
  epochManagerAbi,
  optionTokenAbi,
  stockOracleAbi,
  strikeVaultAbi,
  testStockTokenAbi,
} from "@strike/sdk";
import { erc20Abi, parseAbi, type Address, type PublicClient } from "viem";
import { fromBlock, type Deployment } from "./deployment";
import { toNumber, usdValue } from "./format";
import { UNIT_MULTIPLIER } from "./shares";

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface Mandate {
  minDeltaBps: number;
  maxDeltaBps: number;
  minPremiumBps: number;
  minYieldBps: number;
  maxShareSoldBps: number;
  minTenor: number;
  maxTenor: number;
}

export interface Series {
  id: bigint;
  vault: Address;
  underlying: Address;
  agentId: bigint;
  expiry: bigint;
  premiumBps: number;
  isCall: boolean;
  settled: boolean;
  cancelled: boolean;
  strike: bigint;
  size: bigint;
  sold: bigint;
  premium: bigint;
  collateral: bigint;
  settlementPrice: bigint;
  payoutPerOption: bigint;
}

export interface Spot {
  status: number;
  price: bigint;
  updatedAt: bigint;
}

export interface VaultSummary {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  isCall: boolean;
  asset: TokenInfo;
  underlying: TokenInfo;
  usdg: TokenInfo;
  totalAssets: bigint;
  totalSupply: bigint;
  depositCap: bigint;
  locked: boolean;
  currentEpoch: bigint;
  lastProcessedEpoch: bigint;
  pendingDepositAssets: bigint;
  pendingRedeemShares: bigint;
  state: number;
  openedAt: bigint;
  series: Series | null;
  agentId: bigint;
  curator: Address;
  mandate: Mandate;
  spot: Spot;
  /** ERC-8056 `uiMultiplier` of the underlying (1e18 = one share per raw token; 1e18 when not implemented). */
  multiplier: bigint;
  /** `EpochManager.underlyings(token)`: annualised volatility (WAD) and the spot buffer buys are priced with. */
  pricing: { sigma: bigint; spotBufferBps: number } | null;
  tvlUsd: number | null;
  sharePrice: number | null;
}

const tokenCache = new Map<string, TokenInfo>();

export async function tokenInfo(client: PublicClient, address: Address): Promise<TokenInfo> {
  const key = `${client.chain?.id}:${address.toLowerCase()}`;
  const hit = tokenCache.get(key);
  if (hit) return hit;
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  const info = { address, symbol, decimals };
  tokenCache.set(key, info);
  return info;
}

export async function vaultAddresses(client: PublicClient, dep: Deployment): Promise<Address[]> {
  const count = await client.readContract({
    address: dep.epochManager,
    abi: epochManagerAbi,
    functionName: "vaultCount",
  });
  return Promise.all(
    Array.from({ length: Number(count) }, (_, i) =>
      client.readContract({
        address: dep.epochManager,
        abi: epochManagerAbi,
        functionName: "allVaults",
        args: [BigInt(i)],
      }),
    ),
  );
}

export async function getSeries(client: PublicClient, dep: Deployment, id: bigint): Promise<Series> {
  const s = await client.readContract({
    address: dep.epochManager,
    abi: epochManagerAbi,
    functionName: "getSeries",
    args: [id],
  });
  return { id, ...s };
}

/** `EpochManager.quoteBuy`: the premium (USDG base units) for `amount` options of a series, at the live spot. */
export async function quotePremium(
  client: PublicClient,
  dep: Deployment,
  seriesId: bigint,
  amount: bigint,
): Promise<bigint> {
  const [premium] = await client.readContract({
    address: dep.epochManager,
    abi: epochManagerAbi,
    functionName: "quoteBuy",
    args: [seriesId, amount],
  });
  return premium;
}

export async function spotOf(client: PublicClient, dep: Deployment, token: Address): Promise<Spot> {
  try {
    const [status, price, updatedAt] = await client.readContract({
      address: dep.stockOracle,
      abi: stockOracleAbi,
      functionName: "status",
      args: [token],
    });
    return { status, price, updatedAt };
  } catch {
    return { status: 1, price: 0n, updatedAt: 0n };
  }
}

const uiMultiplierAbi = parseAbi(["function uiMultiplier() view returns (uint256)"]);

/** The token's ERC-8056 UI multiplier, or 1.0 when it does not implement one (plain ERC-20s, some test tokens). */
export async function uiMultiplierOf(client: PublicClient, token: Address): Promise<bigint> {
  try {
    const m = await client.readContract({
      address: token,
      abi: uiMultiplierAbi,
      functionName: "uiMultiplier",
    });
    return m > 0n ? m : UNIT_MULTIPLIER;
  } catch {
    return UNIT_MULTIPLIER;
  }
}

/** Thrown when an address is not a vault registered with this network's EpochManager. */
export class NotAVaultError extends Error {
  readonly address: Address;
  constructor(address: Address) {
    super("There is no Strike vault at this address on this network.");
    this.name = "NotAVaultError";
    this.address = address;
  }
}

/** Sigma and spot buffer the EpochManager prices buys of `token` with (null if the read fails). */
export async function underlyingPricing(
  client: PublicClient,
  dep: Deployment,
  token: Address,
): Promise<{ sigma: bigint; spotBufferBps: number } | null> {
  try {
    const u = await client.readContract({
      address: dep.epochManager,
      abi: epochManagerAbi,
      functionName: "underlyings",
      args: [token],
    });
    return { sigma: u[2], spotBufferBps: u[5] };
  } catch {
    return null;
  }
}

export async function vaultSummary(
  client: PublicClient,
  dep: Deployment,
  vault: Address,
): Promise<VaultSummary> {
  const v = { address: vault, abi: strikeVaultAbi } as const;
  const [
    name,
    symbol,
    decimals,
    isCall,
    assetAddr,
    underlyingAddr,
    totalAssets,
    totalSupply,
    depositCap,
    locked,
    currentEpoch,
    lastProcessedEpoch,
    pendingDepositAssets,
    pendingRedeemShares,
    epoch,
    config,
  ] = await Promise.all([
    client.readContract({ ...v, functionName: "name" }),
    client.readContract({ ...v, functionName: "symbol" }),
    client.readContract({ ...v, functionName: "decimals" }),
    client.readContract({ ...v, functionName: "isCall" }),
    client.readContract({ ...v, functionName: "asset" }),
    client.readContract({ ...v, functionName: "underlying" }),
    client.readContract({ ...v, functionName: "totalAssets" }),
    client.readContract({ ...v, functionName: "totalSupply" }),
    client.readContract({ ...v, functionName: "depositCap" }),
    client.readContract({ ...v, functionName: "locked" }),
    client.readContract({ ...v, functionName: "currentEpoch" }),
    client.readContract({ ...v, functionName: "lastProcessedEpoch" }),
    client.readContract({ ...v, functionName: "pendingDepositAssets" }),
    client.readContract({ ...v, functionName: "pendingRedeemShares" }),
    client.readContract({
      address: dep.epochManager,
      abi: epochManagerAbi,
      functionName: "epochs",
      args: [vault],
    }),
    client.readContract({
      address: dep.epochManager,
      abi: epochManagerAbi,
      functionName: "vaultConfig",
      args: [vault],
    }),
  ]).catch(async (err: unknown) => {
    // A mistyped or foreign address fails on the first vault read; say so instead of showing the RPC error.
    const cfg = await client
      .readContract({
        address: dep.epochManager,
        abi: epochManagerAbi,
        functionName: "vaultConfig",
        args: [vault],
      })
      .catch(() => null);
    if (!cfg?.registered) throw new NotAVaultError(vault);
    throw err;
  });
  const [state, openedAt, seriesId] = epoch;
  const [asset, underlying, usdg, spot, series, multiplier, pricing] = await Promise.all([
    tokenInfo(client, assetAddr),
    tokenInfo(client, underlyingAddr),
    tokenInfo(client, dep.usdg),
    spotOf(client, dep, underlyingAddr),
    seriesId === 0n ? Promise.resolve(null) : getSeries(client, dep, seriesId),
    uiMultiplierOf(client, underlyingAddr),
    underlyingPricing(client, dep, underlyingAddr),
  ]);

  const assetsUsd = isCall
    ? spot.price > 0n
      ? usdValue(totalAssets, asset.decimals, spot.price)
      : null
    : toNumber(totalAssets, asset.decimals);
  const sharePrice =
    totalSupply > 0n ? toNumber(totalAssets, asset.decimals) / toNumber(totalSupply, decimals) : null;

  return {
    address: vault,
    name,
    symbol,
    decimals,
    isCall,
    asset,
    underlying,
    usdg,
    totalAssets,
    totalSupply,
    depositCap,
    locked,
    currentEpoch,
    lastProcessedEpoch,
    pendingDepositAssets,
    pendingRedeemShares,
    state,
    openedAt,
    series,
    agentId: config.agentId,
    curator: config.curator,
    mandate: config.mandate,
    spot,
    multiplier,
    pricing,
    tvlUsd: assetsUsd,
    sharePrice,
  };
}

export async function marketStatus(client: PublicClient, dep: Deployment) {
  const [open, saleCutoff, block] = await Promise.all([
    client.readContract({ address: dep.stockOracle, abi: stockOracleAbi, functionName: "isMarketOpen" }),
    client.readContract({ address: dep.epochManager, abi: epochManagerAbi, functionName: "saleCutoff" }),
    client.getBlock(),
  ]);
  return { open, saleCutoff: Number(saleCutoff), now: Number(block.timestamp) };
}

// ------------------------------------------------------------------ history (events)

export interface EpochEvents {
  epoch: bigint;
  openedAt?: number;
  spotAtOpen?: bigint;
  proposedAt?: number;
  seriesId?: bigint;
  strike?: bigint;
  expiry?: bigint;
  delta?: bigint;
  settledAt?: number;
  abortedAt?: number;
  settlementPrice?: bigint;
  payout?: bigint;
  premium?: bigint;
  fee?: bigint;
  assetsAfter?: bigint;
  rejections: number;
}

export interface VaultHistory {
  epochs: EpochEvents[];
  seriesIds: bigint[];
  apy: number | null;
  premiumPaid: bigint;
}

async function blockTimes(client: PublicClient, numbers: (bigint | null)[]): Promise<Map<bigint, number>> {
  const unique = [...new Set(numbers.filter((n): n is bigint => n !== null))];
  const blocks = await Promise.all(unique.map((blockNumber) => client.getBlock({ blockNumber })));
  return new Map(blocks.map((b) => [b.number, Number(b.timestamp)]));
}

export async function vaultHistory(
  client: PublicClient,
  dep: Deployment,
  vault: VaultSummary,
): Promise<VaultHistory> {
  const base = { address: dep.epochManager, abi: epochManagerAbi, fromBlock: fromBlock(dep) } as const;
  const args = { vault: vault.address };
  const [opened, proposed, settled, rejected, aborted, vaultSettled] = await Promise.all([
    client.getContractEvents({ ...base, eventName: "EpochOpened", args }),
    client.getContractEvents({ ...base, eventName: "SeriesProposed", args }),
    client.getContractEvents({ ...base, eventName: "EpochSettled", args }),
    client.getContractEvents({ ...base, eventName: "ProposalRejected", args }),
    client.getContractEvents({ ...base, eventName: "EpochAborted", args }),
    client.getContractEvents({
      address: vault.address,
      abi: strikeVaultAbi,
      eventName: "EpochSettled",
      fromBlock: fromBlock(dep),
    }),
  ]);
  const times = await blockTimes(
    client,
    [...opened, ...proposed, ...settled, ...aborted].map((l) => l.blockNumber),
  );
  const byEpoch = new Map<bigint, EpochEvents>();
  const at = (epoch: bigint) => {
    let e = byEpoch.get(epoch);
    if (!e) {
      e = { epoch, rejections: 0 };
      byEpoch.set(epoch, e);
    }
    return e;
  };
  const ts = (n: bigint | null) => (n === null ? undefined : times.get(n));

  for (const l of opened) {
    const e = at(l.args.epoch!);
    e.openedAt = ts(l.blockNumber);
    e.spotAtOpen = l.args.spot;
  }
  for (const l of proposed) {
    const e = at(l.args.epoch!);
    e.proposedAt = ts(l.blockNumber);
    e.seriesId = l.args.seriesId;
    e.strike = l.args.strike;
    e.expiry = BigInt(l.args.expiry ?? 0);
    e.delta = l.args.delta;
  }
  for (const l of settled) {
    const e = at(l.args.epoch!);
    e.settledAt = ts(l.blockNumber);
    e.settlementPrice = l.args.settlementPrice;
    e.payout = l.args.payout;
    e.premium = l.args.premium;
    e.fee = l.args.fee;
  }
  for (const l of aborted) at(l.args.epoch!).abortedAt = ts(l.blockNumber);
  for (const l of rejected) at(l.args.epoch!).rejections += 1;
  for (const l of vaultSettled) {
    const e = byEpoch.get(l.args.epoch!);
    if (e) e.assetsAfter = l.args.assets;
  }

  const epochs = [...byEpoch.values()].sort((a, b) => Number(a.epoch - b.epoch));
  const seriesIds = proposed.map((l) => l.args.seriesId!).filter((id) => id !== undefined);
  const premiumPaid = epochs.reduce((sum, e) => sum + (e.premium ?? 0n) - (e.fee ?? 0n), 0n);
  return { epochs, seriesIds, apy: trailingApy(epochs, vault), premiumPaid };
}

/**
 * Trailing premium APY: premium paid to the vault (after the performance fee) over the value of the assets that
 * backed it, averaged over the last four settled epochs and annualised (simple, 52.14 weeks). Null with no history.
 */
export function trailingApy(epochs: EpochEvents[], vault: VaultSummary): number | null {
  const done = epochs.filter((e) => e.settledAt !== undefined && e.assetsAfter !== undefined).slice(-4);
  if (done.length === 0) return null;
  const yields: number[] = [];
  for (const e of done) {
    const net = toNumber((e.premium ?? 0n) - (e.fee ?? 0n), vault.usdg.decimals);
    const backing = (e.assetsAfter ?? 0n) + (e.payout ?? 0n);
    const price = e.settlementPrice || e.spotAtOpen || 0n;
    const value = vault.isCall
      ? price > 0n
        ? usdValue(backing, vault.asset.decimals, price)
        : 0
      : toNumber(backing, vault.asset.decimals);
    if (value > 0) yields.push(net / value);
    else if (net === 0) yields.push(0);
  }
  if (yields.length === 0) return null;
  const weekly = yields.reduce((a, b) => a + b, 0) / yields.length;
  return weekly * (365 / 7);
}

// ------------------------------------------------------------------ account

export interface Position {
  shares: bigint;
  assets: bigint;
  pendingPremium: bigint;
  claimableDepositShares: bigint;
  claimableRedeemAssets: bigint;
  depositRequest: { epoch: bigint; amount: bigint };
  redeemRequest: { epoch: bigint; amount: bigint };
  assetBalance: bigint;
  assetAllowance: bigint;
  usdgBalance: bigint;
  usdgAllowance: bigint;
  maxWithdraw: bigint;
  maxDeposit: bigint;
}

export async function position(
  client: PublicClient,
  dep: Deployment,
  vault: VaultSummary,
  account: Address,
): Promise<Position> {
  const v = { address: vault.address, abi: strikeVaultAbi } as const;
  const [
    shares,
    pendingPremium,
    claimableDepositShares,
    claimableRedeemAssets,
    dr,
    rr,
    maxWithdraw,
    maxDeposit,
    assetBalance,
    assetAllowance,
    usdgBalance,
    usdgAllowance,
  ] = await Promise.all([
    client.readContract({ ...v, functionName: "balanceOf", args: [account] }),
    client.readContract({ ...v, functionName: "pendingPremium", args: [account] }),
    client.readContract({ ...v, functionName: "claimableDepositShares", args: [account] }),
    client.readContract({ ...v, functionName: "claimableRedeemAssets", args: [account] }),
    client.readContract({ ...v, functionName: "depositRequests", args: [account] }),
    client.readContract({ ...v, functionName: "redeemRequests", args: [account] }),
    client.readContract({ ...v, functionName: "maxWithdraw", args: [account] }),
    client.readContract({ ...v, functionName: "maxDeposit", args: [account] }),
    client.readContract({
      address: vault.asset.address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    }),
    client.readContract({
      address: vault.asset.address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, vault.address],
    }),
    client.readContract({ address: dep.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    client.readContract({
      address: dep.usdg,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, dep.epochManager],
    }),
  ]);
  const assets =
    shares === 0n ? 0n : await client.readContract({ ...v, functionName: "convertToAssets", args: [shares] });
  return {
    shares,
    assets,
    pendingPremium,
    claimableDepositShares,
    claimableRedeemAssets,
    depositRequest: { epoch: BigInt(dr[0]), amount: dr[1] },
    redeemRequest: { epoch: BigInt(rr[0]), amount: rr[1] },
    assetBalance,
    assetAllowance,
    usdgBalance,
    usdgAllowance,
    maxWithdraw,
    maxDeposit,
  };
}

export interface OptionHolding {
  series: Series;
  balance: bigint;
}

export async function optionHoldings(
  client: PublicClient,
  dep: Deployment,
  seriesIds: bigint[],
  account: Address,
): Promise<OptionHolding[]> {
  if (seriesIds.length === 0) return [];
  const balances = await client.readContract({
    address: dep.optionToken,
    abi: optionTokenAbi,
    functionName: "balanceOfBatch",
    args: [seriesIds.map(() => account), seriesIds],
  });
  const held = seriesIds.map((id, i) => ({ id, balance: balances[i] ?? 0n })).filter((h) => h.balance > 0n);
  const series = await Promise.all(held.map((h) => getSeries(client, dep, h.id)));
  return held.map((h, i) => ({ series: series[i]!, balance: h.balance }));
}

// ------------------------------------------------------------------ agents

export interface AgentRow {
  id: bigint;
  owner: Address;
  signer: Address;
  payout: Address;
  status: number;
  strikes: number;
  accepted: number;
  rejected: number;
  erc8004Id: bigint;
  bond: bigint;
  unbonding: bigint;
  /** `AgentRegistry.track`: epochs settled under this agent. */
  settledEpochs: number;
  /** `AgentRegistry.track`: cumulative depositor PnL of those epochs, USDG base units (6 decimals). */
  cumulativePnl: bigint;
  vaults: Address[];
  /** `tokenURI` of the agent's ERC-8004 identity: its registration file (null when unlinked or unreadable). */
  registrationUri: string | null;
  /** `ReputationFeedback` events the registry posted for this agent (null when the logs could not be read). */
  feedbackPosted: number | null;
}

export interface Registry {
  agents: AgentRow[];
  minBond: bigint;
  slashAmount: bigint;
  maxStrikes: number;
  usdg: TokenInfo;
  /** ERC-8004 Identity and Reputation registries the AgentRegistry links to (null when disabled or unreadable). */
  identityRegistry: Address | null;
  reputationRegistry: Address | null;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const tokenUriAbi = parseAbi(["function tokenURI(uint256) view returns (string)"]);

async function optionalAddress(read: Promise<Address>): Promise<Address | null> {
  try {
    const a = await read;
    return a.toLowerCase() === ZERO ? null : a;
  } catch {
    return null;
  }
}

export async function registry(client: PublicClient, dep: Deployment): Promise<Registry> {
  const r = { address: dep.agentRegistry, abi: agentRegistryAbi } as const;
  const [count, minBond, slashAmount, maxStrikes, usdg, vaults, identityRegistry, reputationRegistry] =
    await Promise.all([
      client.readContract({ ...r, functionName: "agentCount" }),
      client.readContract({ ...r, functionName: "minBond" }),
      client.readContract({ ...r, functionName: "slashAmount" }),
      client.readContract({ ...r, functionName: "maxStrikes" }),
      tokenInfo(client, dep.usdg),
      vaultAddresses(client, dep),
      optionalAddress(client.readContract({ ...r, functionName: "identityRegistry" })),
      optionalAddress(client.readContract({ ...r, functionName: "reputationRegistry" })),
    ]);
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const [agents, tracks, configs] = await Promise.all([
    Promise.all(ids.map((id) => client.readContract({ ...r, functionName: "getAgent", args: [id] }))),
    Promise.all(ids.map((id) => client.readContract({ ...r, functionName: "track", args: [id] }))),
    Promise.all(
      vaults.map((vault) =>
        client.readContract({
          address: dep.epochManager,
          abi: epochManagerAbi,
          functionName: "vaultConfig",
          args: [vault],
        }),
      ),
    ),
  ]);
  const [feedback, uris] = await Promise.all([
    client
      .getContractEvents({ ...r, eventName: "ReputationFeedback", fromBlock: fromBlock(dep) })
      .then((logs) => logs.filter((l) => l.args.posted))
      .catch(() => null),
    Promise.all(
      agents.map((a) =>
        identityRegistry && a.erc8004Id > 0n
          ? client
              .readContract({
                address: identityRegistry,
                abi: tokenUriAbi,
                functionName: "tokenURI",
                args: [a.erc8004Id],
              })
              .then((u) => u || null)
              .catch(() => null)
          : Promise.resolve(null),
      ),
    ),
  ]);
  return {
    agents: agents.map((a, i) => {
      const [settledEpochs, cumulativePnl] = tracks[i]!;
      return {
        id: ids[i]!,
        ...a,
        settledEpochs,
        cumulativePnl,
        vaults: vaults.filter((_, j) => configs[j]?.agentId === ids[i]),
        registrationUri: uris[i] ?? null,
        feedbackPosted: feedback ? feedback.filter((l) => l.args.agentId === ids[i]).length : null,
      };
    }),
    minBond,
    slashAmount,
    maxStrikes,
    usdg,
    identityRegistry,
    reputationRegistry,
  };
}

export interface Rejection {
  key: string;
  vault: Address;
  epoch: bigint;
  agentId: bigint;
  reason: number;
  slashed: bigint;
  strike: bigint;
  expiry: bigint;
  size: bigint;
  premiumBps: number;
  time?: number;
  tx: `0x${string}`;
}

export async function rejections(client: PublicClient, dep: Deployment): Promise<Rejection[]> {
  const logs = await client.getContractEvents({
    address: dep.epochManager,
    abi: epochManagerAbi,
    eventName: "ProposalRejected",
    fromBlock: fromBlock(dep),
  });
  const times = await blockTimes(
    client,
    logs.map((l) => l.blockNumber),
  );
  return logs
    .map((l) => ({
      key: `${l.transactionHash}-${l.logIndex}`,
      vault: l.args.vault!,
      epoch: l.args.epoch!,
      agentId: l.args.agentId!,
      reason: Number(l.args.reason ?? 0),
      slashed: l.args.slashed ?? 0n,
      strike: l.args.strike ?? 0n,
      expiry: BigInt(l.args.expiry ?? 0),
      size: l.args.size ?? 0n,
      premiumBps: Number(l.args.premiumBps ?? 0),
      time: l.blockNumber === null ? undefined : times.get(l.blockNumber),
      tx: l.transactionHash!,
    }))
    .reverse();
}

// ------------------------------------------------------------------ faucet

export interface FaucetToken {
  symbol: string;
  token: Address;
  decimals: number;
  isTestToken: boolean;
  amount: bigint;
  cooldown: number;
  balance: bigint;
  nextAt: number;
}

export async function faucetTokens(
  client: PublicClient,
  dep: Deployment,
  account: Address | undefined,
): Promise<FaucetToken[]> {
  const now = Number((await client.getBlock()).timestamp);
  return Promise.all(
    Object.entries(dep.stocks).map(async ([symbol, { token }]) => {
      const info = await tokenInfo(client, token);
      const balance = account
        ? await client.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
          })
        : 0n;
      try {
        const t = { address: token, abi: testStockTokenAbi } as const;
        const [amount, cooldown, last] = await Promise.all([
          client.readContract({ ...t, functionName: "FAUCET_AMOUNT" }),
          client.readContract({ ...t, functionName: "FAUCET_COOLDOWN" }),
          account ? client.readContract({ ...t, functionName: "lastFaucet", args: [account] }) : 0n,
        ]);
        const nextAt = last === 0n ? 0 : Number(last + cooldown);
        return {
          symbol,
          token,
          decimals: info.decimals,
          isTestToken: true,
          amount,
          cooldown: Number(cooldown),
          balance,
          nextAt: nextAt > now ? nextAt : 0,
        };
      } catch {
        return {
          symbol,
          token,
          decimals: info.decimals,
          isTestToken: false,
          amount: 0n,
          cooldown: 0,
          balance,
          nextAt: 0,
        };
      }
    }),
  );
}

export interface WalletBalances {
  /** Native gas token, 18 decimals. */
  gas: bigint;
  usdg: TokenInfo & { balance: bigint };
  /** Every stock token in the deployment (with the in-app faucet's terms where the token has one). */
  stocks: FaucetToken[];
}

/** What `account` holds of everything the app needs: gas, USDG and the deployment's stock tokens. */
export async function walletBalances(
  client: PublicClient,
  dep: Deployment,
  account: Address,
): Promise<WalletBalances> {
  const [gas, usdg, usdgBalance, stocks] = await Promise.all([
    client.getBalance({ address: account }),
    tokenInfo(client, dep.usdg),
    client.readContract({ address: dep.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    faucetTokens(client, dep, account),
  ]);
  return { gas, usdg: { ...usdg, balance: usdgBalance }, stocks };
}
