import type pg from "pg";
import { TEAM_WALLETS } from "./meta.js";

// GET /stats: the app's /api/stats answer (app/src/lib/usage/aggregate.ts `UsageStats`), computed with SQL over
// the indexed events instead of a log scan per request. Every count follows the app's rules; test/stats.test.ts
// runs the app's own `aggregateUsage` on the same fixture logs and compares the two answers field by field.

export type WalletRole = "depositor" | "buyer" | "agent" | "bond" | "curator";

export interface UsageCounts {
  wallets: number;
  outsideWallets: number;
  vaults: number;
  epochsOpened: number;
  epochsSettled: number;
  epochsAborted: number;
  proposalsAccepted: number;
  proposalsRejected: number;
  buys: number;
  optionsBought: number;
  premiumUsdg: number;
  slashedUsdg: number;
  deposits: number;
  queuedDeposits: number;
  withdrawals: number;
  agentsRegistered: number;
  bondsPosted: number;
  bondedUsdg: number;
  decisionRecords: number;
  tvlUsd: number | null;
}

export interface DeploymentUsage extends UsageCounts {
  key: string;
  chainId: number;
  chainName: string;
  chainShort: string;
  version: string;
  explorer: string;
  contracts: { epochManager: string; vaultFactory: string; agentRegistry: string; decisionLog?: string };
  fromBlock: number;
  toBlock: number;
}

export interface UsageStats {
  generatedAt: string;
  deployments: DeploymentUsage[];
  total: UsageCounts;
  outside: { address: string; chains: number[]; roles: WalletRole[] }[];
  errors: { key: string; message: string }[];
  /** Not in the app's answer: where these numbers come from and how fresh they are. */
  indexer: {
    source: "indexer";
    deployments: {
      key: string;
      lastIndexedBlock: number;
      headBlock: number | null;
      lagBlocks: number | null;
    }[];
  };
}

