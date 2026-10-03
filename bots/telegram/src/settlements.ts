import { type StrikeClient, type VaultState, epochManagerAbi } from "@strike/sdk";
import type { Address, PublicClient } from "viem";

/** The last series a vault settled: what `/vaults` shows for a vault that is between epochs. */
export interface Settlement {
  epoch: bigint;
  isCall: boolean;
  strike: bigint;
  expiry: bigint;
  /** WAD USD price the series settled at; 0 when no options were sold. */
  settlementPrice: bigint;
  /** In the vault's collateral token (asset base units); 0 for an out-of-the-money series. */
  payout: bigint;
}

export type SettlementLookup = (vault: VaultState) => Promise<Settlement | null>;

/**
 * Looks up the `EpochSettled` log of the vault's last processed epoch (`vault` and `epoch` are indexed, so one
 * `getLogs` call over the deployment's history is enough on these chains) and joins it with the series. The answer
 * never changes for a given epoch, so it is cached; a vault whose last epoch ended without a settlement
 * (aborted) or was never processed gives null.
 */
export function settlementLookup(
  client: Pick<StrikeClient, "getSeries">,
  publicClient: Pick<PublicClient, "getContractEvents">,
  epochManager: Address,
  fromBlock: bigint,
): SettlementLookup {
  const cache = new Map<string, Settlement | null>();
  return async (v) => {
    if (v.lastProcessedEpoch === 0n) return null;
    const key = `${v.address}:${v.lastProcessedEpoch}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const logs = await publicClient.getContractEvents({
      address: epochManager,
      abi: epochManagerAbi,
      eventName: "EpochSettled",
      args: { vault: v.address, epoch: v.lastProcessedEpoch },
      fromBlock,
      toBlock: "latest",
      strict: true,
    });
    const log = logs.at(-1);
    let found: Settlement | null = null;
    if (log) {
      const series = await client.getSeries(log.args.seriesId);
      if (series) {
        found = {
          epoch: log.args.epoch,
          isCall: series.isCall,
          strike: series.strike,
          expiry: series.expiry,
          settlementPrice: log.args.settlementPrice,
          payout: log.args.payout,
        };
      }
    }
    // A missing log may just be an RPC that has not indexed it yet: remember only what was found.
    if (found) cache.set(key, found);
    return found;
  };
}
