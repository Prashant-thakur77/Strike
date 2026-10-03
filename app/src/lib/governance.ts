// The governance page (/app/governance): who holds each privileged role on every Strike contract, what each role can
// and cannot do, the last admin and role events, and the staged path for the admin keys. This file is pure data and
// logic: the role list per contract, the role texts (copied from docs/audit-readiness.md and docs/trust-model.md, or
// from the contract when the docs do not cover a role), the label book of known holders, the holder set rebuilt from
// RoleGranted/RoleRevoked logs, the JSON /api/governance serves and its cache. src/lib/governanceRead.ts does the
// reads. No SDK import, so the Playwright specs load it as it is (e2e/units.spec.ts, e2e/governance.spec.ts).

import strikeConfig from "../../../strike.config.json";
import rhV2 from "../../../contracts/deployments/46630.json";
import rhV3 from "../../../contracts/deployments/46630-v3.json";
import arbV3 from "../../../contracts/deployments/421614.json";
import { TEAM_WALLETS } from "./usage/team";

const REPO = strikeConfig.services.repository;

/** A file in the repository on GitHub (main), with an optional `#anchor` or `#L<n>` kept as is. */
export const repoUrl = (path: string) => `${REPO}/blob/main/${path}`;

// ------------------------------------------------------------------ deployments

/** The fields of a contracts/deployments/*.json record this page reads. */
export interface GovDeploymentRecord {
  chainId: number;
  version?: string;
  block?: number;
  deployer?: string;
  epochManager: string;
  stockOracle: string;
  agentRegistry: string;
  feeManager: string;
  marketCalendar: string;
  optionToken: string;
  vaultFactory: string;
  pricer?: string;
  stylusPricer?: string;
  decisionLog?: string;
  usdgDrip?: string;
  gasDrip?: string;
  gasDripRelayer?: string;
  riskLens?: string;
  stocks: Record<string, { token: string; feed: string }>;
  agent?: { agentId: number; signer: string; owner?: string };
}

/** The three live deployments, in the order the page shows them. Their files are strike.config.json's `deployments`
 *  for 46630 and 421614 (a test keeps the two lists equal). */
export const GOV_DEPLOYMENTS: readonly { file: string; record: GovDeploymentRecord }[] = [
  { file: "contracts/deployments/46630.json", record: rhV2 as GovDeploymentRecord },
  { file: "contracts/deployments/46630-v3.json", record: rhV3 as GovDeploymentRecord },
  { file: "contracts/deployments/421614.json", record: arbV3 as GovDeploymentRecord },
];

/** The chains /api/governance reads. */
export const GOV_CHAINS = [46630, 421614] as const;
export type GovChainId = (typeof GOV_CHAINS)[number];

export const GOV_CHAIN_NAMES: Record<GovChainId, string> = {
  46630: strikeConfig.chains["46630"].name,
  421614: strikeConfig.chains["421614"].name,
};

export const GOV_EXPLORERS: Record<GovChainId, string> = {
  46630: strikeConfig.chains["46630"].explorer,
  421614: strikeConfig.chains["421614"].explorer,
};

export function isGovChain(id: unknown): id is GovChainId {
  return GOV_CHAINS.includes(id as GovChainId);
}

/** `?chain=` as a chain id, or an error message for a 400. Default 46630. */
export function parseGovChain(param: string | null): { chainId: GovChainId } | { error: string } {
  if (param === null || param === "") return { chainId: 46630 };
  const id = /^\d+$/.test(param) ? Number(param) : NaN;
  if (!isGovChain(id)) {
    return {
      error: `chain must be ${GOV_CHAINS.join(" or ")}: the chains with a Strike deployment (got "${param}")`,
    };
  }
  return { chainId: id };
}

/** The deployments on a chain, oldest first. */
export const govDeploymentsOn = (chainId: number) =>
  GOV_DEPLOYMENTS.filter((d) => d.record.chainId === chainId).map((d) => d.record);

/** "46630-v2": a stable key for a deployment. */
export const deploymentKeyOf = (d: GovDeploymentRecord) => `${d.chainId}-${d.version ?? "v?"}`;

// ------------------------------------------------------------------ roles

export const ROLE_HASH = {
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",
  GUARDIAN_ROLE: "0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041",
  KEEPER_ROLE: "0xfc8737ab85eb45125971625a9ebdb75cc78e01d5c1fa80c4c6e5203f47bc4fab",
  FACTORY_ROLE: "0xdfbefbf47cfe66b701d8cfdbce1de81c821590819cb07e71cb01b6602fb0ee27",
  SLASHER_ROLE: "0x12b42e8a160f6064dc959c6f251e3af0750ad213dbecf573b4710d67d6c28e39",
  DEPOSITOR_ROLE: "0x8f4f2da22e8ac8f11e15f9fc141cddbb5deea8800186560abb6e68c5496619a9",
  CALENDAR_ROLE: "0xa7beeccc2f83e5590af78a024189bc684a462d590dfc72713bba72c1e1ffb057",
} as const;

