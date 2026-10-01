import { isTeamWallet } from "./team";

// Testnet usage counted from contract logs. This module is pure (no RPC, no SDK import) so the counting rules can be
// unit-tested on fixture logs: src/lib/usage/scan.ts fetches and decodes the logs, /api/stats serves the result.

/** Which contract of a deployment emitted the log. */
export type UsageSource = "epochManager" | "vaultFactory" | "agentRegistry" | "decisionLog" | "vault";

/** One decoded log (viem `decodeEventLog` arguments), tagged with the contract it came from. */
export interface UsageLog {
  source: UsageSource;
  /** Emitting contract. */
  address: string;
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: string;
  blockNumber: bigint;
  logIndex: number;
}

export interface UsageContracts {
  epochManager: string;
  vaultFactory: string;
  agentRegistry: string;
  decisionLog?: string;
}

/** Everything the counter needs about one deployment: its identity, its logs and its value locked right now. */
export interface DeploymentInput {
  chainId: number;
  chainName: string;
  /** Short chain name for table headers ("RH testnet"). */
  chainShort: string;
  version: string;
  /** Block explorer base URL, e.g. https://explorer.testnet.chain.robinhood.com */
  explorer: string;
  contracts: UsageContracts;
  fromBlock: bigint;
  toBlock: bigint;
  /** USDG decimals on this chain (6 on both testnets). */
  usdgDecimals: number;
  logs: UsageLog[];
  /** Sum of the vaults' `totalAssets` in USD (stock collateral at the oracle spot); null when it could not be read. */
  tvlUsd: number | null;
}

/** What a wallet did, for the "outside the team" list. */
export type WalletRole = "depositor" | "buyer" | "agent" | "bond" | "curator";

/** The counted figures; the same shape per deployment and for the total. */
export interface UsageCounts {
  /** Distinct wallets that deposited, bought, registered or signed for an agent, posted a bond or created a vault. */
  wallets: number;
  /** Of those, the ones not in TEAM_WALLETS (src/lib/usage/team.ts). */
  outsideWallets: number;
  vaults: number;
  epochsOpened: number;
  epochsSettled: number;
  epochsAborted: number;
  /** Proposals the contract accepted (`SeriesProposed`). */
  proposalsAccepted: number;
  /** Proposals the contract rejected (`ProposalRejected`). */
  proposalsRejected: number;
  /** `OptionsBought` events. */
  buys: number;
  /** Options bought (stock-token units, 18 decimals). */
  optionsBought: number;
  /** Premium paid by buyers, USDG. */
  premiumUsdg: number;
  /** Bond slashed by rejected proposals and sent to the vault's depositors, USDG. */
  slashedUsdg: number;
  /** Instant ERC-4626 deposits (`Deposit`). */
  deposits: number;
  /** Deposits queued while a vault was locked (`DepositRequested`). */
  queuedDeposits: number;
  /** `Withdraw` plus queued redemptions (`RedeemRequested`). */
  withdrawals: number;
  /** Distinct agent ids registered in the deployment's AgentRegistry. */
  agentsRegistered: number;
  /** `BondPosted` events and their USDG. */
  bondsPosted: number;
  bondedUsdg: number;
  /** Decision records anchored in the DecisionLog (`DecisionRecorded`). */
  decisionRecords: number;
  /** USD value in the vaults now; null when unknown. */
  tvlUsd: number | null;
}

export interface DeploymentUsage extends UsageCounts {
  /** `${chainId}-${version}` */
  key: string;
  chainId: number;
  chainName: string;
  chainShort: string;
  version: string;
  explorer: string;
  contracts: UsageContracts;
  fromBlock: number;
  toBlock: number;
}

export interface OutsideWallet {
  address: string;
  chains: number[];
  roles: WalletRole[];
}

export interface UsageStats {
  /** ISO time the logs were read. */
  generatedAt: string;
  deployments: DeploymentUsage[];
  /** Sums across deployments; `wallets` and `outsideWallets` count each address once across chains. */
  total: UsageCounts;
  /** Wallets outside the team, oldest activity first. */
  outside: OutsideWallet[];
  /** Deployments whose read failed (the rest are still counted). */
  errors: { key: string; message: string }[];
}

const ZERO = "0x0000000000000000000000000000000000000000";

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : typeof v === "number" ? BigInt(v) : 0n);
const addr = (v: unknown): string | null =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;

