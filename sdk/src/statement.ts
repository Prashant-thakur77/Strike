import {
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddress,
  pad,
  toEventSelector,
  toHex,
} from "viem";
import { agentRegistryV3Abi, epochManagerAbi, gasDripAbi, strikeVaultAbi, usdgDripAbi } from "./abi/index.js";
import { getStrikeChain } from "./chains.js";
import { type StrikeConfig, loadStrikeConfig } from "./config.js";
import { type StrikeDeployment, deploymentsFor } from "./deployments.js";
import { rpcTransportFor } from "./rpc.js";

// A wallet statement: every Strike event that involves one address, across every deployment (Robinhood Chain testnet
// v2 and v3, Arbitrum Sepolia v3), as rows with the date (UTC), chain, deployment, vault, action, the amounts and
// tokens that moved, and the transaction. Totals per token, and for each row type the `cast` commands that check a
// row against the chain with no Strike code. Read from the indexer when one is configured (its /events?account=),
// else from eth_getLogs on each chain; x402 payments (a stablecoin Transfer to strike.config.json's x402 payTo) are
// always read from the chain. It is a statement of on-chain records, nothing more.

/** Every kind of row a statement can have, in the order the footer lists them. */
export const STATEMENT_ACTIONS = [
  "deposit",
  "deposit-queued",
  "deposit-cancelled",
  "deposit-claimed",
  "withdrawal",
  "withdrawal-queued",
  "withdrawal-claimed",
  "premium-claimed",
  "option-bought",
  "option-redeemed",
  "bond-posted",
  "bond-slashed",
  "bond-withdrawn",
  "slash-to-vault",
  "x402-payment",
  "usdg-drip",
  "gas-drip",
] as const;
export type StatementAction = (typeof STATEMENT_ACTIONS)[number];

/** One sentence per row type, for the CSV footer and the docs. */
export const STATEMENT_ACTION_DESCRIPTIONS: Readonly<Record<StatementAction, string>> = {
  deposit: "Instant deposit into an unlocked vault: collateral in, vault shares out to the wallet",
  "deposit-queued": "Deposit queued while the vault was locked: collateral sent, shares at the next epoch",
  "deposit-cancelled": "A queued deposit cancelled before the epoch ended: collateral returned",
  "deposit-claimed": "Shares of a processed queued deposit claimed",
  withdrawal: "Instant withdrawal from an unlocked vault: shares burned, collateral back",
  "withdrawal-queued": "Withdrawal queued while the vault was locked: shares handed to the vault",
  "withdrawal-claimed": "Collateral of a processed queued withdrawal claimed",
  "premium-claimed": "Option premium the vault earned for the wallet's shares, claimed in USDG",
  "option-bought": "Options bought from a vault's series: USDG premium paid, option tokens received",
  "option-redeemed":
    "Options of a settled (or cancelled) series redeemed: tokens burned, payout or refund received",
  "bond-posted": "USDG bond posted to the AgentRegistry for an agent",
  "bond-slashed":
    "Part of the wallet's agent bond slashed for a proposal outside the mandate (paid to the vault)",
  "bond-withdrawn": "Agent bond withdrawn from the AgentRegistry after the unbonding delay",
  "slash-to-vault":
    "An agent's bond slashed into a vault the wallet deposited in; it is paid to the vault's depositors at epoch close",
  "x402-payment": "A payment for a Strike paid route (x402): a stablecoin Transfer to Strike's payee",
  "usdg-drip": "Test USDG received from the team's testnet faucet (UsdgDrip)",
  "gas-drip": "Gas drip received: the team's starter gas for a new wallet (GasDrip)",
};

type ContractKind = "vault" | "epochManager" | "agentRegistry" | "token" | "usdgDrip" | "gasDrip";

/** Which event each row type comes from. */
const ACTION_EVENT: Readonly<Record<StatementAction, { kind: ContractKind; event: string }>> = {
  deposit: { kind: "vault", event: "Deposit" },
  "deposit-queued": { kind: "vault", event: "DepositRequested" },
  "deposit-cancelled": { kind: "vault", event: "DepositRequestCancelled" },
  "deposit-claimed": { kind: "vault", event: "DepositClaimed" },
  withdrawal: { kind: "vault", event: "Withdraw" },
  "withdrawal-queued": { kind: "vault", event: "RedeemRequested" },
  "withdrawal-claimed": { kind: "vault", event: "RedeemClaimed" },
  "premium-claimed": { kind: "vault", event: "PremiumClaimed" },
  "option-bought": { kind: "epochManager", event: "OptionsBought" },
  "option-redeemed": { kind: "epochManager", event: "OptionsRedeemed" },
  "bond-posted": { kind: "agentRegistry", event: "BondPosted" },
  "bond-slashed": { kind: "agentRegistry", event: "Slashed" },
  "bond-withdrawn": { kind: "agentRegistry", event: "Unbonded" },
  "slash-to-vault": { kind: "epochManager", event: "ProposalRejected" },
  "x402-payment": { kind: "token", event: "Transfer" },
  "usdg-drip": { kind: "usdgDrip", event: "Dripped" },
  "gas-drip": { kind: "gasDrip", event: "Dripped" },
};

const ABIS: Readonly<Record<ContractKind, Abi>> = {
  vault: strikeVaultAbi as Abi,
  epochManager: epochManagerAbi as Abi,
  agentRegistry: agentRegistryV3Abi as Abi,
  token: erc20Abi as Abi,
  usdgDrip: usdgDripAbi as Abi,
  gasDrip: gasDripAbi as Abi,
};

function abiEvent(kind: ContractKind, name: string): AbiEvent {
  const e = ABIS[kind].find((x): x is AbiEvent => x.type === "event" && x.name === name);
  if (!e) throw new Error(`no ${name} event in the ${kind} ABI`);
  return e;
}