export type AccessRole = keyof typeof ROLE_HASH;
/** An AccessControl role, `owner` for an Ownable contract, or `relayer` for GasDrip's `isRelayer` list. */
export type RoleName = AccessRole | "owner" | "relayer";

const ROLE_BY_HASH = new Map(Object.entries(ROLE_HASH).map(([name, hash]) => [hash, name as AccessRole]));

/** A role's name from its hash, or the hash shortened when the role is not one Strike's contracts define. */
export function roleName(hash: string): string {
  const name = ROLE_BY_HASH.get(hash.toLowerCase() as (typeof ROLE_HASH)[AccessRole]);
  return name ?? `role ${hash.slice(0, 10)}…`;
}

export type ContractKind =
  | "EpochManager"
  | "StockOracle"
  | "AgentRegistry"
  | "FeeManager"
  | "MarketCalendar"
  | "OptionToken"
  | "VaultFactory"
  | "MirrorFeed"
  | "TestStockToken"
  | "UsdgDrip"
  | "GasDrip";

/** Every privileged role each contract defines (contracts/src). */
export const KIND_ROLES: Record<ContractKind, readonly RoleName[]> = {
  EpochManager: ["DEFAULT_ADMIN_ROLE", "GUARDIAN_ROLE", "KEEPER_ROLE", "FACTORY_ROLE"],
  StockOracle: ["DEFAULT_ADMIN_ROLE"],
  AgentRegistry: ["DEFAULT_ADMIN_ROLE", "SLASHER_ROLE"],
  FeeManager: ["DEFAULT_ADMIN_ROLE", "DEPOSITOR_ROLE"],
  MarketCalendar: ["DEFAULT_ADMIN_ROLE", "CALENDAR_ROLE"],
  OptionToken: ["DEFAULT_ADMIN_ROLE"],
  VaultFactory: ["DEFAULT_ADMIN_ROLE"],
  MirrorFeed: ["DEFAULT_ADMIN_ROLE", "KEEPER_ROLE"],
  TestStockToken: ["DEFAULT_ADMIN_ROLE"],
  UsdgDrip: ["owner"],
  GasDrip: ["owner", "relayer"],
};

export const KIND_SOURCE: Record<ContractKind, string> = {
  EpochManager: "contracts/src/core/EpochManager.sol",
  StockOracle: "contracts/src/oracle/StockOracle.sol",
  AgentRegistry: "contracts/src/agents/AgentRegistry.sol",
  FeeManager: "contracts/src/core/FeeManager.sol",
  MarketCalendar: "contracts/src/oracle/MarketCalendar.sol",
  OptionToken: "contracts/src/tokens/OptionToken.sol",
  VaultFactory: "contracts/src/vaults/VaultFactory.sol",
  MirrorFeed: "contracts/src/testnet/MirrorFeed.sol",
  TestStockToken: "contracts/src/testnet/TestStockToken.sol",
  UsdgDrip: "contracts/src/testnet/UsdgDrip.sol",
  GasDrip: "contracts/src/testnet/GasDrip.sol",
};

export interface RoleInfo {
  /** What the role can do. */
  can: string;
  /** What it cannot do; null when the source says nothing more. */
  cannot: string | null;
  /** Where the text comes from: a repository path, with an anchor. */
  source: string;
}

const ROLES_DOC = "docs/audit-readiness.md#roles-and-trust";
const STAGE2_DOC = "docs/trust-model.md#stage-2-later-renounce-what-is-no-longer-needed";
const ADMIN_LIMIT =
  "Change a vault's mandate, set sigma outside the bounds it set, or change a settlement price once it is recorded. It has no function that moves user funds.";
const GRANTS = "Every DEFAULT_ADMIN_ROLE also grants and revokes the other roles of its contract.";

