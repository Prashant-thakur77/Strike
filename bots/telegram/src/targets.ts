import {
  type StrikeClient,
  type StrikeDeployment,
  createStrikeClient,
  deploymentsFor,
  loadStrikeConfig,
} from "@strike/sdk";
import type { Address, PublicClient } from "viem";
import type { BotConfig } from "./config.js";
import { publicClientFor } from "./config.js";
import { type SettlementLookup, settlementLookup } from "./settlements.js";
import { type WalletSource, optionSeriesScanner } from "./wallet.js";

/** The Strike reads the commands use (a subset of `StrikeClient`, so tests can fake it). */
export type StrikeReader = Pick<
  StrikeClient,
  | "chainId"
  | "listVaults"
  | "quoteBuy"
  | "agentStats"
  | "oracleStatus"
  | "marketOpen"
  | "saleCutoff"
  | "blockTimestamp"
> & { viem: { publicClient: Pick<StrikeClient["viem"]["publicClient"], "getBlock"> } };

/**
 * One Strike deployment the bot reads: a chain plus a protocol version ("Robinhood Chain testnet · v3"). The
 * commands and the alerts both work on a list of these.
 */
export interface CommandTarget {
  /** `<chainId>:<EpochManager, lower case>`: what the per-deployment alert cursor is stored under. */
  key: string;
  chainId: number;
  /** strike.config.json's display name ("Robinhood Chain testnet"). */
  chainName: string;
  /** strike.config.json's short name ("RH testnet"). */
  shortName: string;
  /** The deployment's protocol version ("v2", "v3"), or null when its record has none. */
  version: string | null;
  /** "Robinhood Chain testnet · v3". */
  label: string;
  /** The AgentRegistry: agent ids are per registry. */
  registry: string;
  usdgDecimals: number;
  /** The first deployment of the primary chain: its cursor is the state file's legacy `cursor`. */
  primary?: boolean;
  strike: StrikeReader;
  /** The vault's last settled series (price, payout), when the epoch it last processed settled. */
  lastSettlement?: SettlementLookup;
  /** Per-wallet reads for /watch and /status <address>. */
  wallet?: WalletSource;
}

/** What the alert loop needs of a deployment, on top of {@link CommandTarget}. */
export interface BotTarget extends CommandTarget {
  primary: boolean;
  deployment: StrikeDeployment | undefined;
  epochManager: Address;
  explorerUrl: string;
  /** Where event scans start (the deployment's block). */
  startBlock: bigint;
  client: StrikeClient;
  publicClient: PublicClient;
}

export const targetKey = (chainId: number, epochManager: string) =>
  `${chainId}:${epochManager.toLowerCase()}`;

export const labelOf = (chainName: string, version: string | null) =>
  version ? `${chainName} · ${version}` : chainName;

/** "v3", "V3" or "3" as "v3"; null for anything else. */
export function normalizeVersion(raw: string): string | null {
  const m = /^v?(\d+)$/i.exec(raw.trim());
  return m ? `v${Number(m[1])}` : null;
}

/**
 * A read client for each deployment of each configured chain (the SDK's `deploymentsFor`, default deployment
 * first), sharing one public client per chain. A chain without a deployment record gets the SDK's default client,
 * which throws the usual "missing address" error.
 */
export async function openTargets(config: BotConfig): Promise<BotTarget[]> {
  const names = loadStrikeConfig().chains;
  const targets: BotTarget[] = [];
  for (const setting of config.chains) {
    const publicClient = publicClientFor(setting);
    const cfg = names[String(setting.chainId)];
    const chainName = cfg?.name ?? `chain ${setting.chainId}`;
    const found = deploymentsFor(setting.chainId);
    const records: (StrikeDeployment | undefined)[] = found.length ? found : [undefined];
    for (const [i, deployment] of records.entries()) {
      const client = createStrikeClient({ publicClient, chainId: setting.chainId, deployment });
      const version = deployment?.version ?? null;
      const em = client.addresses.epochManager;
      const startBlock = BigInt(deployment?.block ?? 0);
      targets.push({
        key: targetKey(setting.chainId, em),
        chainId: setting.chainId,
        chainName,
        shortName: cfg?.shortName ?? chainName,
        version,
        label: labelOf(chainName, version),
        registry: client.addresses.agentRegistry,
        usdgDecimals: await client.usdgDecimals(),
        strike: client,
        lastSettlement: settlementLookup(client, publicClient, em, startBlock),
        wallet: {
          reader: client,
          heldSeries: optionSeriesScanner(
            publicClient,
            em,
            client.addresses.optionToken,
            startBlock,
            config.logBlockRange,
          ),
        },
        primary: setting.chainId === config.chainId && i === 0,
        deployment,
        epochManager: em,
        explorerUrl: setting.explorerUrl,
        startBlock,
        client,
        publicClient,
      });
    }
  }
  return targets;
}

/** Which deployments a command's arguments pick. Empty lists mean "all". */
export interface TargetFilter {
  chainIds: number[];
  versions: string[];
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Read chain and version arguments: "v3" (or "V3") is a version; a number is a chain id; text is matched against
 * the chains' names ("arbitrum", "robinhood", "RH testnet"). Returns an error message for anything else.
 */
export function parseFilter(tokens: string[], targets: readonly CommandTarget[]): TargetFilter | string {
  const filter: TargetFilter = { chainIds: [], versions: [] };
  const chains = [...new Map(targets.map((t) => [t.chainId, t])).values()];
  for (const token of tokens) {
    if (/^v\d+$/i.test(token)) {
      const v = normalizeVersion(token)!;
      if (!targets.some((t) => t.version === v)) {
        const have = [...new Set(targets.map((t) => t.version).filter(Boolean))].join(", ");
        return `No ${v} deployment. Versions: ${have || "none"}.`;
      }
      filter.versions.push(v);
    } else if (/^\d+$/.test(token)) {
      if (!chains.some((c) => c.chainId === Number(token)))
        return `No Strike deployment on chain ${token}. ${chainList(chains)}`;
      filter.chainIds.push(Number(token));
    } else {
      const want = compact(token);
      const hits =
        want.length < 2
          ? []
          : chains.filter(
              (c) => compact(c.chainName).startsWith(want) || compact(c.shortName).startsWith(want),
            );
      if (hits.length === 0)
        return `"${token}" is not a chain id, a chain name or a version. ${chainList(chains)}`;
      filter.chainIds.push(...hits.map((c) => c.chainId));
    }
  }
  return filter;
}

function chainList(chains: readonly CommandTarget[]): string {
  return `Chains: ${chains.map((c) => `${c.chainId} (${c.chainName})`).join(", ")}.`;
}

/** The targets a filter picks (all of them for an empty filter). */
export function applyFilter(targets: readonly CommandTarget[], f: TargetFilter): CommandTarget[] {
  return targets.filter(
    (t) =>
      (f.chainIds.length === 0 || f.chainIds.includes(t.chainId)) &&
      (f.versions.length === 0 || (t.version !== null && f.versions.includes(t.version))),
  );
}

export { chainList };