/** `Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)`, as `cast logs` takes it. */
export function eventSignature(e: AbiEvent): string {
  return `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
}

const topic0 = (kind: ContractKind, name: string): Hex => toEventSelector(abiEvent(kind, name));

// ------------------------------------------------------------------ types

/** One decoded log the statement is built from (from the indexer or from eth_getLogs). */
export interface StatementLog {
  chainId: number;
  /** "46630-v3"; null for a token Transfer (x402), which belongs to no deployment. */
  deployment: string | null;
  contract: Address;
  kind: ContractKind;
  eventName: string;
  /** Decoded arguments: integers as bigint, addresses checksummed. */
  args: Record<string, unknown>;
  blockNumber: bigint;
  /** Unix seconds. */
  time: number;
  txHash: Hex;
  logIndex: number;
}

/** What the statement needs to know about a vault. */
export interface StatementVaultMeta {
  chainId: number;
  address: Address;
  deployment: string;
  symbol: string;
  isCall: boolean;
  shareDecimals: number;
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  underlyingSymbol: string;
  underlyingDecimals: number;
  premiumToken: Address;
  premiumSymbol: string;
  premiumDecimals: number;
}

/** What the statement needs to know about an option series. */
export interface StatementSeriesMeta {
  id: bigint;
  vault: Address;
  isCall: boolean;
  /** WAD USD. */
  strike: bigint;
  /** Unix seconds. */
  expiry: bigint;
  cancelled: boolean;
}

/** Everything {@link buildStatement} looks up besides the logs. */
export interface StatementContext {
  chains: Record<number, { name: string; explorer: string | null; rpc: string | null }>;
  /** By `<chainId>:<vault, lower case>`. */
  vaults: Record<string, StatementVaultMeta>;
  /** By `<chainId>:<series id>` (ids hash the vault, so they are unique on a chain). */
  series: Record<string, StatementSeriesMeta>;
  /** USDG (the bond token) of each deployment, by deployment id. */
  bondTokens: Record<string, { address: Address; symbol: string; decimals: number }>;
  /** The OptionToken (ERC-1155) of each deployment, by deployment id. */
  optionTokens: Record<string, Address>;
  /** x402: who receives Strike's payments, and the tokens by `<chainId>:<token, lower case>`. */
  x402: { payTo: Address; tokens: Record<string, { symbol: string; decimals: number }> } | null;
  /** The token each UsdgDrip hands out, by `<chainId>:<drip, lower case>`. */
  dripTokens?: Record<string, { address: Address; symbol: string; decimals: number }>;
  /** The chain's native currency symbol ("ETH"), by chain id: what GasDrip sends. */
  nativeSymbols?: Record<number, string>;
}

/** One amount on a row. `info` amounts did not move in or out of the wallet (a slash out of a bond, into a vault). */
export interface StatementAmount {
  direction: "in" | "out" | "info";
  /** Decimal string in token units ("10.005944"). */
  amount: string;
  /** Base units. */
  raw: string;
  symbol: string;
  decimals: number;
  token: Address;
  /** For option tokens (ERC-1155): the series id. */
  tokenId?: string;
}

export interface StatementRow {
  /** Unix seconds. */
  time: number;
  /** ISO 8601, UTC. */
  date: string;
  chainId: number;
  chain: string;
  deployment: string | null;
  vault: Address | null;
  vaultSymbol: string | null;
  action: StatementAction;
  description: string;
  amounts: StatementAmount[];
  txHash: Hex;
  explorerUrl: string | null;
  blockNumber: string;
  logIndex: number;
  /** The contract that emitted the log. */
  contract: Address;
  /** The `cast` commands that show this row's log and decode its amounts. */
  check: string;
}

export interface StatementTotal {
  chainId: number;
  chain: string;
  token: Address;
  tokenId?: string;
  symbol: string;
  decimals: number;
  in: string;
  out: string;
  /** in - out, in token units (negative when more went out). */
  net: string;
}

/** How to check one row type with Foundry's `cast`, no Strike code needed. */
export interface StatementCheck {
  action: StatementAction;
  description: string;
  event: string;
  /** Run with the row's chain RPC, block and contract. */
  command: string;
}

export interface StatementSource {
  chainId: number;
  /** "indexer" (events from the indexer, x402 transfers from the chain) or "rpc". */
  source: "indexer" | "rpc";
  fromBlock: string | null;
  toBlock: string | null;
}

export interface WalletStatement {
  kind: "strike.statement";
  version: 1;
  address: Address;
  /** The date filter as given (ISO UTC bounds), null when open. */
  from: string | null;
  to: string | null;
  generatedAt: string;
  rows: StatementRow[];
  totals: StatementTotal[];
  checks: StatementCheck[];
  sources: StatementSource[];
  /** Chains that could not be read; their rows are missing. */
  errors: { chainId: number; error: string }[];
  note: string;
}

const NOTE =
  "A statement of the wallet's Strike records on public testnets, read from the chain. Testnet tokens have no market value. Check any row with the cast commands in `checks`.";

// ------------------------------------------------------------------ building rows (pure)

const lc = (a: string) => a.toLowerCase();
const same = (a: unknown, b: string) => typeof a === "string" && lc(a) === lc(b);
const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));

function amount(
  direction: StatementAmount["direction"],
  raw: bigint,
  token: { address: Address; symbol: string; decimals: number },
  tokenId?: bigint,
): StatementAmount {
  return {
    direction,
    amount: formatUnits(raw, token.decimals),
    raw: raw.toString(),
    symbol: token.symbol,
    decimals: token.decimals,
    token: token.address,
    ...(tokenId !== undefined ? { tokenId: tokenId.toString() } : {}),
  };
}

function usd2(wad: bigint): string {
  const cents = (wad + 5n * 10n ** 15n) / 10n ** 16n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** "TSLA 369.86 call 2026-10-09": the label of a series' option token. */
export function optionSymbol(
  underlying: string,
  s: Pick<StatementSeriesMeta, "isCall" | "strike" | "expiry">,
) {
  const day = new Date(Number(s.expiry) * 1000).toISOString().slice(0, 10);
  return `${underlying} ${usd2(s.strike)} ${s.isCall ? "call" : "put"} ${day}`;
}

/** The two `cast` commands that show a row's log and decode its non-indexed fields. */
export function checkCommand(
  kind: ContractKind,
  event: string,
  where: { rpc: string; block: string; contract: string },
): string {
  const e = abiEvent(kind, event);
  const dataTypes = e.inputs.filter((i) => !i.indexed).map((i) => i.type);
  const logs = `cast logs --rpc-url ${where.rpc} --from-block ${where.block} --to-block ${where.block} --address ${where.contract} '${eventSignature(e)}'`;
  return dataTypes.length
    ? `${logs} && cast abi-decode 'f()(${dataTypes.join(",")})' <data of that log>`
    : logs;
}

/** The footer: one check per row type present (all of them when `actions` is omitted). */
export function statementChecks(actions?: Iterable<StatementAction>): StatementCheck[] {
  const want = actions ? new Set(actions) : new Set(STATEMENT_ACTIONS);
  return STATEMENT_ACTIONS.filter((a) => want.has(a)).map((action) => {
    const { kind, event } = ACTION_EVENT[action];
    return {
      action,
      description: STATEMENT_ACTION_DESCRIPTIONS[action],
      event: eventSignature(abiEvent(kind, event)),
      command: checkCommand(kind, event, { rpc: "<RPC>", block: "<BLOCK>", contract: "<CONTRACT>" }),
    };
  });
}

/**
 * Turn decoded logs into statement rows for `address`, oldest first. Pure: every lookup comes from `ctx`, so a fixture
 * wallet can be tested without a chain. Logs that do not involve the address (or whose vault or series is unknown)
 * give no row.
 */
export function buildRows(
  address: string,
  logs: readonly StatementLog[],
  ctx: StatementContext,
): StatementRow[] {
  const me = getAddress(address);
  const sorted = [...logs].sort(
    (a, b) =>
      a.time - b.time ||
      a.chainId - b.chainId ||
      (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1),
  );
  // Agents the wallet owns (by registry): their slashes and unbonds are the wallet's.
  const ownedAgents = new Set<string>();
  for (const l of sorted) {
    if (l.kind === "agentRegistry" && l.eventName === "AgentRegistered" && same(l.args.owner, me)) {
      ownedAgents.add(`${l.chainId}:${lc(l.contract)}:${big(l.args.agentId)}`);
    }
  }
  const depositedIn = new Map<string, number>(); // vault key -> first deposit time
  const seen = new Set<string>();
  const rows: StatementRow[] = [];
  for (const l of sorted) {
    const id = `${l.chainId}:${lc(l.txHash)}:${l.logIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = rowOf(me, l, ctx, ownedAgents, depositedIn);
    if (row) rows.push(row);
  }
  return rows;
}