/** What each role can and cannot do, per contract. */
export const ROLE_INFO: Record<ContractKind, Partial<Record<RoleName, RoleInfo>>> = {
  EpochManager: {
    DEFAULT_ADMIN_ROLE: {
      can: `Set the oracle (setOracle), the pricer (setPricer), the spot buffer (at most 200 bps), volatility bounds, the fee manager and timings (bounded); list tokens. ${GRANTS}`,
      cannot: `${ADMIN_LIMIT} Before a settlement price is recorded it can choose it by swapping the oracle (setOracle), and it sets sale prices through setPricer: "cannot move user funds" holds only for an honest admin.`,
      source: ROLES_DOC,
    },
    GUARDIAN_ROLE: {
      can: "Pause new epochs, proposals and buys; cancel a series only after expiry + settlementGrace with no settlement price recorded.",
      cannot: "Block settlement or idle withdrawals; take funds.",
      source: ROLES_DOC,
    },
    KEEPER_ROLE: {
      can: "Update sigma within bounds (at most 25% per update, once an hour); open epochs.",
      cannot: "Anything else.",
      source: ROLES_DOC,
    },
    FACTORY_ROLE: { can: "Register new vaults.", cannot: null, source: ROLES_DOC },
  },
  StockOracle: {
    DEFAULT_ADMIN_ROLE: {
      can: `List tokens and feeds (setFeed); set the calendar and the sequencer feed. ${GRANTS}`,
      cannot: `${ADMIN_LIMIT} Before a settlement price is recorded it can choose it by pointing the token at another feed (setFeed). Once a settlement price is recorded it is final.`,
      source: ROLES_DOC,
    },
  },
  AgentRegistry: {
    DEFAULT_ADMIN_ROLE: {
      can: `Ban an agent (setStatus), set the ERC-8004 registries and the registry parameters. ${GRANTS}`,
      cannot: ADMIN_LIMIT,
      source: STAGE2_DOC,
    },
    SLASHER_ROLE: { can: "Slash bonds, record results.", cannot: null, source: ROLES_DOC },
  },
  FeeManager: {
    DEFAULT_ADMIN_ROLE: {
      can: `Change fees (capped at 30%) and redirect the treasury (setFees, setTreasury). ${GRANTS}`,
      cannot: ADMIN_LIMIT,
      source: STAGE2_DOC,
    },
    DEPOSITOR_ROLE: {
      can: "Credit performance fees to an agent and the treasury (creditFees).",
      cannot: null,
      source: KIND_SOURCE.FeeManager,
    },
  },
  MarketCalendar: {
    DEFAULT_ADMIN_ROLE: {
      can: `Grant and revoke CALENDAR_ROLE. ${GRANTS}`,
      cannot: ADMIN_LIMIT,
      source: KIND_SOURCE.MarketCalendar,
    },
    CALENDAR_ROLE: {
      can: "Mark NYSE holidays and early closes (setHolidays, setEarlyCloses).",
      cannot: null,
      source: KIND_SOURCE.MarketCalendar,
    },
  },
  OptionToken: {
    DEFAULT_ADMIN_ROLE: {
      can: "Rewire which contract mints and burns options (setManager); set the metadata URI (setURI).",
      cannot: null,
      source: STAGE2_DOC,
    },
  },
  VaultFactory: {
    DEFAULT_ADMIN_ROLE: {
      can: "Raise the ceiling on deposit caps (setMaxDepositCap).",
      cannot: "Change a vault's mandate: it is fixed when the vault is created.",
      source: STAGE2_DOC,
    },
  },
  MirrorFeed: {
    DEFAULT_ADMIN_ROLE: {
      can: "Grant and revoke KEEPER_ROLE on the feed (testnet only).",
      cannot: null,
      source: KIND_SOURCE.MirrorFeed,
    },
    KEEPER_ROLE: {
      can: "Push MirrorFeed rounds (testnet only). Every value is checked against the mainnet Chainlink round it copies by the price mirror audit; when it pushes is trusted.",
      cannot: "Anything else.",
      source: "docs/trust-model.md#the-table",
    },
  },
  TestStockToken: {
    DEFAULT_ADMIN_ROLE: {
      can: "Mint test stock tokens, pause the token or its oracle flag, and schedule a multiplier change (mint, setPaused, scheduleMultiplier). Test tokens on Arbitrum Sepolia only.",
      cannot: null,
      source: KIND_SOURCE.TestStockToken,
    },
  },
  UsdgDrip: {
    owner: {
      can: "Refill and sweep the test-USDG faucet (refill, sweep).",
      cannot: null,
      source: KIND_SOURCE.UsdgDrip,
    },
  },
  GasDrip: {
    owner: {
      can: "Allow or remove relayers and sweep the drip's ETH (setRelayer, sweep).",
      cannot: "Raise the amount per drip or the daily cap: both are fixed at deployment (amount, dailyCap).",
      source: KIND_SOURCE.GasDrip,
    },
    relayer: {
      can: "Send drip(to): 0.0001 test ETH to a new wallet. Held by the app's /api/gas-drip relayer key (D48).",
      cannot:
        "Drip an address twice, drip to one holding 0.0001 ETH or more, or send more than 20 drips in a UTC day: the contract refuses each (AlreadyDripped, HasGas, DailyCapReached).",
      source: "docs/decisions.md",
    },
  },
};

/** The role text for a contract kind; a role the contract does not define gets a plain notice. */
export function roleInfo(kind: ContractKind, role: string): RoleInfo {
  return (
    ROLE_INFO[kind][role as RoleName] ?? {
      can: "Not a role this contract's source defines.",
      cannot: null,
      source: KIND_SOURCE[kind],
    }
  );
}

// ------------------------------------------------------------------ contracts

export interface GovContract {
  /** "EpochManager", "TSLA MirrorFeed". */
  name: string;
  kind: ContractKind;
  address: string;
  /** Read only when it answers supportsInterface(IAccessControl): stock tokens, which are ours only where they are
   *  TestStockTokens (Arbitrum Sepolia); Robinhood's tokens on 46630 are not. */
  probe?: boolean;
}

/** Contracts of a deployment that keep no privileged role, said on the page so nobody looks for one. */
export function roleFreeContracts(d: GovDeploymentRecord): { name: string; address: string; why: string }[] {
  const out: { name: string; address: string; why: string }[] = [];
  if (d.decisionLog)
    out.push({
      name: "DecisionLog",
      address: d.decisionLog,
      why: "only an agent's current signer may record",
    });
  if (d.pricer)
    out.push({ name: "Pricer (Solidity reference)", address: d.pricer, why: "pure math, no admin" });
  if (d.stylusPricer)
    out.push({ name: "Stylus pricer", address: d.stylusPricer, why: "pure math, no admin (Rust source)" });
  return out;
}