/** The app's `units`: a base-unit amount as a JS number. */
export function units(value: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

/** The app's `tidy`: round away float noise from summing decimal amounts. */
const tidy = (x: number) => Math.round(x * 1e9) / 1e9;

const OPTION_DECIMALS = 18;

const SUMMED = [
  "vaults",
  "epochsOpened",
  "epochsSettled",
  "epochsAborted",
  "proposalsAccepted",
  "proposalsRejected",
  "buys",
  "optionsBought",
  "premiumUsdg",
  "slashedUsdg",
  "deposits",
  "queuedDeposits",
  "withdrawals",
  "agentsRegistered",
  "bondsPosted",
  "bondedUsdg",
  "decisionRecords",
] as const satisfies readonly (keyof UsageCounts)[];

const COUNTS_SQL = `
SELECT
  d.id, d.chain_id, d.version, d.deploy_block, d.usdg_decimals, d.epoch_manager, d.vault_factory, d.agent_registry,
  d.decision_log, c.name AS chain_name, c.short_name, c.explorer,
  cu.last_indexed_block, cu.updated_at AS indexed_at, h.head_block,
  count(DISTINCT e.args ->> 'vault') FILTER (WHERE (e.source = 'vaultFactory' AND e.event_name = 'VaultCreated')
    OR (e.source = 'epochManager' AND e.event_name = 'VaultRegistered')) AS vaults,
  count(*) FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'EpochOpened') AS epochs_opened,
  count(*) FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'EpochSettled') AS epochs_settled,
  count(*) FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'EpochAborted') AS epochs_aborted,
  count(*) FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'SeriesProposed') AS proposals_accepted,
  count(*) FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'ProposalRejected') AS proposals_rejected,
  coalesce(sum((e.args ->> 'slashed')::numeric)
    FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'ProposalRejected'), 0)::text AS slashed,
  count(*) FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'OptionsBought') AS buys,
  coalesce(sum((e.args ->> 'amount')::numeric)
    FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'OptionsBought'), 0)::text AS options,
  coalesce(sum((e.args ->> 'premium')::numeric)
    FILTER (WHERE e.source = 'epochManager' AND e.event_name = 'OptionsBought'), 0)::text AS premium,
  count(*) FILTER (WHERE e.source = 'vault' AND e.event_name = 'Deposit') AS deposits,
  count(*) FILTER (WHERE e.source = 'vault' AND e.event_name = 'DepositRequested') AS queued_deposits,
  count(*) FILTER (WHERE e.source = 'vault' AND e.event_name IN ('Withdraw', 'RedeemRequested')) AS withdrawals,
  count(DISTINCT e.args ->> 'agentId')
    FILTER (WHERE e.source = 'agentRegistry' AND e.event_name = 'AgentRegistered') AS agents,
  count(*) FILTER (WHERE e.source = 'agentRegistry' AND e.event_name = 'BondPosted') AS bonds,
  coalesce(sum((e.args ->> 'amount')::numeric)
    FILTER (WHERE e.source = 'agentRegistry' AND e.event_name = 'BondPosted'), 0)::text AS bonded,
  count(*) FILTER (WHERE e.source = 'decisionLog' AND e.event_name = 'DecisionRecorded') AS decision_records
FROM deployments d
JOIN chains c ON c.chain_id = d.chain_id
JOIN cursors cu ON cu.deployment_id = d.id
LEFT JOIN chain_heads h ON h.chain_id = d.chain_id
LEFT JOIN events e ON e.deployment_id = d.id AND e.event_name IS NOT NULL
WHERE ($1::int[] IS NULL OR d.chain_id = ANY($1::int[]))
GROUP BY d.id, c.chain_id, cu.deployment_id, h.chain_id
ORDER BY d.chain_id, d.ordinal`;

// Wallets per deployment in first-seen order, with their roles in first-seen order (the app's Map and Set order:
// logs in chain order, and within a log the order `walletsOf` lists them, kept in v_wallet_roles.ord).
const WALLETS_SQL = `
WITH firsts AS (
  SELECT DISTINCT ON (deployment_id, address, role) deployment_id, address, role, block_number, log_index, ord
  FROM v_wallet_roles
  WHERE ($1::int[] IS NULL OR chain_id = ANY($1::int[]))
  ORDER BY deployment_id, address, role, block_number, log_index, ord
)
SELECT deployment_id, address, array_agg(role ORDER BY block_number, log_index, ord) AS roles
FROM firsts
GROUP BY deployment_id, address
ORDER BY deployment_id, min(ARRAY[block_number::bigint, log_index::bigint, ord::bigint])`;

// The latest value of every vault of a deployment; null when any vault has none or could not be valued.
const TVL_SQL = `
SELECT v.deployment_id, v.vault, t.tvl_usd, t.read_at
FROM v_vaults v
LEFT JOIN LATERAL (
  SELECT tvl_usd, read_at FROM vault_tvl x
  WHERE x.chain_id = v.chain_id AND x.vault = v.vault ORDER BY read_at DESC LIMIT 1
) t ON true
WHERE ($1::int[] IS NULL OR v.chain_id = ANY($1::int[]))
ORDER BY v.deployment_id, v.created_block, v.vault`;

const num = (v: unknown) => Number(v ?? 0);
const isTeam = (() => {
  const team = new Set(TEAM_WALLETS);
  return (a: string) => team.has(a.toLowerCase());
})();

/** The usage answer, optionally for some chains only. */
export async function readStats(
  pool: pg.Pool,
  opts: { chains?: number[]; now?: Date } = {},
): Promise<UsageStats> {
  const chains = opts.chains?.length ? opts.chains : null;
  const [counts, wallets, tvl] = await Promise.all([
    pool.query(COUNTS_SQL, [chains]),
    pool.query(WALLETS_SQL, [chains]),
    pool.query(TVL_SQL, [chains]),
  ]);

  const walletsByDep = new Map<string, { address: string; roles: WalletRole[] }[]>();
  for (const r of wallets.rows) {
    const list = walletsByDep.get(r.deployment_id) ?? [];
    list.push({ address: r.address, roles: [...new Set(r.roles as WalletRole[])] });
    walletsByDep.set(r.deployment_id, list);
  }
  const tvlByDep = new Map<string, (number | null)[]>();
  for (const r of tvl.rows) {
    const list = tvlByDep.get(r.deployment_id) ?? [];
    list.push(r.tvl_usd === null || r.tvl_usd === undefined ? null : Number(r.tvl_usd));
    tvlByDep.set(r.deployment_id, list);
  }

  const deployments: DeploymentUsage[] = [];
  const errors: { key: string; message: string }[] = [];
  const all = new Map<string, { chains: Set<number>; roles: Set<WalletRole> }>();
  const freshness: UsageStats["indexer"]["deployments"] = [];
  let oldest: Date | null = null;

  for (const r of counts.rows) {
    const key: string = r.id;
    const lastIndexed = num(r.last_indexed_block);
    const head = r.head_block === null || r.head_block === undefined ? null : num(r.head_block);
    freshness.push({
      key,
      lastIndexedBlock: lastIndexed,
      headBlock: head,
      lagBlocks: head === null ? null : Math.max(0, head - lastIndexed),
    });
    if (lastIndexed < num(r.deploy_block)) {
      errors.push({ key, message: "not indexed yet" });
      continue;
    }
    if (r.usdg_decimals === null || r.usdg_decimals === undefined) {
      errors.push({ key, message: "USDG decimals not read yet" });
      continue;
    }
    const indexedAt = new Date(r.indexed_at);
    if (!oldest || indexedAt < oldest) oldest = indexedAt;
    const dec = Number(r.usdg_decimals);
    const depWallets = walletsByDep.get(key) ?? [];
    for (const w of depWallets) {
      let e = all.get(w.address);
      if (!e) all.set(w.address, (e = { chains: new Set(), roles: new Set() }));
      e.chains.add(Number(r.chain_id));
      for (const role of w.roles) e.roles.add(role);
    }
    const tvls = tvlByDep.get(key) ?? [];
    deployments.push({
      key,
      chainId: Number(r.chain_id),
      chainName: r.chain_name,
      chainShort: r.short_name,
      version: r.version,
      explorer: r.explorer,
      contracts: {
        epochManager: r.epoch_manager,
        vaultFactory: r.vault_factory,
        agentRegistry: r.agent_registry,
        ...(r.decision_log ? { decisionLog: r.decision_log } : {}),
      },
      fromBlock: num(r.deploy_block),
      toBlock: lastIndexed,
      vaults: num(r.vaults),
      epochsOpened: num(r.epochs_opened),
      epochsSettled: num(r.epochs_settled),
      epochsAborted: num(r.epochs_aborted),
      proposalsAccepted: num(r.proposals_accepted),
      proposalsRejected: num(r.proposals_rejected),
      buys: num(r.buys),
      optionsBought: units(BigInt(r.options), OPTION_DECIMALS),
      premiumUsdg: units(BigInt(r.premium), dec),
      slashedUsdg: units(BigInt(r.slashed), dec),
      deposits: num(r.deposits),
      queuedDeposits: num(r.queued_deposits),
      withdrawals: num(r.withdrawals),
      agentsRegistered: num(r.agents),
      bondsPosted: num(r.bonds),
      bondedUsdg: units(BigInt(r.bonded), dec),
      decisionRecords: num(r.decision_records),
      wallets: depWallets.length,
      outsideWallets: depWallets.filter((w) => !isTeam(w.address)).length,
      tvlUsd: tvls.some((x) => x === null) ? null : tvls.reduce<number>((s, x) => s + (x ?? 0), 0),
    });
  }

  const total = Object.fromEntries(
    SUMMED.map((k) => [k, tidy(deployments.reduce((s, d) => s + d[k], 0))]),
  ) as Record<(typeof SUMMED)[number], number>;
  const tvls = deployments.map((d) => d.tvlUsd).filter((x): x is number => x !== null);
  const outside = [...all.entries()]
    .filter(([w]) => !isTeam(w))
    .map(([address, e]) => ({ address, chains: [...e.chains].sort((a, b) => a - b), roles: [...e.roles] }));
  return {
    generatedAt: (opts.now ?? oldest ?? new Date()).toISOString(),
    deployments,
    total: {
      ...total,
      wallets: all.size,
      outsideWallets: outside.length,
      tvlUsd: tvls.length ? tidy(tvls.reduce((s, x) => s + x, 0)) : null,
    },
    outside,
    errors,
    indexer: { source: "indexer", deployments: freshness },
  };
}