function rowOf(
  me: Address,
  l: StatementLog,
  ctx: StatementContext,
  ownedAgents: Set<string>,
  depositedIn: Map<string, number>,
): StatementRow | null {
  const chain = ctx.chains[l.chainId];
  const a = l.args;
  const vaultKey = (v: unknown) => `${l.chainId}:${lc(String(v))}`;
  const make = (
    action: StatementAction,
    description: string,
    amounts: StatementAmount[],
    vault: StatementVaultMeta | null,
  ): StatementRow => {
    const { kind, event } = ACTION_EVENT[action];
    return {
      time: l.time,
      date: new Date(l.time * 1000).toISOString(),
      chainId: l.chainId,
      chain: chain?.name ?? `chain ${l.chainId}`,
      deployment: l.deployment,
      vault: vault?.address ?? null,
      vaultSymbol: vault?.symbol ?? null,
      action,
      description,
      amounts,
      txHash: l.txHash,
      explorerUrl: chain?.explorer ? `${chain.explorer}/tx/${l.txHash}` : null,
      blockNumber: l.blockNumber.toString(),
      logIndex: l.logIndex,
      contract: l.contract,
      check: checkCommand(kind, event, {
        rpc: chain?.rpc ?? "<RPC>",
        block: l.blockNumber.toString(),
        contract: l.contract,
      }),
    };
  };

  if (l.kind === "vault") {
    const v = ctx.vaults[vaultKey(l.contract)];
    if (!v) return null;
    const asset = { address: v.asset, symbol: v.assetSymbol, decimals: v.assetDecimals };
    const shares = { address: v.address, symbol: v.symbol, decimals: v.shareDecimals };
    const premium = { address: v.premiumToken, symbol: v.premiumSymbol, decimals: v.premiumDecimals };
    const markDeposit = () => {
      if (!depositedIn.has(vaultKey(v.address))) depositedIn.set(vaultKey(v.address), l.time);
    };
    switch (l.eventName) {
      case "Deposit":
        if (!same(a.owner, me)) return null;
        markDeposit();
        return make(
          "deposit",
          `Deposited ${formatUnits(big(a.assets), v.assetDecimals)} ${v.assetSymbol} into ${v.symbol}`,
          [amount("out", big(a.assets), asset), amount("in", big(a.shares), shares)],
          v,
        );
      case "DepositRequested":
        if (!same(a.account, me)) return null;
        markDeposit();
        return make(
          "deposit-queued",
          `Queued a deposit of ${formatUnits(big(a.assets), v.assetDecimals)} ${v.assetSymbol} into ${v.symbol} for epoch ${big(a.epoch)}`,
          [amount("out", big(a.assets), asset)],
          v,
        );
      case "DepositRequestCancelled":
        if (!same(a.account, me)) return null;
        return make(
          "deposit-cancelled",
          `Cancelled a queued deposit into ${v.symbol} (epoch ${big(a.epoch)})`,
          [amount("in", big(a.assets), asset)],
          v,
        );
      case "DepositClaimed":
        if (!same(a.account, me)) return null;
        markDeposit();
        return make(
          "deposit-claimed",
          `Claimed ${formatUnits(big(a.shares), v.shareDecimals)} ${v.symbol} shares of a deposit processed in epoch ${big(a.epoch)}`,
          [amount("in", big(a.shares), shares)],
          v,
        );
      case "Withdraw": {
        const owner = same(a.owner, me);
        const receiver = same(a.receiver, me);
        if (!owner && !receiver) return null;
        const amounts: StatementAmount[] = [];
        if (receiver) amounts.push(amount("in", big(a.assets), asset));
        if (owner) amounts.push(amount("out", big(a.shares), shares));
        return make(
          "withdrawal",
          `Withdrew ${formatUnits(big(a.assets), v.assetDecimals)} ${v.assetSymbol} from ${v.symbol}`,
          amounts,
          v,
        );
      }
      case "RedeemRequested":
        if (!same(a.account, me)) return null;
        return make(
          "withdrawal-queued",
          `Queued a withdrawal of ${formatUnits(big(a.shares), v.shareDecimals)} ${v.symbol} shares for epoch ${big(a.epoch)}`,
          [amount("out", big(a.shares), shares)],
          v,
        );
      case "RedeemClaimed":
        if (!same(a.account, me)) return null;
        return make(
          "withdrawal-claimed",
          `Claimed ${formatUnits(big(a.assets), v.assetDecimals)} ${v.assetSymbol} from a withdrawal processed in epoch ${big(a.epoch)}`,
          [amount("in", big(a.assets), asset)],
          v,
        );
      case "PremiumClaimed":
        if (!same(a.account, me)) return null;
        return make(
          "premium-claimed",
          `Claimed ${formatUnits(big(a.amount), v.premiumDecimals)} ${v.premiumSymbol} of premium from ${v.symbol}`,
          [amount("in", big(a.amount), premium)],
          v,
        );
      default:
        return null;
    }
  }

  if (l.kind === "epochManager") {
    if (l.eventName === "OptionsBought" || l.eventName === "OptionsRedeemed") {
      const s = ctx.series[`${l.chainId}:${big(a.seriesId)}`];
      const v = s ? ctx.vaults[vaultKey(s.vault)] : undefined;
      const optionToken = l.deployment ? ctx.optionTokens[l.deployment] : undefined;
      if (!s || !v || !optionToken) return null;
      const options = {
        address: optionToken,
        symbol: optionSymbol(v.underlyingSymbol, s),
        decimals: v.underlyingDecimals,
      };
      const usdg = { address: v.premiumToken, symbol: v.premiumSymbol, decimals: v.premiumDecimals };
      const n = formatUnits(big(a.amount), v.underlyingDecimals);
      if (l.eventName === "OptionsBought") {
        const buyer = same(a.buyer, me);
        const recipient = same(a.recipient, me);
        if (!buyer && !recipient) return null;
        const amounts: StatementAmount[] = [];
        if (buyer) amounts.push(amount("out", big(a.premium), usdg));
        if (recipient) amounts.push(amount("in", big(a.amount), options, s.id));
        return make(
          "option-bought",
          `Bought ${n} ${options.symbol} options from ${v.symbol} for ${formatUnits(big(a.premium), v.premiumDecimals)} ${v.premiumSymbol}`,
          amounts,
          v,
        );
      }
      const holder = same(a.holder, me);
      const recipient = same(a.recipient, me);
      if (!holder && !recipient) return null;
      // A cancelled series refunds the premium (USDG); a settled one pays out in the vault's collateral.
      const payToken = s.cancelled
        ? usdg
        : { address: v.asset, symbol: v.assetSymbol, decimals: v.assetDecimals };
      const amounts: StatementAmount[] = [];
      if (holder) amounts.push(amount("out", big(a.amount), options, s.id));
      if (recipient) amounts.push(amount("in", big(a.paid), payToken));
      return make(
        "option-redeemed",
        `Redeemed ${n} ${options.symbol} options for ${formatUnits(big(a.paid), payToken.decimals)} ${payToken.symbol}${s.cancelled ? " (series cancelled: premium refund)" : ""}`,
        amounts,
        v,
      );
    }
    if (l.eventName === "ProposalRejected") {
      const slashed = big(a.slashed);
      const key = vaultKey(a.vault);
      const since = depositedIn.get(key);
      const v = ctx.vaults[key];
      if (slashed === 0n || since === undefined || since > l.time || !v || !l.deployment) return null;
      const bond = ctx.bondTokens[l.deployment];
      if (!bond) return null;
      return make(
        "slash-to-vault",
        `Agent ${big(a.agentId)} proposed outside ${v.symbol}'s mandate; ${formatUnits(slashed, bond.decimals)} ${bond.symbol} of its bond went to the vault, for its depositors at epoch close`,
        [amount("info", slashed, bond)],
        v,
      );
    }
    return null;
  }

  if (l.kind === "agentRegistry") {
    const bond = l.deployment ? ctx.bondTokens[l.deployment] : undefined;
    if (!bond) return null;
    const agentId = big(a.agentId);
    const owned = ownedAgents.has(`${l.chainId}:${lc(l.contract)}:${agentId}`);
    switch (l.eventName) {
      case "BondPosted":
        if (!same(a.from, me)) return null;
        return make(
          "bond-posted",
          `Posted ${formatUnits(big(a.amount), bond.decimals)} ${bond.symbol} of bond for agent ${agentId}`,
          [amount("out", big(a.amount), bond)],
          null,
        );
      case "Slashed":
        if (!owned) return null;
        return make(
          "bond-slashed",
          `Agent ${agentId}'s bond was slashed ${formatUnits(big(a.amount), bond.decimals)} ${bond.symbol} (strike ${a.strikes}) for a proposal outside a vault's mandate; the EpochManager pays it to that vault's depositors`,
          [amount("info", big(a.amount), bond)],
          null,
        );
      case "Unbonded": {
        const to = same(a.to, me);
        if (!owned && !to) return null;
        return make(
          "bond-withdrawn",
          `Withdrew ${formatUnits(big(a.amount), bond.decimals)} ${bond.symbol} of agent ${agentId}'s bond${to ? "" : ` to ${a.to}`}`,
          [amount(to ? "in" : "info", big(a.amount), bond)],
          null,
        );
      }
      default:
        return null;
    }
  }

  if (l.kind === "usdgDrip" && l.eventName === "Dripped") {
    const token = ctx.dripTokens?.[`${l.chainId}:${lc(l.contract)}`];
    if (!token || !same(a.to, me)) return null;
    return make(
      "usdg-drip",
      `Received ${formatUnits(big(a.amount), token.decimals)} ${token.symbol} from the testnet faucet`,
      [amount("in", big(a.amount), token)],
      null,
    );
  }

  if (l.kind === "gasDrip" && l.eventName === "Dripped") {
    if (!same(a.to, me)) return null;
    const native = {
      address: "0x0000000000000000000000000000000000000000" as Address,
      symbol: ctx.nativeSymbols?.[l.chainId] ?? "ETH",
      decimals: 18,
    };
    return make(
      "gas-drip",
      `Gas drip received: ${formatUnits(big(a.amount), 18)} ${native.symbol} of starter gas`,
      [amount("in", big(a.amount), native)],
      null,
    );
  }

  if (l.kind === "token" && l.eventName === "Transfer" && ctx.x402) {
    const token = ctx.x402.tokens[`${l.chainId}:${lc(l.contract)}`];
    if (!token || !same(a.from, me) || !same(a.to, ctx.x402.payTo)) return null;
    return make(
      "x402-payment",
      `Paid ${formatUnits(big(a.value), token.decimals)} ${token.symbol} to Strike for a paid route (x402)`,
      [amount("out", big(a.value), { address: l.contract, ...token })],
      null,
    );
  }
  return null;
}