/** Every contract of a deployment that has a privileged role, in the order the page lists them. */
export function deploymentContracts(d: GovDeploymentRecord): GovContract[] {
  const out: GovContract[] = [
    { name: "EpochManager", kind: "EpochManager", address: d.epochManager },
    { name: "StockOracle", kind: "StockOracle", address: d.stockOracle },
    { name: "AgentRegistry", kind: "AgentRegistry", address: d.agentRegistry },
    { name: "FeeManager", kind: "FeeManager", address: d.feeManager },
    { name: "MarketCalendar", kind: "MarketCalendar", address: d.marketCalendar },
    { name: "OptionToken", kind: "OptionToken", address: d.optionToken },
    { name: "VaultFactory", kind: "VaultFactory", address: d.vaultFactory },
  ];
  for (const [symbol, s] of Object.entries(d.stocks).sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ name: `${symbol} MirrorFeed`, kind: "MirrorFeed", address: s.feed });
  }
  for (const [symbol, s] of Object.entries(d.stocks).sort(([a], [b]) => a.localeCompare(b))) {
    out.push({ name: `${symbol} TestStockToken`, kind: "TestStockToken", address: s.token, probe: true });
  }
  if (d.usdgDrip) out.push({ name: "UsdgDrip", kind: "UsdgDrip", address: d.usdgDrip });
  if (d.gasDrip) out.push({ name: "GasDrip", kind: "GasDrip", address: d.gasDrip });
  return out;
}

/** The other deployments on the same chain that list the same address (46630 v3 reuses v2's calendar and feeds). */
export function sharedWith(d: GovDeploymentRecord, address: string): string[] {
  const a = address.toLowerCase();
  return govDeploymentsOn(d.chainId)
    .filter((o) => o !== d && deploymentContracts(o).some((c) => c.address.toLowerCase() === a))
    .map((o) => o.version ?? "v?");
}

// ------------------------------------------------------------------ holder labels

/** The CI keeper key: KEEPER_ROLE on the mirrored MirrorFeeds and nothing else (docs/DEPLOYMENTS.md#ci-keeper-key). */
export const CI_KEEPER_ADDRESS = "0x317a604e853af6C124a0C871783FAd2d797AfF76";

export type HolderKind = "deployer" | "keeper" | "agent" | "team" | "contract" | "unknown";

export interface HolderLabel {
  label: string;
  kind: HolderKind;
}

export const UNKNOWN_HOLDER: HolderLabel = { label: "Unknown holder", kind: "unknown" };

/**
 * Every address the team can name, for a chain: the deployer, the CI keeper key, agent signers, the team's other
 * wallets (src/lib/usage/team.ts) and each deployment's contracts ("EpochManager v2"). Keys are lowercase.
 */
export function labelBook(chainId: number): Map<string, HolderLabel> {
  const book = new Map<string, HolderLabel>();
  const put = (address: string | undefined, l: HolderLabel) => {
    if (address && !book.has(address.toLowerCase())) book.set(address.toLowerCase(), l);
  };
  const deps = govDeploymentsOn(chainId);
  for (const d of deps) put(d.deployer, { label: "Deployer", kind: "deployer" });
  put(CI_KEEPER_ADDRESS, { label: "CI keeper key", kind: "keeper" });
  for (const d of deps) put(d.gasDripRelayer, { label: "Gas drip relayer", kind: "team" });
  for (const d of deps) {
    if (d.agent?.signer) put(d.agent.signer, { label: `Agent #${d.agent.agentId} signer`, kind: "agent" });
  }
  for (const w of TEAM_WALLETS) {
    put(w.address, { label: w.short, kind: w.short.startsWith("agent") ? "agent" : "team" });
  }
  // Contracts: a name with the versions that use it ("MarketCalendar v2, v3").
  const names = new Map<string, { name: string; versions: string[] }>();
  const add = (address: string | undefined, name: string, version: string) => {
    if (!address) return;
    const k = address.toLowerCase();
    const e = names.get(k) ?? { name, versions: [] };
    if (!e.versions.includes(version)) e.versions.push(version);
    names.set(k, e);
  };
  for (const d of deps) {
    const v = d.version ?? "v?";
    for (const c of deploymentContracts(d))
      add(c.address, c.name.replace(/ TestStockToken$/, " stock token"), v);
    for (const c of roleFreeContracts(d)) add(c.address, c.name, v);
    add(d.riskLens, "RiskLens", v);
  }
  for (const [k, e] of names) put(k, { label: `${e.name} ${e.versions.join(", ")}`, kind: "contract" });
  return book;
}

/** The label of an address, or {@link UNKNOWN_HOLDER}. */
export function labelOf(book: Map<string, HolderLabel>, address: string): HolderLabel {
  return book.get(address.toLowerCase()) ?? UNKNOWN_HOLDER;
}

// ------------------------------------------------------------------ holders from logs