/** A base-unit amount as a JS number (exact to the unit for the testnet magnitudes involved). */
export function units(value: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

const OPTION_DECIMALS = 18;

interface Tally {
  counts: Omit<UsageCounts, "wallets" | "outsideWallets" | "tvlUsd">;
  premium: bigint;
  slashed: bigint;
  bonded: bigint;
  options: bigint;
  /** address -> roles, in first-seen order */
  wallets: Map<string, Set<WalletRole>>;
}

/** Wallet addresses and their roles in one log (the zero address is never a wallet). */
export function walletsOf(log: UsageLog): [string, WalletRole][] {
  const a = log.args;
  const out: [unknown, WalletRole][] = [];
  switch (`${log.source}:${log.eventName}`) {
    case "agentRegistry:AgentRegistered":
      out.push([a.owner, "agent"], [a.signer, "agent"]);
      break;
    case "agentRegistry:SignerSet":
      out.push([a.signer, "agent"]);
      break;
    case "agentRegistry:BondPosted":
      out.push([a.from, "bond"]);
      break;
    case "epochManager:OptionsBought":
      out.push([a.buyer, "buyer"], [a.recipient, "buyer"]);
      break;
    case "epochManager:OptionsRedeemed":
      out.push([a.holder, "buyer"]);
      break;
    case "vaultFactory:VaultCreated":
      out.push([a.curator, "curator"]);
      break;
    case "vault:Deposit":
      out.push([a.sender, "depositor"], [a.owner, "depositor"]);
      break;
    case "vault:DepositRequested":
      out.push([a.account, "depositor"]);
      break;
    case "vault:Withdraw":
      out.push([a.owner, "depositor"]);
      break;
    case "vault:RedeemRequested":
      out.push([a.account, "depositor"]);
      break;
  }
  return out.flatMap(([v, role]) => {
    const w = addr(v);
    return w && w !== ZERO ? [[w, role] as [string, WalletRole]] : [];
  });
}

const byChainOrder = (a: UsageLog, b: UsageLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

function tally(input: DeploymentInput): Tally {
  const t: Tally = {
    counts: {
      vaults: 0,
      epochsOpened: 0,
      epochsSettled: 0,
      epochsAborted: 0,
      proposalsAccepted: 0,
      proposalsRejected: 0,
      buys: 0,
      optionsBought: 0,
      premiumUsdg: 0,
      slashedUsdg: 0,
      deposits: 0,
      queuedDeposits: 0,
      withdrawals: 0,
      agentsRegistered: 0,
      bondsPosted: 0,
      bondedUsdg: 0,
      decisionRecords: 0,
    },
    premium: 0n,
    slashed: 0n,
    bonded: 0n,
    options: 0n,
    wallets: new Map(),
  };
  const c = t.counts;
  const vaults = new Set<string>();
  const agentIds = new Set<bigint>();
  // Contracts are never counted as wallets (a vault can be the `owner` of a deposit routed through it, say).
  const contracts = new Set(
    Object.values(input.contracts)
      .map(addr)
      .filter((x): x is string => x !== null),
  );
  const seen = new Set<string>();
  const logs = [...input.logs].sort(byChainOrder);
  for (const log of logs) {
    const id = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const a = log.args;
    switch (`${log.source}:${log.eventName}`) {
      case "vaultFactory:VaultCreated":
      case "epochManager:VaultRegistered": {
        const v = addr(a.vault);
        if (v) {
          vaults.add(v);
          contracts.add(v);
        }
        break;
      }
      case "epochManager:EpochOpened":
        c.epochsOpened += 1;
        break;
      case "epochManager:EpochSettled":
        c.epochsSettled += 1;
        break;
      case "epochManager:EpochAborted":
        c.epochsAborted += 1;
        break;
      case "epochManager:SeriesProposed":
        c.proposalsAccepted += 1;
        break;
      case "epochManager:ProposalRejected":
        c.proposalsRejected += 1;
        t.slashed += big(a.slashed);
        break;
      case "epochManager:OptionsBought":
        c.buys += 1;
        t.options += big(a.amount);
        t.premium += big(a.premium);
        break;
      case "vault:Deposit":
        c.deposits += 1;
        break;
      case "vault:DepositRequested":
        c.queuedDeposits += 1;
        break;
      case "vault:Withdraw":
      case "vault:RedeemRequested":
        c.withdrawals += 1;
        break;
      case "agentRegistry:AgentRegistered":
        // Linking an ERC-8004 identity emits AgentRegistered again for the same id: count ids, not events.
        agentIds.add(big(a.agentId));
        break;
      case "agentRegistry:BondPosted":
        c.bondsPosted += 1;
        t.bonded += big(a.amount);
        break;
      case "decisionLog:DecisionRecorded":
        c.decisionRecords += 1;
        break;
    }
    for (const [w, role] of walletsOf(log)) {
      if (contracts.has(w)) continue;
      let roles = t.wallets.get(w);
      if (!roles) t.wallets.set(w, (roles = new Set()));
      roles.add(role);
    }
  }
  // A vault is a contract even where it appears before its VaultCreated log.
  for (const v of vaults) t.wallets.delete(v);
  c.vaults = vaults.size;
  c.agentsRegistered = agentIds.size;
  c.premiumUsdg = units(t.premium, input.usdgDecimals);
  c.slashedUsdg = units(t.slashed, input.usdgDecimals);
  c.bondedUsdg = units(t.bonded, input.usdgDecimals);
  c.optionsBought = units(t.options, OPTION_DECIMALS);
  return t;
}

const outsideCount = (wallets: Iterable<string>) => [...wallets].filter((w) => !isTeamWallet(w)).length;

/** The counts of one deployment. */
export function aggregateDeployment(input: DeploymentInput): DeploymentUsage {
  return usageOf(input, tally(input));
}

function usageOf(input: DeploymentInput, t: Tally): DeploymentUsage {
  return {
    key: `${input.chainId}-${input.version}`,
    chainId: input.chainId,
    chainName: input.chainName,
    chainShort: input.chainShort,
    version: input.version,
    explorer: input.explorer,
    contracts: input.contracts,
    fromBlock: Number(input.fromBlock),
    toBlock: Number(input.toBlock),
    ...t.counts,
    wallets: t.wallets.size,
    outsideWallets: outsideCount(t.wallets.keys()),
    tvlUsd: input.tvlUsd,
  };
}

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

/** Round away float noise from summing decimal amounts (USDG has 6 decimals, options 18). */
const tidy = (x: number) => Math.round(x * 1e9) / 1e9;

/**
 * Per-deployment counts, their total and the list of outside wallets. Wallets are counted once across chains (the
 * same key on two chains is one wallet); every other figure is a plain sum.
 */
export function aggregateUsage(
  inputs: DeploymentInput[],
  opts: { generatedAt?: Date; errors?: { key: string; message: string }[] } = {},
): UsageStats {
  const deployments: DeploymentUsage[] = [];
  const all = new Map<string, { chains: Set<number>; roles: Set<WalletRole> }>();
  for (const input of inputs) {
    const t = tally(input);
    deployments.push(usageOf(input, t));
    for (const [w, roles] of t.wallets) {
      let e = all.get(w);
      if (!e) all.set(w, (e = { chains: new Set(), roles: new Set() }));
      e.chains.add(input.chainId);
      for (const r of roles) e.roles.add(r);
    }
  }
  const total = Object.fromEntries(
    SUMMED.map((k) => [k, tidy(deployments.reduce((s, d) => s + d[k], 0))]),
  ) as Record<(typeof SUMMED)[number], number>;
  const tvls = deployments.map((d) => d.tvlUsd).filter((x): x is number => x !== null);
  const outside = [...all.entries()]
    .filter(([w]) => !isTeamWallet(w))
    .map(([address, e]) => ({ address, chains: [...e.chains].sort((a, b) => a - b), roles: [...e.roles] }));
  return {
    generatedAt: (opts.generatedAt ?? new Date()).toISOString(),
    deployments,
    total: {
      ...total,
      wallets: all.size,
      outsideWallets: outside.length,
      tvlUsd: tvls.length ? tidy(tvls.reduce((s, x) => s + x, 0)) : null,
    },
    outside,
    errors: opts.errors ?? [],
  };
}

/* ------------------------------------------------------------------ display helpers (shared by strip and table) */

/** "1,204" */
export const fmtCount = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** USDG to the cent without a trailing ".00": "10", "35.39", "1,250.5" -> "1,250.50". */
export function fmtUsdg(n: number): string {
  const cents = Math.round(n * 100);
  const s = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return s.endsWith(".00") ? s.slice(0, -3) : s;
}

/** Options to 4 decimals without trailing zeros: "16", "0.5". */
export const fmtOptions = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });

/** "$1,931" (whole dollars) or "–" when unknown. */
export const fmtUsd = (n: number | null) =>
  n === null ? "–" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** "just now", "1 min ago", "14 min ago", "2 h ago" */
export function agoText(iso: string, now: number = Date.now()): string {
  const mins = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h} h ago`;
}

/** The deployment's label in tables: "Robinhood Chain testnet · v2". */
export const deploymentLabel = (d: Pick<DeploymentUsage, "chainName" | "version">) =>
  `${d.chainName} · ${d.version}`;