/** Totals per chain and token (and option series) over the rows' in and out amounts; `info` amounts are left out. */
export function statementTotals(rows: readonly StatementRow[]): StatementTotal[] {
  const by = new Map<string, { t: Omit<StatementTotal, "in" | "out" | "net">; in: bigint; out: bigint }>();
  for (const r of rows) {
    for (const m of r.amounts) {
      if (m.direction === "info") continue;
      const key = `${r.chainId}:${lc(m.token)}:${m.tokenId ?? ""}`;
      let t = by.get(key);
      if (!t) {
        t = {
          t: {
            chainId: r.chainId,
            chain: r.chain,
            token: m.token,
            ...(m.tokenId ? { tokenId: m.tokenId } : {}),
            symbol: m.symbol,
            decimals: m.decimals,
          },
          in: 0n,
          out: 0n,
        };
        by.set(key, t);
      }
      if (m.direction === "in") t.in += BigInt(m.raw);
      else t.out += BigInt(m.raw);
    }
  }
  return [...by.values()].map(({ t, in: i, out: o }) => ({
    ...t,
    in: formatUnits(i, t.decimals),
    out: formatUnits(o, t.decimals),
    net: formatUnits(i - o, t.decimals),
  }));
}

/** A bad statement request (address, date or format). */
export class StatementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatementInputError";
  }
}

/**
 * A date bound as unix seconds: "2026-10-01" (the start of that UTC day for `from`, its end for `to`), an ISO time,
 * a Date or unix seconds. Undefined or "" is an open bound.
 */