export interface RoleEvent {
  /** The contract that emitted it. */
  contract: string;
  role: string;
  account: string;
  sender: string;
  granted: boolean;
  tx: string;
  block: number;
  logIndex: number;
}

export interface GrantRef {
  tx: string;
  block: number;
  sender: string;
}

/**
 * The holders a contract's RoleGranted/RoleRevoked logs leave, replayed in chain order: contract → role → account →
 * the grant that is still in force. Keys are lowercase. A revoke removes the account; a later grant adds it back.
 */
export function holdersFromEvents(
  events: readonly RoleEvent[],
): Map<string, Map<string, Map<string, GrantRef>>> {
  const out = new Map<string, Map<string, Map<string, GrantRef>>>();
  const ordered = [...events].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const e of ordered) {
    const c = e.contract.toLowerCase();
    const r = e.role.toLowerCase();
    const a = e.account.toLowerCase();
    const roles = out.get(c) ?? new Map<string, Map<string, GrantRef>>();
    out.set(c, roles);
    const holders = roles.get(r) ?? new Map<string, GrantRef>();
    roles.set(r, holders);
    if (e.granted) holders.set(a, { tx: e.tx, block: e.block, sender: e.sender });
    else holders.delete(a);
  }
  return out;
}

/** Every account a contract's logs ever granted a role, per role (the candidates `hasRole` confirms). */
export function everGranted(events: readonly RoleEvent[], contract: string): Map<string, Set<string>> {
  const c = contract.toLowerCase();
  const out = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.contract.toLowerCase() !== c || !e.granted) continue;
    const r = e.role.toLowerCase();
    const s = out.get(r) ?? new Set<string>();
    s.add(e.account.toLowerCase());
    out.set(r, s);
  }
  return out;
}

// ------------------------------------------------------------------ admin events

/** The admin and role events the page lists, by contract kind (the setters each contract emits). */
export const ADMIN_EVENTS: Record<ContractKind, readonly string[]> = {
  EpochManager: [
    "RoleGranted",
    "RoleRevoked",
    "Paused",
    "Unpaused",
    "UnderlyingSet",
    "OracleSet",
    "SigmaSet",
    "SpotBufferSet",
    "PricerSet",
    "FeeManagerSet",
    "TimingsSet",
  ],
  StockOracle: ["RoleGranted", "RoleRevoked", "FeedSet", "CalendarSet", "SequencerFeedSet"],
  AgentRegistry: [
    "RoleGranted",
    "RoleRevoked",
    "StatusSet",
    "ParamsSet",
    "IdentityRegistrySet",
    "ReputationRegistrySet",
  ],
  FeeManager: ["RoleGranted", "RoleRevoked", "FeesSet", "TreasurySet"],
  MarketCalendar: ["RoleGranted", "RoleRevoked", "HolidaySet", "EarlyCloseSet"],
  OptionToken: ["RoleGranted", "RoleRevoked", "ManagerSet"],
  VaultFactory: ["RoleGranted", "RoleRevoked", "MaxDepositCapSet"],
  MirrorFeed: ["RoleGranted", "RoleRevoked"],
  TestStockToken: ["RoleGranted", "RoleRevoked", "UIMultiplierUpdated"],
  UsdgDrip: ["OwnershipTransferred", "Refilled", "Swept"],
  GasDrip: ["OwnershipTransferred", "RelayerSet"],
};

/** A decoded admin or role log, as the reader hands it over (big numbers as bigint or string). */
export interface AdminLog {
  contract: string;
  eventName: string;
  args: Record<string, unknown>;
  tx: string;
  block: number;
  logIndex: number;
}

