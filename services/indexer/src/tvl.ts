import { stockOracleAbi, strikeVaultAbi } from "@strike/sdk";
import type pg from "pg";
import type { Logger } from "pino";
import { type Address, type PublicClient, erc20Abi, formatUnits } from "viem";
import type { ChainSpec, DeploymentSpec } from "./config.js";
import type { DecimalsReader } from "./ingest.js";
import { errorMessage, mapLimit } from "./util.js";
import type { Writer } from "./writer.js";

// Value locked: the one /stats figure that is chain state, not a log. Read every few minutes per vault, the way the
// app's vault summary values it (app/src/lib/reads.ts `vaultSummary`): a put vault's USDG at face value, a call
// vault's stock tokens at the StockOracle spot; null when the spot is 0 or a read fails.

const WAD = 10n ** 18n;

export interface VaultValue {
  blockNumber: bigint | null;
  isCall: boolean | null;
  totalAssets: bigint | null;
  assetDecimals: number | null;
  spotPrice: bigint | null;
  tvlUsd: number | null;
  error?: string;
}

export interface StateReader extends DecimalsReader {
  vaultValue(dep: DeploymentSpec, vault: string): Promise<VaultValue>;
}

/** The app's `toNumber`: a base-unit amount as a float. */
const toNumber = (v: bigint, decimals: number) => Number(formatUnits(v, decimals));

/** {@link StateReader} over a viem client. */
export function viemStateReader(client: PublicClient): StateReader {
  const decimalsCache = new Map<string, number>();
  const decimalsOf = async (token: Address) => {
    const key = token.toLowerCase();
    const hit = decimalsCache.get(key);
    if (hit !== undefined) return hit;
    const d = await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    decimalsCache.set(key, d);
    return d;
  };
  return {
    usdgDecimals: (dep) => decimalsOf(dep.usdg as Address),
    async vaultValue(dep, vault) {
      const v = { address: vault as Address, abi: strikeVaultAbi } as const;
      try {
        const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
        const at = { blockNumber } as const;
        const [isCall, asset, underlying, totalAssets] = await Promise.all([
          client.readContract({ ...v, functionName: "isCall", ...at }),
          client.readContract({ ...v, functionName: "asset", ...at }),
          client.readContract({ ...v, functionName: "underlying", ...at }),
          client.readContract({ ...v, functionName: "totalAssets", ...at }),
        ]);
        const assetDecimals = await decimalsOf(asset);
        if (!isCall) {
          return {
            blockNumber,
            isCall,
            totalAssets,
            assetDecimals,
            spotPrice: null,
            tvlUsd: toNumber(totalAssets, assetDecimals),
          };
        }
        // As the app's spotOf: a failed status read is a zero price, and a zero price leaves the vault unvalued.
        const price = await client
          .readContract({
            address: dep.stockOracle as Address,
            abi: stockOracleAbi,
            functionName: "status",
            args: [underlying],
            ...at,
          })
          .then(([, p]) => p)
          .catch(() => 0n);
        return {
          blockNumber,
          isCall,
          totalAssets,
          assetDecimals,
          spotPrice: price,
          tvlUsd: price > 0n ? toNumber((totalAssets * price) / WAD, assetDecimals) : null,
        };
      } catch (err) {
        return {
          blockNumber: null,
          isCall: null,
          totalAssets: null,
          assetDecimals: null,
          spotPrice: null,
          tvlUsd: null,
          error: errorMessage(err).slice(0, 300),
        };
      }
    },
  };
}

/** Read and store the value of every vault of the chain's deployments. Returns the number of vaults read. */
export async function refreshTvl(o: {
  chain: ChainSpec;
  state: StateReader;
  pool: pg.Pool;
  writer: Writer;
  log: Logger;
}): Promise<number> {
  const started = Date.now();
  let n = 0;
  for (const dep of o.chain.deployments) {
    const { rows } = await o.pool.query<{ vault: string }>(
      "SELECT vault FROM v_vaults WHERE deployment_id = $1 ORDER BY created_block, vault",
      [dep.id],
    );
    const values = await mapLimit(rows, 4, (r) => o.state.vaultValue(dep, r.vault));
    await o.writer.tx(async (db) => {
      for (const [i, r] of rows.entries()) {
        const v = values[i]!;
        await db.query(
          `INSERT INTO vault_tvl (chain_id, vault, deployment_id, block_number, is_call, total_assets, asset_decimals,
             spot_price, tvl_usd, error)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
           WHERE EXISTS (SELECT 1 FROM contracts WHERE chain_id = $1 AND address = $2)`,
          [
            o.chain.chainId,
            r.vault,
            dep.id,
            v.blockNumber?.toString() ?? null,
            v.isCall,
            v.totalAssets?.toString() ?? null,
            v.assetDecimals,
            v.spotPrice?.toString() ?? null,
            v.tvlUsd,
            v.error ?? null,
          ],
        );
      }
    });
    n += rows.length;
    const failed = values.filter((v) => v.tvlUsd === null).length;
    if (failed)
      o.log.warn({ chain: o.chain.chainId, deployment: dep.id, failed }, "some vaults could not be valued");
  }
  o.log.info({ chain: o.chain.chainId, vaults: n, durationMs: Date.now() - started }, "vault values read");
  return n;
}