export function statementBound(
  value: string | number | Date | null | undefined,
  edge: "from" | "to",
): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new StatementInputError(`${edge} is not a valid date`);
    return Math.floor(value.getTime() / 1000);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new StatementInputError(`${edge} must be unix seconds`);
    return Math.floor(value);
  }
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`);
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) {
      throw new StatementInputError(`${edge} is not a valid date (use YYYY-MM-DD)`);
    }
    return edge === "from" ? t / 1000 : t / 1000 + 86_399;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  if (/^\d{1,12}$/.test(s)) return Number(s);
  throw new StatementInputError(`${edge} must be a date (YYYY-MM-DD), an ISO time or unix seconds`);
}

/**
 * The statement for the rows of `rows` between `from` and `to` (inclusive, unix seconds; null is open), with totals
 * and the checks of the row types present.
 */
export function buildStatement(input: {
  address: string;
  rows: readonly StatementRow[];
  from?: number | null;
  to?: number | null;
  sources?: StatementSource[];
  errors?: { chainId: number; error: string }[];
  generatedAt?: Date;
}): WalletStatement {
  const from = input.from ?? null;
  const to = input.to ?? null;
  if (from !== null && to !== null && from > to) throw new StatementInputError("from is after to");
  const rows = input.rows.filter((r) => (from === null || r.time >= from) && (to === null || r.time <= to));
  return {
    kind: "strike.statement",
    version: 1,
    address: getAddress(input.address),
    from: from === null ? null : new Date(from * 1000).toISOString(),
    to: to === null ? null : new Date(to * 1000).toISOString(),
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    rows,
    totals: statementTotals(rows),
    checks: statementChecks(new Set(rows.map((r) => r.action))),
    sources: input.sources ?? [],
    errors: input.errors ?? [],
    note: NOTE,
  };
}

// ------------------------------------------------------------------ CSV

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, quote or line break, quotes doubled. Text that a spreadsheet
 * would run as a formula (starting with =, +, -, @, tab or CR) gets a leading apostrophe; numbers are left alone.
 */
export function csvCell(value: unknown, opts: { text?: boolean } = {}): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (opts.text !== false && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: unknown[]) => cells.map((c) => csvCell(c)).join(",");

export const STATEMENT_CSV_COLUMNS = [
  "date_utc",
  "chain_id",
  "chain",
  "deployment",
  "vault",
  "vault_symbol",
  "action",
  "in_amount",
  "in_token",
  "out_amount",
  "out_token",
  "other_amount",
  "other_token",
  "description",
  "block",
  "log_index",
  "contract",
  "tx_hash",
  "explorer_url",
] as const;

function pick(r: StatementRow, d: StatementAmount["direction"]): [string, string] {
  const hits = r.amounts.filter((m) => m.direction === d);
  return [hits.map((m) => m.amount).join("; "), hits.map((m) => m.symbol).join("; ")];
}

/**
 * The statement as CSV: the rows, then (after a blank line) the totals per token, then the `cast` command that
 * checks each row type, then the note. UTF-8, CRLF line ends.
 */
export function statementCsv(s: WalletStatement): string {
  const lines: string[] = [];
  lines.push(csvLine([...STATEMENT_CSV_COLUMNS]));
  for (const r of s.rows) {
    lines.push(
      csvLine([
        r.date,
        r.chainId,
        r.chain,
        r.deployment ?? "",
        r.vault ?? "",
        r.vaultSymbol ?? "",
        r.action,
        ...pick(r, "in"),
        ...pick(r, "out"),
        ...pick(r, "info"),
        r.description,
        r.blockNumber,
        r.logIndex,
        r.contract,
        r.txHash,
        r.explorerUrl ?? "",
      ]),
    );
  }
  lines.push("");
  lines.push(csvLine(["total_chain_id", "total_chain", "token", "token_id", "symbol", "in", "out", "net"]));
  for (const t of s.totals) {
    lines.push(csvLine([t.chainId, t.chain, t.token, t.tokenId ?? "", t.symbol, t.in, t.out, t.net]));
  }
  lines.push("");
  lines.push(csvLine(["check_action", "event", "cast_command", "what_it_is"]));
  for (const c of s.checks) lines.push(csvLine([c.action, c.event, c.command, c.description]));
  lines.push("");
  lines.push(
    csvLine(["address", s.address, "from", s.from ?? "", "to", s.to ?? "", "generated", s.generatedAt]),
  );
  lines.push(csvLine(["note", s.note]));
  for (const e of s.errors) lines.push(csvLine(["not_read", e.chainId, e.error]));
  return `${lines.join("\r\n")}\r\n`;
}

/** A request's query: `address` (required), `from`, `to` and `format` (csv or json, default json). */
export function parseStatementQuery(q: URLSearchParams | Record<string, string | null | undefined>): {
  address: Address;
  from: number | null;
  to: number | null;
  format: "csv" | "json";
} {
  const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : q[k]) ?? undefined;
  const raw = get("address")?.trim() ?? "";
  if (!raw) throw new StatementInputError("address is required (a 0x address)");
  if (!isAddress(raw, { strict: false })) throw new StatementInputError("address must be a 0x address");
  const format = (get("format")?.trim().toLowerCase() || "json") as string;
  if (format !== "csv" && format !== "json") throw new StatementInputError("format must be csv or json");
  const from = statementBound(get("from"), "from");
  const to = statementBound(get("to"), "to");
  if (from !== null && to !== null && from > to) throw new StatementInputError("from is after to");
  return { address: getAddress(raw), from, to, format };
}

// ------------------------------------------------------------------ reading the chain

export interface StatementOptions {
  /** Start of the period (inclusive): "2026-10-01", an ISO time, a Date or unix seconds. */
  from?: string | number | Date | null;
  /** End of the period (inclusive; a bare date means the end of that UTC day). */
  to?: string | number | Date | null;
  /** Chains to read (default: every chain in strike.config.json with a deployment that is not local). */
  chainIds?: readonly number[];
  /** The indexer's base URL (services/indexer). Its /events must support `account`. Default: chain reads only. */
  indexerUrl?: string | null;
  /** A public client per chain (default: the SDK's endpoints, Alchemy first when ALCHEMY_API_KEY is set). */
  publicClientFor?: (chainId: number) => PublicClient;
  fetch?: typeof fetch;
  /** How long a wallet's full history is reused, in ms (default 60 000; 0 turns the cache off). */
  cacheTtlMs?: number;
  /** Largest eth_getLogs range (default 2 000 000 blocks; halved whenever the RPC refuses a range). */
  maxBlockRange?: number;
  config?: StrikeConfig;
}

/** Chains a statement covers by default. */
export function statementChainIds(config: StrikeConfig = loadStrikeConfig()): number[] {
  return Object.entries(config.chains)
    .filter(([id, c]) => !c.local && deploymentsFor(Number(id)).length > 0)
    .map(([id]) => Number(id));
}

export const deploymentId = (chainId: number, d: Pick<StrikeDeployment, "version">) =>
  `${chainId}-${d.version ?? "v?"}`;

interface FullHistory {
  rows: StatementRow[];
  sources: StatementSource[];
  errors: { chainId: number; error: string }[];
}

const historyCache = new Map<string, { expires: number; value: Promise<FullHistory> }>();

/**
 * A wallet statement across every Strike deployment: each row with its date (UTC), chain, deployment, vault, action,
 * amounts with their tokens and the transaction, totals per token, and the `cast` commands that check each row type.
 * A chain that cannot be read is listed in `errors` and the others still answer.
 */
export async function statement(address: string, opts: StatementOptions = {}): Promise<WalletStatement> {
  if (!isAddress(address, { strict: false })) throw new StatementInputError("address must be a 0x address");
  const who = getAddress(address);
  const from = statementBound(opts.from, "from");
  const to = statementBound(opts.to, "to");
  if (from !== null && to !== null && from > to) throw new StatementInputError("from is after to");
  const config = opts.config ?? loadStrikeConfig();
  const chainIds = [...(opts.chainIds ?? statementChainIds(config))].sort((a, b) => a - b);
  const ttl = opts.cacheTtlMs ?? 60_000;
  const key = `${lc(who)}|${chainIds.join(",")}|${opts.indexerUrl ?? ""}`;
  const now = Date.now();
  let hit = ttl > 0 ? historyCache.get(key) : undefined;
  if (!hit || hit.expires <= now) {
    if (historyCache.size > 500) {
      for (const [k, v] of historyCache) if (v.expires <= now) historyCache.delete(k);
      if (historyCache.size > 500) historyCache.clear();
    }
    const value = readHistory(who, chainIds, config, opts);
    hit = { expires: now + ttl, value };
    if (ttl > 0) {
      historyCache.set(key, hit);
      // A partial answer (a chain failed) is not kept.
      value.then(
        (h) => h.errors.length && historyCache.delete(key),
        () => historyCache.delete(key),
      );
    }
  }
  const h = await hit.value;
  return buildStatement({ address: who, rows: h.rows, from, to, sources: h.sources, errors: h.errors });
}

const defaultClients = new Map<number, PublicClient>();
function defaultPublicClient(chainId: number): PublicClient {
  let pc = defaultClients.get(chainId);
  if (!pc) {
    pc = createPublicClient({
      chain: getStrikeChain(chainId),
      transport: rpcTransportFor(chainId, undefined, { retryCount: 1, timeout: 20_000 }),
    }) as PublicClient;
    defaultClients.set(chainId, pc);
  }
  return pc;
}

async function readHistory(
  who: Address,
  chainIds: number[],
  config: StrikeConfig,
  opts: StatementOptions,
): Promise<FullHistory> {
  const pcFor = opts.publicClientFor ?? defaultPublicClient;
  const indexed = opts.indexerUrl
    ? await readIndexer(opts.indexerUrl, who, opts.fetch ?? fetch).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      }))
    : null;
  const results = await Promise.all(
    chainIds.map(async (chainId) => {
      try {
        const fromIndexer =
          indexed && !("error" in indexed) ? indexed.filter((l) => l.chainId === chainId) : null;
        return { chainId, ...(await readChain(chainId, who, config, pcFor(chainId), fromIndexer, opts)) };
      } catch (err) {
        return { chainId, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
      }
    }),
  );
  const rows: StatementRow[] = [];
  const sources: StatementSource[] = [];
  const errors: { chainId: number; error: string }[] = [];
  for (const r of results) {
    if ("error" in r && r.error !== undefined) errors.push({ chainId: r.chainId, error: r.error });
    else if ("rows" in r && r.rows && r.source) {
      rows.push(...r.rows);
      sources.push(r.source);
    }
  }
  rows.sort((a, b) => a.time - b.time || a.chainId - b.chainId || a.logIndex - b.logIndex);
  return { rows, sources, errors };
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

interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

type TopicFilter = (Hex | Hex[] | null)[];

/** eth_getLogs over [from, to] in chunks; a range the RPC refuses is halved (and stays halved). */
async function scanLogs(
  pc: PublicClient,
  filters: { address: Address[]; topics: TopicFilter }[],
  from: bigint,
  to: bigint,
  maxRange: bigint,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let size = maxRange > 0n ? maxRange : 1n;
  let start = from;
  let failures = 0;
  while (start <= to) {
    const end = start + size - 1n < to ? start + size - 1n : to;
    try {
      const chunks = await Promise.all(
        filters
          .filter((f) => f.address.length > 0)
          .map(
            (f) =>
              pc.request({
                method: "eth_getLogs",
                params: [
                  { address: f.address, topics: f.topics, fromBlock: toHex(start), toBlock: toHex(end) },
                ],
              } as never) as Promise<RawLog[]>,
          ),
      );
      for (const c of chunks) out.push(...c.filter((l) => !l.removed));
      start = end + 1n;
      failures = 0;
    } catch (err) {
      if (isRangeLimitError(err) && size > 1n) {
        size /= 2n;
        continue;
      }
      failures += 1;
      if (failures > 2) throw err;
      await new Promise((r) => setTimeout(r, 500 * failures));
    }
  }
  return out;
}

const addrTopic = (a: Address): Hex => pad(lc(a) as Hex, { size: 32 });
const idTopic = (n: bigint): Hex => pad(toHex(n), { size: 32 });

function decodeRaw(
  kind: ContractKind,
  log: RawLog,
): { eventName: string; args: Record<string, unknown> } | null {
  try {
    const d = decodeEventLog({
      abi: ABIS[kind],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    });
    return { eventName: String(d.eventName), args: (d.args ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

async function readChain(
  chainId: number,
  who: Address,
  config: StrikeConfig,
  pc: PublicClient,
  fromIndexer: StatementLog[] | null,
  opts: StatementOptions,
): Promise<{ rows: StatementRow[]; source: StatementSource }> {
  const deps = deploymentsFor(chainId);
  const chainCfg = config.chains[String(chainId)];
  const ctx: StatementContext = {
    chains: {
      [chainId]: {
        name: chainCfg?.name ?? `chain ${chainId}`,
        explorer: chainCfg?.explorer ?? null,
        rpc: chainCfg?.rpc.public ?? null,
      },
    },
    vaults: {},
    series: {},
    bondTokens: {},
    optionTokens: {},
    x402: null,
  };
  const tokenMeta = cachedTokenMeta(chainId, pc);

  // Contracts: every vault the EpochManagers registered, the EpochManagers, the registries.
  const kindOf = new Map<string, { kind: ContractKind; deployment: string | null }>();
  const vaultsByDeployment = await Promise.all(
    deps.map(async (d) => {
      const id = deploymentId(chainId, d);
      kindOf.set(lc(d.epochManager), { kind: "epochManager", deployment: id });
      kindOf.set(lc(d.agentRegistry), { kind: "agentRegistry", deployment: id });
      ctx.optionTokens[id] = getAddress(d.optionToken);
      ctx.bondTokens[id] = { address: getAddress(d.usdg), ...(await tokenMeta(getAddress(d.usdg))) };
      const vaults = await vaultsOf(pc, d.epochManager);
      for (const v of vaults) kindOf.set(lc(v), { kind: "vault", deployment: id });
      return { d, id, vaults };
    }),
  );
  const vaults = vaultsByDeployment.flatMap((x) => x.vaults);
  const ems = deps.map((d) => getAddress(d.epochManager));
  const registries = [...new Set(deps.map((d) => getAddress(d.agentRegistry)))];
  const x402 = config.x402;
  const x402Tokens = (x402?.assets ?? []).filter((a) => a.chainId === chainId);
  if (x402) {
    ctx.x402 = {
      payTo: getAddress(x402.payTo),
      tokens: Object.fromEntries(
        x402Tokens.map((a) => [`${chainId}:${lc(a.address)}`, { symbol: a.symbol, decimals: a.decimals }]),
      ),
    };
    for (const a of x402Tokens) kindOf.set(lc(a.address), { kind: "token", deployment: null });
  }
  // The testnet faucets (UsdgDrip, GasDrip) serve every deployment of a chain; the indexer does not read them.
  const usdgDrips = [...new Set(deps.flatMap((d) => (d.usdgDrip ? [getAddress(d.usdgDrip)] : [])))];
  const gasDrips = [...new Set(deps.flatMap((d) => (d.gasDrip ? [getAddress(d.gasDrip)] : [])))];
  ctx.dripTokens = {};
  ctx.nativeSymbols = { [chainId]: pc.chain?.nativeCurrency.symbol ?? "ETH" };
  for (const drip of usdgDrips) {
    kindOf.set(lc(drip), { kind: "usdgDrip", deployment: null });
    const usdg = getAddress(deps.find((d) => d.usdgDrip && same(d.usdgDrip, drip))!.usdg);
    ctx.dripTokens[`${chainId}:${lc(drip)}`] = { address: usdg, ...(await tokenMeta(usdg)) };
  }
  for (const drip of gasDrips) kindOf.set(lc(drip), { kind: "gasDrip", deployment: null });

  const fromBlock = BigInt(Math.min(...deps.map((d) => d.block ?? 0)));
  const head = await pc.getBlockNumber();
  const maxRange = BigInt(opts.maxBlockRange ?? 2_000_000);
  const me = addrTopic(who);
  const t = (kind: ContractKind, ...names: string[]) => names.map((n) => topic0(kind, n));

  const raw: RawLog[] = [];
  // Strike's own contracts: from the indexer when it answered, else from the chain.
  const strikeFilters: { address: Address[]; topics: TopicFilter }[] = fromIndexer
    ? []
    : [
        {
          address: vaults,
          topics: [
            t(
              "vault",
              "DepositRequested",
              "DepositClaimed",
              "DepositRequestCancelled",
              "PremiumClaimed",
              "RedeemClaimed",
              "RedeemRequested",
            ),
            me,
          ],
        },
        {
          address: [...vaults, ...ems, ...registries],
          topics: [
            [
              ...t("vault", "Deposit", "Withdraw"),
              ...t("epochManager", "OptionsBought", "OptionsRedeemed"),
              ...t("agentRegistry", "BondPosted", "AgentRegistered"),
            ],
            null,
            me,
          ],
        },
        {
          address: [...vaults, ...ems],
          topics: [[...t("vault", "Withdraw"), ...t("epochManager", "OptionsBought")], null, null, me],
        },
      ];
  const x402Filters = x402
    ? x402Tokens.map((a) => ({
        address: [getAddress(a.address)],
        topics: [t("token", "Transfer"), me, addrTopic(getAddress(x402.payTo))] as TopicFilter,
      }))
    : [];
  // x402 payments and faucet drips: always from the chain (the indexer reads neither token nor faucet contracts).
  const dripFilters = [
    {
      address: [...usdgDrips, ...gasDrips],
      topics: [[...t("usdgDrip", "Dripped"), ...t("gasDrip", "Dripped")], me] as TopicFilter,
    },
  ];
  raw.push(
    ...(await scanLogs(pc, [...strikeFilters, ...x402Filters, ...dripFilters], fromBlock, head, maxRange)),
  );

  const logs: StatementLog[] = fromIndexer ? [...fromIndexer] : [];
  const pending: { log: RawLog; kind: ContractKind; deployment: string | null }[] = [];
  const queue = (list: RawLog[]) => {
    for (const log of list) {
      const k = kindOf.get(lc(log.address));
      if (k) pending.push({ log, ...k });
    }
  };
  queue(raw);

  // Second pass: slashes and unbonds of agents the wallet owns, and slashes into vaults it deposited in.
  const decodedFirst = pending.map((p) => ({ ...p, d: decodeRaw(p.kind, p.log) }));
  const allFirst = [
    ...logs.map((l) => ({ kind: l.kind, eventName: l.eventName, args: l.args, contract: l.contract })),
    ...decodedFirst
      .filter((p) => p.d)
      .map((p) => ({ kind: p.kind, ...p.d!, contract: getAddress(p.log.address) })),
  ];
  const agentIds = new Set<bigint>();
  const heldVaults = new Set<Address>();
  for (const e of allFirst) {
    if (e.kind === "agentRegistry" && e.eventName === "AgentRegistered" && same(e.args.owner, who)) {
      agentIds.add(big(e.args.agentId));
    }
    if (e.kind === "vault" && ["Deposit", "DepositRequested", "DepositClaimed"].includes(e.eventName)) {
      heldVaults.add(getAddress(e.contract));
    }
  }
  if (!fromIndexer && (agentIds.size || heldVaults.size)) {
    const second = await scanLogs(
      pc,
      [
        {
          address: agentIds.size ? registries : [],
          topics: [t("agentRegistry", "Slashed", "Unbonded"), [...agentIds].map(idTopic)],
        },
        {
          address: heldVaults.size ? ems : [],
          topics: [t("epochManager", "ProposalRejected"), [...heldVaults].map(addrTopic)],
        },
      ],
      fromBlock,
      head,
      maxRange,
    );
    queue(second);
  }

  // Decode, then the block times.
  const times = new Map<bigint, number>();
  for (const l of logs) times.set(l.blockNumber, l.time);
  const decoded = pending
    .map((p) => ({ ...p, d: decodeRaw(p.kind, p.log) }))
    .filter((p): p is typeof p & { d: NonNullable<typeof p.d> } => p.d !== null);
  const blocks = [...new Set(decoded.map((p) => BigInt(p.log.blockNumber)))].filter((b) => !times.has(b));
  await inBatches(blocks, 8, async (b) => {
    const block = await pc.getBlock({ blockNumber: b });
    times.set(b, Number(block.timestamp));
  });
  for (const p of decoded) {
    const blockNumber = BigInt(p.log.blockNumber);
    logs.push({
      chainId,
      deployment: p.deployment,
      contract: getAddress(p.log.address),
      kind: p.kind,
      eventName: p.d.eventName,
      args: p.d.args,
      blockNumber,
      time: times.get(blockNumber) ?? 0,
      txHash: p.log.transactionHash,
      logIndex: Number(p.log.logIndex),
    });
  }

  // Vault and series details, for the vaults and series the logs name.
  const vaultIds = new Map<string, string>();
  for (const { id, vaults: vs } of vaultsByDeployment) for (const v of vs) vaultIds.set(lc(v), id);
  const seriesIds = new Map<bigint, Address>(); // id -> EpochManager
  for (const l of logs) {
    if (l.kind === "epochManager" && (l.eventName === "OptionsBought" || l.eventName === "OptionsRedeemed")) {
      seriesIds.set(big(l.args.seriesId), l.contract);
    }
  }
  await inBatches([...seriesIds], 6, async ([id, em]) => {
    const s = await readSeries(pc, em, id);
    if (s) ctx.series[`${chainId}:${id}`] = s;
  });
  const wanted = new Set<string>();
  for (const l of logs) {
    if (l.kind === "vault") wanted.add(lc(l.contract));
    if (l.kind === "epochManager" && l.eventName === "ProposalRejected") wanted.add(lc(String(l.args.vault)));
  }
  for (const s of Object.values(ctx.series)) wanted.add(lc(s.vault));
  await inBatches(
    [...wanted].filter((v) => vaultIds.has(v)),
    4,
    async (v) => {
      ctx.vaults[`${chainId}:${v}`] = await readVaultMeta(
        pc,
        chainId,
        getAddress(v),
        vaultIds.get(v)!,
        tokenMeta,
      );
    },
  );

  return {
    rows: buildRows(who, logs, ctx),
    source: {
      chainId,
      source: fromIndexer ? "indexer" : "rpc",
      fromBlock: fromBlock.toString(),
      toBlock: head.toString(),
    },
  };
}

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// Reads that never (or rarely) change, kept per public client: vault lists (10 minutes), token and vault details.
interface ClientCaches {
  vaultLists: Map<string, { expires: number; value: Promise<Address[]> }>;
  tokens: Map<string, Promise<{ symbol: string; decimals: number }>>;
  vaults: Map<string, Promise<StatementVaultMeta>>;
}
const clientCaches = new WeakMap<PublicClient, ClientCaches>();
function cachesOf(pc: PublicClient): ClientCaches {
  let c = clientCaches.get(pc);
  if (!c) {
    c = { vaultLists: new Map(), tokens: new Map(), vaults: new Map() };
    clientCaches.set(pc, c);
  }
  return c;
}

async function vaultsOf(pc: PublicClient, em: Address): Promise<Address[]> {
  const vaultListCache = cachesOf(pc).vaultLists;
  const key = lc(em);
  const hit = vaultListCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = (async () => {
    const count = await pc.readContract({ address: em, abi: epochManagerAbi, functionName: "vaultCount" });
    return Promise.all(
      Array.from({ length: Number(count) }, (_, i) =>
        pc.readContract({ address: em, abi: epochManagerAbi, functionName: "allVaults", args: [BigInt(i)] }),
      ),
    );
  })();
  vaultListCache.set(key, { expires: Date.now() + 10 * 60_000, value });
  value.catch(() => vaultListCache.delete(key));
  return value;
}

function cachedTokenMeta(chainId: number, pc: PublicClient) {
  const tokenCache = cachesOf(pc).tokens;
  return (token: Address): Promise<{ symbol: string; decimals: number }> => {
    const key = `${chainId}:${lc(token)}`;
    let hit = tokenCache.get(key);
    if (!hit) {
      hit = Promise.all([
        pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
        pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      ]).then(([symbol, decimals]) => ({ symbol, decimals }));
      hit.catch(() => tokenCache.delete(key));
      tokenCache.set(key, hit);
    }
    return hit;
  };
}

function readVaultMeta(
  pc: PublicClient,
  chainId: number,
  vault: Address,
  deployment: string,
  tokenMeta: (t: Address) => Promise<{ symbol: string; decimals: number }>,
): Promise<StatementVaultMeta> {
  const vaultMetaCache = cachesOf(pc).vaults;
  const key = `${chainId}:${lc(vault)}`;
  let hit = vaultMetaCache.get(key);
  if (!hit) {
    const v = { address: vault, abi: strikeVaultAbi } as const;
    hit = (async () => {
      const [symbol, shareDecimals, asset, underlying, premiumToken, isCall] = await Promise.all([
        pc.readContract({ ...v, functionName: "symbol" }),
        pc.readContract({ ...v, functionName: "decimals" }),
        pc.readContract({ ...v, functionName: "asset" }),
        pc.readContract({ ...v, functionName: "underlying" }),
        pc.readContract({ ...v, functionName: "premiumToken" }),
        pc.readContract({ ...v, functionName: "isCall" }),
      ]);
      const [a, u, p] = await Promise.all([tokenMeta(asset), tokenMeta(underlying), tokenMeta(premiumToken)]);
      return {
        chainId,
        address: vault,
        deployment,
        symbol,
        isCall,
        shareDecimals,
        asset: getAddress(asset),
        assetSymbol: a.symbol,
        assetDecimals: a.decimals,
        underlyingSymbol: u.symbol,
        underlyingDecimals: u.decimals,
        premiumToken: getAddress(premiumToken),
        premiumSymbol: p.symbol,
        premiumDecimals: p.decimals,
      };
    })();
    hit.catch(() => vaultMetaCache.delete(key));
    vaultMetaCache.set(key, hit);
  }
  return hit;
}

async function readSeries(pc: PublicClient, em: Address, id: bigint): Promise<StatementSeriesMeta | null> {
  const s = await pc.readContract({
    address: em,
    abi: epochManagerAbi,
    functionName: "getSeries",
    args: [id],
  });
  if (/^0x0{40}$/i.test(s.vault)) return null;
  return {
    id,
    vault: getAddress(s.vault),
    isCall: s.isCall,
    strike: s.strike,
    expiry: BigInt(s.expiry),
    cancelled: s.cancelled,
  };
}

// ------------------------------------------------------------------ indexer

interface IndexerEvent {
  chainId: number;
  deployment: string;
  blockNumber: number;
  blockTime: string;
  txHash: string;
  logIndex: number;
  address: string;
  source: string;
  event: string | null;
  args: Record<string, unknown> | null;
}

const INDEXER_KINDS: Record<string, ContractKind> = {
  vault: "vault",
  epochManager: "epochManager",
  agentRegistry: "agentRegistry",
};

/** JSON arguments (integers as decimal strings) back to the ABI's types. */
function fromJsonArgs(
  kind: ContractKind,
  eventName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const e = abiEvent(kind, eventName);
  const out: Record<string, unknown> = {};
  for (const i of e.inputs) {
    const v = args[i.name ?? ""];
    if (/^u?int\d*$/.test(i.type) && i.type !== "uint8" && i.type !== "uint16") out[i.name!] = big(v);
    else if (i.type === "uint8" || i.type === "uint16") out[i.name!] = Number(v);
    else if (i.type === "address" && typeof v === "string") out[i.name!] = getAddress(v);
    else out[i.name!] = v;
  }
  return out;
}

/**
 * The wallet's Strike events from the indexer: every event naming the address (`/events?account=`), plus every
 * Slashed, Unbonded and ProposalRejected (filtered here: they name an agent id or a vault, not the wallet).
 */
async function readIndexer(base: string, who: Address, f: typeof fetch): Promise<StatementLog[]> {
  const url = base.replace(/\/+$/, "");
  const pages = async (query: string): Promise<IndexerEvent[]> => {
    const out: IndexerEvent[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await f(
        `${url}/events?${query}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      if (!res.ok) throw new Error(`indexer /events answered ${res.status}`);
      const body = (await res.json()) as { events: IndexerEvent[]; nextCursor: string | null };
      out.push(...body.events);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return out;
  };
  const [mine, others] = await Promise.all([
    pages(`account=${lc(who)}`),
    pages("type=Slashed,Unbonded,ProposalRejected"),
  ]);
  const out: StatementLog[] = [];
  for (const e of [...mine, ...others]) {
    const kind = INDEXER_KINDS[e.source];
    if (!kind || !e.event || !e.args) continue;
    let args: Record<string, unknown>;
    try {
      args = fromJsonArgs(kind, e.event, e.args);
    } catch {
      continue; // an event of that contract the statement does not use
    }
    out.push({
      chainId: e.chainId,
      deployment: e.deployment,
      contract: getAddress(e.address),
      kind,
      eventName: e.event,
      args,
      blockNumber: BigInt(e.blockNumber),
      time: Math.floor(Date.parse(e.blockTime) / 1000),
      txHash: e.txHash as Hex,
      logIndex: e.logIndex,
    });
  }
  return out;
}