const AGENT_STATUS = ["None", "Active", "Suspended", "Retired"];
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const big = (x: unknown) => (typeof x === "bigint" ? x : BigInt(String(x ?? 0)));
const days = (s: bigint) => {
  const d = Number(s) / 86400;
  return Number.isInteger(d) ? `${d} d` : `${(Number(s) / 3600).toLocaleString("en-US")} h`;
};
const pct18 = (x: bigint) => `${(Number(x) / 1e16).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
const isoDay = (day: bigint) => new Date(Number(day) * 86400_000).toISOString().slice(0, 10);

/** One plain line for an admin or role log; `name` turns an address into its label (or a short address). */
export function describeAction(
  eventName: string,
  args: Record<string, unknown>,
  name: (address: string) => string,
): string {
  const a = (k: string) => String(args[k] ?? "");
  switch (eventName) {
    case "RoleGranted":
      return `Granted ${roleName(a("role"))} to ${name(a("account"))}`;
    case "RoleRevoked":
      return `Revoked ${roleName(a("role"))} from ${name(a("account"))}`;
    case "OwnershipTransferred":
      return big(args.previousOwner) === 0n
        ? `Owner set to ${name(a("newOwner"))}`
        : `Ownership moved from ${name(a("previousOwner"))} to ${name(a("newOwner"))}`;
    case "Paused":
      return "Paused new epochs, proposals and buys";
    case "Unpaused":
      return "Unpaused";
    case "UnderlyingSet":
      return `${args.allowed ? "Listed" : "Delisted"} token ${name(a("token"))}`;
    case "OracleSet":
      return `Oracle set to ${name(a("oracle"))}`;
    case "SigmaSet":
      return `Sigma of ${name(a("token"))} set to ${pct18(big(args.sigma))} (bounds ${pct18(big(args.minSigma))} to ${pct18(big(args.maxSigma))})`;
    case "SpotBufferSet":
      return `Spot buffer of ${name(a("token"))} set to ${a("bps")} bps`;
    case "PricerSet":
      return `Pricer set to ${name(a("pricer"))}`;
    case "FeeManagerSet":
      return `Fee manager set to ${name(a("feeManager"))}`;
    case "TimingsSet":
      return `Timings set: proposal timeout ${days(big(args.proposalTimeout))}, sale cutoff ${days(big(args.saleCutoff))}, settlement grace ${days(big(args.settlementGrace))}`;
    case "FeedSet":
      return `Feed of ${name(a("token"))} set to ${name(a("feed"))} (max price age ${days(big(args.maxPriceAge))})`;
    case "CalendarSet":
      return `Calendar set to ${name(a("calendar"))}`;
    case "SequencerFeedSet":
      return big(args.feed) === 0n ? "Sequencer feed cleared" : `Sequencer feed set to ${name(a("feed"))}`;
    case "StatusSet":
      return `Agent #${a("agentId")} status set to ${AGENT_STATUS[Number(args.status)] ?? a("status")}`;
    case "ParamsSet":
      return `Registry parameters set: min bond ${Number(big(args.minBond)) / 1e6} USDG, slash ${Number(big(args.slashAmount)) / 1e6} USDG, ${a("maxStrikes")} strikes, unbond delay ${days(big(args.unbondDelay))}`;
    case "IdentityRegistrySet":
      return `ERC-8004 identity registry set to ${name(a("registry"))}`;
    case "ReputationRegistrySet":
      return `ERC-8004 reputation registry set to ${name(a("registry"))}`;
    case "FeesSet":
      return `Fees set: performance fee ${Number(args.perfFeeBps) / 100}%, agent share ${Number(args.agentShareBps) / 100}%`;
    case "TreasurySet":
      return `Treasury set to ${name(a("treasury"))}`;
    case "HolidaySet":
      return `${args.closed ? "Holiday set" : "Holiday cleared"}: ${isoDay(big(args.day))}`;
    case "EarlyCloseSet":
      return `${args.early ? "Early close set" : "Early close cleared"}: ${isoDay(big(args.day))}`;
    case "ManagerSet":
      return `Option manager set to ${name(a("manager"))}`;
    case "MaxDepositCapSet":
      return `Deposit cap ceiling set to ${(Number(big(args.maxDepositCap)) / 1e6).toLocaleString("en-US")} USDG`;
    case "RelayerSet":
      return `${args.allowed ? "Allowed" : "Removed"} relayer ${name(a("relayer"))}`;
    case "Refilled":
      return `Faucet refilled with ${Number(big(args.amount)) / 1e6} USDG`;
    case "Swept":
      return `Faucet swept: ${Number(big(args.amount)) / 1e6} USDG to ${name(a("to"))}`;
    case "UIMultiplierUpdated":
      return `Multiplier change scheduled to ${Number(big(args.newMultiplier)) / 1e18}`;
    default:
      return eventName;
  }
}

/** A name for an address in action lines: its label, or the short address when it is unknown. */
export const nameFrom = (book: Map<string, HolderLabel>) => (address: string) => {
  const l = book.get(address.toLowerCase());
  return l ? l.label : short(address);
};

export interface ActionGroup {
  contract: string;
  eventName: string;
  tx: string;
  block: number;
  logIndex: number;
  /** Logs of the same event from the same contract in the same transaction (a calendar's holidays, say). */
  logs: AdminLog[];
}

/** Admin logs newest first, the same event from the same contract in one transaction folded into one entry. */
export function groupActions(logs: readonly AdminLog[]): ActionGroup[] {
  const groups = new Map<string, ActionGroup>();
  const ordered = [...logs].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  for (const l of ordered) {
    const k = `${l.tx}:${l.contract.toLowerCase()}:${l.eventName}`;
    const g = groups.get(k);
    if (g) g.logs.push(l);
    else
      groups.set(k, {
        contract: l.contract,
        eventName: l.eventName,
        tx: l.tx,
        block: l.block,
        logIndex: l.logIndex,
        logs: [l],
      });
  }
  return [...groups.values()].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
}

/** How many admin actions a deployment lists. */
export const ACTION_LIMIT = 15;

// ------------------------------------------------------------------ JSON shape

export interface GovHolderJson {
  address: string;
  label: string;
  kind: HolderKind;
  /** The RoleGranted (or OwnershipTransferred) log that gave it the role; null when no log was found. */
  grantTx: string | null;
  grantBlock: number | null;
}

export interface GovRoleJson {
  /** "DEFAULT_ADMIN_ROLE", "owner", or a shortened hash for a role the source does not define. */
  role: string;
  /** bytes32 role id; null for an Ownable owner. */
  hash: string | null;
  can: string;
  cannot: string | null;
  source: string;
  /** Confirmed by `hasRole` (or `owner()`) at the head the page was read at. */
  holders: GovHolderJson[];
}

export interface GovContractJson {
  name: string;
  kind: ContractKind;
  address: string;
  /** Other versions on the chain that use this contract too. */
  sharedWith: string[];
  roles: GovRoleJson[];
}

export interface GovActionJson {
  contract: string;
  contractName: string;
  event: string;
  summary: string;
  count: number;
  tx: string;
  block: number;
  /** Block time, unix seconds; null when it could not be read. */
  timestamp: number | null;
  /** The transaction's sender and its label; null when it could not be read. */
  from: string | null;
  fromLabel: string | null;
}

export interface GovUnknownJson {
  contractName: string;
  address: string;
  role: string;
  holder: string;
}

export interface GovDeploymentJson {
  key: string;
  version: string;
  deployBlock: number;
  /** The block the logs and roles were read at. */
  head: number;
  deployer: string | null;
  contracts: GovContractJson[];
  roleFree: { name: string; address: string; why: string }[];
  /** Newest first, at most {@link ACTION_LIMIT}. */
  actions: GovActionJson[];
  actionCount: number;
  unknown: GovUnknownJson[];
  /** Where the logs and `hasRole` disagree (a holder in the logs that `hasRole` denies). */
  warnings: string[];
}

export interface GovernanceJson {
  chainId: GovChainId;
  chainName: string;
  explorer: string;
  generatedAt: string;
  deployments: GovDeploymentJson[];
  errors: { key: string; message: string }[];
}

/** Every holder on a chain's answer that the label book cannot name. */
export function unknownHolders(g: GovernanceJson): (GovUnknownJson & { key: string })[] {
  return g.deployments.flatMap((d) => d.unknown.map((u) => ({ ...u, key: d.key })));
}

/** Distinct holders and filled role slots of a deployment. */
export function holderCounts(d: GovDeploymentJson): { holders: number; slots: number } {
  const set = new Set<string>();
  let slots = 0;
  for (const c of d.contracts)
    for (const r of c.roles) {
      if (r.holders.length) slots += 1;
      for (const h of r.holders) set.add(h.address.toLowerCase());
    }
  return { holders: set.size, slots };
}

// ------------------------------------------------------------------ cache

/** How long an instance reuses an answer (the route's s-maxage matches). A failure is retried sooner. */
export const GOV_TTL_MS = 10 * 60_000;
export const GOV_ERROR_TTL_MS = 60_000;

interface Entry {
  at: number;
  ttl: number;
  value?: GovernanceJson;
  error?: string;
}

/** One read per chain per {@link GOV_TTL_MS}; concurrent requests share one run; a partial answer is kept a minute. */
export class GovernanceCache {
  private entries = new Map<GovChainId, Entry>();
  private inflight = new Map<GovChainId, Promise<Entry>>();

  constructor(
    private readonly read: (chainId: GovChainId) => Promise<GovernanceJson>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(chainId: GovChainId): Promise<{ value?: GovernanceJson; error?: string; cached: boolean }> {
    const hit = this.entries.get(chainId);
    if (hit && this.now() - hit.at < hit.ttl) return { value: hit.value, error: hit.error, cached: true };
    let run = this.inflight.get(chainId);
    if (!run) {
      run = this.read(chainId)
        .then((value): Entry => ({
          at: this.now(),
          ttl: value.errors.length ? GOV_ERROR_TTL_MS : GOV_TTL_MS,
          value,
        }))
        .catch((err: unknown): Entry => ({
          at: this.now(),
          ttl: GOV_ERROR_TTL_MS,
          error: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        }))
        .then((e) => {
          this.entries.set(chainId, e);
          this.inflight.delete(chainId);
          return e;
        });
      this.inflight.set(chainId, run);
    }
    const e = await run;
    return { value: e.value, error: e.error, cached: false };
  }
}

// ------------------------------------------------------------------ the staged path

export interface StageTest {
  name: string;
  /** Repository path with a line anchor; a test keeps each line on the test's name. */
  path: string;
}

export interface Stage {
  id: string;
  title: string;
  where: string;
  current: boolean;
  text: string;
  commitments: { text: string; tests: StageTest[] }[];
}

const TIMELOCK_TEST = "contracts/test/governance/AdminTimelock.t.sol";
const MIRROR_TEST = "sdk/test/mirror.test.ts";
const t = (file: string, line: number, name: string): StageTest => ({ name, path: `${file}#L${line}` });

/** docs/trust-model.md "Staged path for the admin keys" and D43, stage by stage. */
export const STAGES: readonly Stage[] = [
  {
    id: "stage-0",
    title: "Stage 0: a deployer key on the testnets",
    where: "Robinhood Chain testnet (v2 and v3) and Arbitrum Sepolia, today",
    current: true,
    text: "The deployer 0x26b2…13Ff holds DEFAULT_ADMIN_ROLE on every contract, GUARDIAN_ROLE and the keeper roles. It can use every admin power at once. The CI keeper key 0x317a…AfF76 holds KEEPER_ROLE on the mirrored MirrorFeeds and nothing else.",
    commitments: [
      {
        text: "Every admin call is an event (FeedSet, OracleSet, PricerSet, TimingsSet, RoleGranted), and hasRole answers who holds what: the tables above are read from both.",
        tests: [],
      },
      {
        text: "The price mirror audit fails if an EpochManager stops reading its recorded StockOracle or a StockOracle its audited MirrorFeed. This detects a swap; it does not prevent one.",
        tests: [
          t(MIRROR_TEST, 371, "checks that each deployment's StockOracle reads the audited feeds"),
          t(
            MIRROR_TEST,
            730,
            "fails when the EpochManager reads another oracle than the deployment's (setOracle)",
          ),
        ],
      },
    ],
  },
  {
    id: "stage-1",
    title: "Stage 1: a Safe behind a 73-day timelock",
    where: "Robinhood Chain mainnet (chain 4663), at deployment; never run yet",
    current: false,
    text: "Deploy.s.sol's mainnet path ends with an OpenZeppelin TimelockController as the only holder of DEFAULT_ADMIN_ROLE on all seven contracts and of the calendar's CALENDAR_ROLE. The deployer renounces every admin role, and only the Safe can schedule, cancel and execute. The guardian (the Safe by default) keeps pause, unpause and emergencyCancel without a delay. A feed, oracle or pricer change is public as a CallScheduled event for 73 days before it can run.",
    commitments: [
      {
        text: "The delay is longer than the longest epoch plus the grace, each probed from the contracts; the deploy path refuses a shorter one.",
        tests: [t(TIMELOCK_TEST, 89, "test_delayIsLongerThanTheLongestEpochPlusTheGrace")],
      },
      {
        text: "Nobody calls an admin setter directly (not the deployer, the Safe or the guardian), only the Safe schedules, and the delay changes only through itself.",
        tests: [t(TIMELOCK_TEST, 126, "test_nobodyBypassesTheTimelock")],
      },
      {
        text: "Each of the three calls is public from scheduling and cannot run a second early.",
        tests: [t(TIMELOCK_TEST, 168, "test_eachCallIsPublicAndWaitsTheFullDelay")],
      },
      {
        text: "Scheduled the moment the longest possible epoch opens, with the timings at their caps, each call lands after that epoch's honest price is final.",
        tests: [
          t(TIMELOCK_TEST, 209, "test_setFeedScheduledAtOpenLandsAfterTheHonestSettlement"),
          t(TIMELOCK_TEST, 217, "test_setOracleScheduledAtOpenLandsAfterTheHonestSettlement"),
          t(TIMELOCK_TEST, 227, "test_setPricerScheduledAtOpenLandsAfterTheEpochsLastSale"),
        ],
      },
      {
        text: "Depositors leave before the call can run: from an idle vault, from a running epoch, and from an epoch whose agent never proposes.",
        tests: [
          t(TIMELOCK_TEST, 239, "test_depositorsLeaveBeforeTheCallCanRun"),
          t(TIMELOCK_TEST, 272, "test_depositorLeavesAStalledEpochBeforeTheCallCanRun"),
        ],
      },
      {
        text: "An epoch that opens after the call is scheduled still settles on the honest feed.",
        tests: [t(TIMELOCK_TEST, 295, "test_epochOpenedAfterTheScheduleSettlesOnTheHonestFeed")],
      },
      {
        text: "For any opening time up to a day after the schedule, proposal time, tenor and settlement time within the grace, the call is still waiting.",
        tests: [t(TIMELOCK_TEST, 318, "testFuzz_noEpochRunningAtTheScheduleOutlastsTheDelay")],
      },
      {
        text: "Control: with any delay shorter than that window, the same feed swap lands first and the vault settles at the attacker's price.",
        tests: [t(TIMELOCK_TEST, 390, "testFuzz_control_aShorterDelayLetsTheFeedSwapLandFirst")],
      },
    ],
  },
  {
    id: "stage-2",
    title: "Stage 2: renounce what is no longer needed",
    where: "Mainnet, later, one contract at a time",
    current: false,
    text: "Each contract's admin role is separate, so each can be renounced on its own, as a scheduled renounceRole from the timelock. Once renounced, nobody can grant it again. Cheapest first: OptionToken, VaultFactory, FeeManager, AgentRegistry, then StockOracle and EpochManager when the stock list, the pricer and the bounds are final. GUARDIAN_ROLE probably never.",
    commitments: [
      {
        text: "Renouncing the StockOracle's and the EpochManager's admin role through the timelock makes the three swaps revert even when the timelock executes them, while the guardian still pauses and an epoch still opens, sells and settles.",
        tests: [t(TIMELOCK_TEST, 352, "test_stage2_renouncingTheOracleAndManagerAdminEndsTheGap")],
      },
    ],
  },
];

/** The trust model's section on the staged path, and D43. */
export const STAGED_PATH_DOC = "docs/trust-model.md#staged-path-for-the-admin-keys";
export const D43_DOC =
  "docs/decisions.md#d43--on-mainnet-the-admin-is-a-safe-behind-a-73-day-timelock-2026-10-02";
