import {
  FEED_STATUS_DESCRIPTIONS,
  type SeriesState,
  type VaultState,
  explainError,
  parseAmount,
} from "@strike/sdk";
import { type Address, getAddress, isAddress } from "viem";
import { amount, shortAddress, usd, usdg, utc } from "./format.js";
import type { Settlement } from "./settlements.js";
import { type CommandTarget, applyFilter, chainList, parseFilter } from "./targets.js";
import { type WatchTracker, walletStatusText, walletViews } from "./wallet.js";

export type { CommandTarget, StrikeReader } from "./targets.js";

export interface ParsedCommand {
  /** Lower-case command name without the slash ("quote"). */
  name: string;
  args: string[];
}

/**
 * Parse "/quote@StrikeBot sTSLA-CC 2" into `{ name: "quote", args: ["sTSLA-CC", "2"] }`. Returns null for text
 * that is not a command, or a command addressed to a different bot (`/cmd@OtherBot` in a group).
 */
export function parseCommand(text: string | undefined, botUsername?: string): ParsedCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const [, name = "", target, rest] = match;
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  const args = rest ? rest.trim().split(/\s+/).filter(Boolean) : [];
  return { name: name.toLowerCase(), args };
}

/** Subscription state the commands touch (the {@link StateStore} satisfies it). */
export interface Subscriptions {
  /** The primary deployment's cursor: the next block to scan for alerts. */
  readonly cursor: bigint | null;
  readonly subscribers: readonly number[];
  /** The next block to scan for one deployment (`CommandTarget.key`; `primary` ones use {@link cursor}). */
  cursorOf?(key: string): bigint | null;
  subscribe(chatId: number): Promise<boolean>;
  unsubscribe(chatId: number): Promise<boolean>;
}

/** The per-wallet watch list a command touches (the {@link StateStore} satisfies `store`). */
export interface WatchContext {
  store: {
    watchesOf(chatId: number): readonly string[];
    watch(chatId: number, address: string): Promise<"added" | "already" | "full">;
    unwatch(chatId: number, address: string | null): Promise<number>;
  };
  /** Which items each chat has been told about (so /watch's own reply is not repeated as an alert). */
  tracker: WatchTracker;
  /** The app's URL, for the "act in the app" link. */
  appUrl?: string;
}

export interface CommandContext {
  /** Every deployment the bot reads: the SDK's `deploymentsFor` of each configured chain. */
  targets: readonly CommandTarget[];
  subscriptions: Subscriptions;
  chatId: number;
  /** /watch, /unwatch and /status <address>; absent, /watch says it is not available. */
  watches?: WatchContext;
}

export const HELP = [
  "Strike alerts and read-only lookups for Strike options vaults, on every chain and version Strike runs on.",
  "",
  "/subscribe - get alerts for epochs, proposals, rejections, sales and settlements",
  "/unsubscribe - stop alerts",
  "/vaults [chain] [version] - each vault's state, TVL and live series, by chain (/vaults 421614, /vaults v3)",
  "/quote <vault> [amount] [chain] [version] - premium for N options of the vault's live series (default 1)",
  "/agent <id> [chain] [version] - an agent's bond, strikes, proposals and status (ids are per registry)",
  "/status [chain] - chain head and the price feed status of each underlying",
  "/status <address> - a wallet's Strike positions and what needs its action",
  "/watch <address> - alerts in this chat when that wallet has something to do: premium to claim, a queued deposit or withdrawal processed, an option to redeem, a series waiting for its price, a slash paid into its vault (up to 5 wallets)",
  "/unwatch <address|all> - stop watching",
  "/help - this list",
  "",
  "This bot never asks for keys and cannot send transactions.",
  "Addresses are public chain data: the bot stores only which chat watches which address, nothing else about you or the wallet.",
].join("\n");

/** Run one command and return the reply text. */
export async function runCommand(cmd: ParsedCommand, ctx: CommandContext): Promise<string> {
  try {
    switch (cmd.name) {
      case "start":
        return `Hi. ${HELP}`;
      case "help":
        return HELP;
      case "subscribe":
        return (await ctx.subscriptions.subscribe(ctx.chatId))
          ? "Subscribed. This chat will get an alert for each Strike epoch, proposal, rejection, sale and settlement, on every chain. /unsubscribe to stop."
          : "This chat is already subscribed. /unsubscribe to stop.";
      case "unsubscribe":
        return (await ctx.subscriptions.unsubscribe(ctx.chatId))
          ? "Unsubscribed. No more alerts for this chat."
          : "This chat was not subscribed.";
      case "vaults":
        return await vaultsReply(cmd.args, ctx);
      case "quote":
        return await quoteReply(cmd.args, ctx);
      case "agent":
        return await agentReply(cmd.args, ctx);
      case "status":
        if (cmd.args[0] && isAddress(cmd.args[0], { strict: false }))
          return await walletStatusReply(cmd.args[0], ctx);
        return await statusReply(cmd.args, ctx);
      case "watch":
        return await watchReply(cmd.args, ctx);
      case "unwatch":
        return await unwatchReply(cmd.args, ctx);
      default:
        return `Unknown command /${cmd.name}. Send /help for the list.`;
    }
  } catch (err) {
    return `Could not read that from the chain: ${explainError(err)}`;
  }
}

function tvl(v: VaultState): string {
  return `${amount(v.totalAssets, v.assetDecimals)} ${v.assetSymbol}`;
}

/** The app's wording for a Selling series that is past expiry and not settled. */
export function expiredLine(expiry: bigint): string {
  return `Expired ${utc(expiry)}, waiting for settlement: settles at the first mainnet Chainlink price at or after expiry`;
}

/**
 * A Selling epoch stays Selling on chain until someone settles it, so a series is "expired" when its expiry has
 * passed at chain time `now` and it has neither settled nor been cancelled.
 */
export function isExpired(s: SeriesState | null, now: bigint): boolean {
  return s !== null && !s.settled && !s.cancelled && now >= s.expiry;
}

function settlementLine(v: VaultState, s: Settlement): string {
  const series = `${s.isCall ? "call" : "put"} strike ${usd(s.strike)}, expiry ${utc(s.expiry)}`;
  if (s.settlementPrice === 0n) return `Last settled: epoch ${s.epoch}, ${series}. No options were sold.`;
  const outcome =
    s.payout > 0n
      ? `in the money, payout ${amount(s.payout, v.assetDecimals, 6)} ${v.assetSymbol}`
      : "out of the money, payout 0";
  return `Last settled: epoch ${s.epoch}, ${series}, at ${usd(s.settlementPrice)}: ${outcome}.`;
}

/** The lines for one vault, as of chain time `now`. Exported for the tests. */
export function vaultBlock(v: VaultState, label: string, now: bigint, last: Settlement | null): string {
  const kind = v.isCall ? "covered call" : "cash-secured put";
  const s = v.series;
  const expired = s !== null && v.epoch.state === "Selling" && isExpired(s, now);
  const state = expired ? "Expired, settling" : v.epoch.state;
  const lines = [
    `${v.symbol}, ${kind} on ${v.underlyingSymbol} (${shortAddress(v.address)})`,
    `${label} · epoch ${v.currentEpoch}: ${state}. TVL ${tvl(v)}.`,
  ];
  if (s && expired) {
    lines.push(
      `Series: ${s.isCall ? "call" : "put"} strike ${usd(s.strike)}, ${amount(s.sold, v.underlyingDecimals, 6)} of ${amount(s.size, v.underlyingDecimals, 6)} sold`,
      expiredLine(s.expiry),
    );
  } else if (s && s.settled) {
    lines.push(
      settlementLine(v, {
        epoch: v.currentEpoch,
        isCall: s.isCall,
        strike: s.strike,
        expiry: s.expiry,
        settlementPrice: s.settlementPrice,
        payout: s.payoutPerOption,
      }),
    );
  } else if (s) {
    lines.push(
      `Live series: ${s.isCall ? "call" : "put"} strike ${usd(s.strike)}, expiry ${utc(s.expiry)}, ${amount(s.sold, v.underlyingDecimals, 6)} of ${amount(s.size, v.underlyingDecimals, 6)} sold`,
    );
  } else if (v.epoch.state === "Open") {
    lines.push("No live series yet: waiting for the agent's proposal.");
  } else {
    lines.push("No live series.");
    if (last) lines.push(settlementLine(v, last));
  }
  return lines.join("\n");
}

/** `Promise.allSettled` for a list of targets, keeping each one's label for the error line. */
async function eachTarget<T>(
  targets: readonly CommandTarget[],
  read: (t: CommandTarget) => Promise<T>,
): Promise<{ target: CommandTarget; result: PromiseSettledResult<T> }[]> {
  const results = await Promise.allSettled(targets.map(read));
  return targets.map((target, i) => ({ target, result: results[i]! }));
}

const unreadable = (t: CommandTarget, reason: unknown) =>
  `${t.label}: could not read (${explainError(reason)})`;

/** Targets picked by the arguments, or the reply that explains why none. */
function pick(args: string[], ctx: CommandContext, usage: string): CommandTarget[] | string {
  if (ctx.targets.length === 0) return "No Strike deployment is configured.";
  const filter = parseFilter(args, ctx.targets);
  if (typeof filter === "string") return `${filter}\n${usage}`;
  const chosen = applyFilter(ctx.targets, filter);
  if (chosen.length === 0) {
    return `No Strike deployment matches that. ${chainList(ctx.targets)}\n${usage}`;
  }
  return chosen;
}

async function vaultsReply(args: string[], ctx: CommandContext): Promise<string> {
  const chosen = pick(
    args,
    ctx,
    "Usage: /vaults [chain] [version], for example /vaults 421614 or /vaults v3",
  );
  if (typeof chosen === "string") return chosen;
  const read = await eachTarget(chosen, async (t) => {
    const [vaults, now] = await Promise.all([t.strike.listVaults(), t.strike.blockTimestamp()]);
    return Promise.all(
      vaults.map(async (v) => {
        let last: Settlement | null = null;
        if (v.epoch.state === "Idle" && t.lastSettlement) {
          try {
            last = await t.lastSettlement(v);
          } catch {
            // the settlement line is extra: a log query the RPC refuses must not hide the vault
          }
        }
        return vaultBlock(v, t.label, now, last);
      }),
    );
  });
  const sections: string[] = [];
  const chains = [...new Set(chosen.map((t) => t.chainId))];
  for (const chainId of chains) {
    const rows = read.filter((r) => r.target.chainId === chainId);
    const blocks: string[] = [];
    for (const { target, result } of rows) {
      if (result.status === "rejected") blocks.push(unreadable(target, result.reason));
      else if (result.value.length === 0) blocks.push(`${target.label}: no vaults registered yet.`);
      else blocks.push(...result.value);
    }
    const first = rows[0]!.target;
    sections.push(`${first.chainName} (${chainId})\n\n${blocks.join("\n\n")}`);
  }
  return sections.join("\n\n");
}

interface FoundVault {
  target: CommandTarget;
  vault: VaultState;
}

/** Find vaults by share symbol (case-insensitive) or address, across the given deployments. */
async function findVaults(
  query: string,
  targets: readonly CommandTarget[],
): Promise<{ hits: FoundVault[]; known: string[]; failed: string[] }> {
  const read = await eachTarget(targets, (t) => t.strike.listVaults());
  const hits: FoundVault[] = [];
  const known: string[] = [];
  const failed: string[] = [];
  const address = isAddress(query, { strict: false }) ? getAddress(query) : null;
  for (const { target, result } of read) {
    if (result.status === "rejected") {
      failed.push(unreadable(target, result.reason));
      continue;
    }
    for (const vault of result.value) {
      known.push(vault.symbol);
      const match = address ? vault.address === address : vault.symbol.toLowerCase() === query.toLowerCase();
      if (match) hits.push({ target, vault });
    }
  }
  return { hits, known: [...new Set(known)], failed };
}

async function quoteReply(args: string[], ctx: CommandContext): Promise<string> {
  const usage =
    "Usage: /quote <vault symbol or address> [amount] [chain] [version], for example /quote sTSLA-CC 2 v3";
  const [query, amountArg = "1", ...rest] = args;
  if (!query) return usage;
  const chosen = pick(rest, ctx, usage);
  if (typeof chosen === "string") return chosen;
  const { hits, known, failed } = await findVaults(query, chosen);
  if (hits.length === 0) {
    if (failed.length > 0 && known.length === 0) return failed.join("\n");
    return isAddress(query, { strict: false })
      ? `${query} is not a registered Strike vault.`
      : `No vault named ${query}. Vaults: ${known.join(", ") || "none"}.`;
  }
  const quotes = await Promise.all(hits.map((h) => quoteOne(h, amountArg)));
  return [...new Set(quotes)].join("\n\n");
}

async function quoteOne({ target, vault: v }: FoundVault, amountArg: string): Promise<string> {
  const { strike } = target;
  let raw: bigint;
  try {
    raw = parseAmount(amountArg, v.underlyingDecimals);
  } catch {
    return `"${amountArg}" is not a number. Usage: /quote ${v.symbol} 2`;
  }
  if (raw <= 0n) return "The amount must be more than 0.";
  const s = v.series;
  const tag = `${v.symbol} (${target.label})`;
  if (!s) return `${tag} has no live series (epoch ${v.currentEpoch} is ${v.epoch.state}).`;

  // Chain time, not this machine's clock; an expired series is not quoted (the chain refuses to sell it).
  const now = await strike.blockTimestamp();
  if (isExpired(s, now)) {
    return [
      `${tag}: ${s.isCall ? "call" : "put"} strike ${usd(s.strike)}, expiry ${utc(s.expiry)}`,
      expiredLine(s.expiry),
      "Not buyable now: the series is no longer on sale.",
    ].join("\n");
  }
  const [q, cutoff, marketOpen] = await Promise.all([
    strike.quoteBuy(s.id, raw),
    strike.saleCutoff(),
    strike.marketOpen(),
  ]);
  const perOption = (q.premium * 10n ** BigInt(v.underlyingDecimals)) / raw;
  const n = amount(raw, v.underlyingDecimals, 6);
  const kind = s.isCall ? "call" : "put";
  const remaining = s.size - s.sold;
  const notes: string[] = [];
  const size = amount(s.size, v.underlyingDecimals, 6);
  if (now + BigInt(cutoff) >= s.expiry) notes.push("sales have closed for this series");
  if (remaining === 0n) notes.push(`the series is sold out (${size} of ${size} sold)`);
  else if (raw > remaining)
    notes.push(`only ${amount(remaining, v.underlyingDecimals, 6)} of ${size} options are left`);
  if (!marketOpen) notes.push("the NYSE session is closed");
  return [
    `${tag}: ${n} ${v.underlyingSymbol} ${kind}${n === "1" ? "" : "s"}, strike ${usd(s.strike)}, expiry ${utc(s.expiry)}`,
    `Premium ${usdg(q.premium, target.usdgDecimals)} USDG (${usdg(perOption, target.usdgDecimals)} per option)`,
    `Vault collateral locked: ${amount(q.collateral, v.assetDecimals, 6)} ${v.assetSymbol}`,
    notes.length === 0 ? "Buyable now." : `Not buyable now: ${notes.join("; ")}.`,
  ].join("\n");
}

async function agentReply(args: string[], ctx: CommandContext): Promise<string> {
  const usage = "Usage: /agent <id> [chain] [version], for example /agent 1 or /agent 1 v3";
  const [idArg, ...rest] = args;
  if (!idArg || !/^\d+$/.test(idArg)) return usage;
  const chosen = pick(rest, ctx, usage);
  if (typeof chosen === "string") return chosen;
  // Agent ids belong to a registry: ask each registry once, however many deployments share it.
  const seenRegistry = new Set<string>();
  const registries = chosen.filter((t) => {
    const key = `${t.chainId}:${t.registry.toLowerCase()}`;
    return seenRegistry.has(key) ? false : (seenRegistry.add(key), true);
  });
  const read = await eachTarget(registries, (t) => t.strike.agentStats(BigInt(idArg)));
  const blocks: string[] = [];
  const failed: string[] = [];
  for (const { target, result } of read) {
    if (result.status === "rejected") {
      failed.push(unreadable(target, result.reason));
      continue;
    }
    const a = result.value;
    if (a.status === "None") continue;
    const money = (x: bigint) => `${usdg(x, target.usdgDecimals)} USDG`;
    const lines = [
      `Agent ${a.agentId} (${target.label}): ${a.status}, ${a.active ? "can propose" : "cannot propose now"}`,
      `Bond ${money(a.bond)} (minimum ${money(a.params.minBond)}), strikes ${a.strikes} of ${a.params.maxStrikes}`,
      `Proposals: ${a.accepted} accepted, ${a.rejected} rejected`,
      `Settled epochs: ${a.settledEpochs}, cumulative depositor PnL ${money(a.cumulativePnl)}`,
    ];
    if (a.unbonding > 0n) lines.push(`Unbonding: ${money(a.unbonding)} from ${utc(a.unbondAt)}`);
    lines.push(`Signer ${shortAddress(a.signer)}`);
    blocks.push(lines.join("\n"));
  }
  if (blocks.length === 0 && failed.length === read.length) throw new Error(failed.join("; "));
  if (blocks.length === 0) {
    const where = registries.length === 1 ? ` on ${registries[0]!.label}` : "";
    blocks.push(`Agent ${idArg} is not registered${where}.`);
    if (registries.length > 1) {
      blocks[0] += ` Checked: ${registries.map((t) => t.label).join("; ")}.`;
    }
  }
  return [...blocks, ...failed].join("\n\n");
}

async function statusReply(args: string[], ctx: CommandContext): Promise<string> {
  const chosen = pick(args, ctx, "Usage: /status [chain] [version], for example /status 421614");
  if (typeof chosen === "string") return chosen;
  const chains = [...new Set(chosen.map((t) => t.chainId))];
  const sections = await Promise.all(
    chains.map(async (chainId) => {
      const targets = chosen.filter((t) => t.chainId === chainId);
      const first = targets[0]!;
      const header = `${first.chainName} (${chainId})`;
      try {
        const [block, marketOpen] = await Promise.all([
          first.strike.viem.publicClient.getBlock({ blockTag: "latest" }),
          first.strike.marketOpen(),
        ]);
        const lines = [
          `${header}: head block ${block.number}, ${utc(block.timestamp)}`,
          `NYSE session: ${marketOpen ? "open" : "closed"}`,
        ];
        for (const t of targets) lines.push(...(await deploymentStatus(t, targets.length > 1, ctx)));
        return lines.join("\n");
      } catch (err) {
        return `${header}: could not read (${explainError(err)})`;
      }
    }),
  );
  sections.push(
    `${ctx.subscriptions.subscribers.length} subscribed chat(s) get alerts from every deployment.`,
  );
  return sections.join("\n\n");
}

async function deploymentStatus(t: CommandTarget, tagged: boolean, ctx: CommandContext): Promise<string[]> {
  const tag = tagged && t.version ? `${t.version} ` : "";
  const lines: string[] = [];
  try {
    const vaults = await t.strike.listVaults();
    const underlyings = new Map<Address, string>();
    for (const v of vaults) underlyings.set(v.underlying, v.underlyingSymbol);
    const feeds = await Promise.all(
      [...underlyings].map(async ([token, symbol]) => ({
        symbol,
        status: await t.strike.oracleStatus(token),
      })),
    );
    for (const { symbol, status } of feeds) {
      const price = status.price > 0n ? `, ${usd(status.price)}` : "";
      const updated = status.updatedAt > 0n ? `, updated ${utc(status.updatedAt)}` : "";
      const why = status.ok ? "" : ` (${FEED_STATUS_DESCRIPTIONS[status.status]})`;
      lines.push(`${tag}${symbol} feed: ${status.status}${price}${updated}${why}`);
    }
  } catch (err) {
    lines.push(`${tag || `${t.label}: `}feeds: could not read (${explainError(err)})`);
  }
  const cursor = t.primary ? ctx.subscriptions.cursor : (ctx.subscriptions.cursorOf?.(t.key) ?? null);
  lines.push(`${tag}Alerts: scanned to block ${cursor === null ? "none yet" : (cursor - 1n).toString()}`);
  return lines;
}

async function walletStatusReply(raw: string, ctx: CommandContext): Promise<string> {
  const address = getAddress(raw);
  const { views, errors } = await walletViews(ctx.targets, address);
  if (views.length === 0 && errors.length === 0) return "Wallet lookups are not available on this bot.";
  return walletStatusText(address, views, errors, ctx.watches?.appUrl);
}

const WATCH_USAGE =
  "Usage: /watch <0x address>, for example /watch 0x7767ca2d944A91e6ae896f85cACA4DfDE1810044";

async function watchReply(args: string[], ctx: CommandContext): Promise<string> {
  const w = ctx.watches;
  if (!w) return "Wallet alerts are not available on this bot.";
  const [raw] = args;
  if (!raw) {
    const list = w.store.watchesOf(ctx.chatId);
    return list.length
      ? `This chat watches:\n${list.map((a) => `• ${a}`).join("\n")}\n/unwatch <address> or /unwatch all to stop.`
      : `This chat watches no wallet. ${WATCH_USAGE}`;
  }
  if (!isAddress(raw, { strict: false })) return `"${raw.slice(0, 64)}" is not a 0x address. ${WATCH_USAGE}`;
  const address = getAddress(raw);
  const added = await w.store.watch(ctx.chatId, address);
  if (added === "full") {
    return `This chat already watches ${w.store.watchesOf(ctx.chatId).length} wallets, the most it can. /unwatch one first.`;
  }
  const { views, errors } = await walletViews(ctx.targets, address);
  const items = views.flatMap((v) => v.items);
  // What /watch shows now is not sent again as an alert.
  w.tracker.fresh(ctx.chatId, address, items, errors.length === 0);
  const head =
    added === "already"
      ? `This chat already watches ${address}.`
      : `Watching ${address}. This chat gets an alert when it has something to do on any Strike deployment. Addresses are public chain data; the bot stores only this chat's watch list.`;
  return `${head}\n\n${walletStatusText(address, views, errors, w.appUrl)}`;
}

async function unwatchReply(args: string[], ctx: CommandContext): Promise<string> {
  const w = ctx.watches;
  if (!w) return "Wallet alerts are not available on this bot.";
  const [raw] = args;
  if (!raw) return "Usage: /unwatch <0x address> or /unwatch all";
  if (raw.toLowerCase() === "all") {
    const list = [...w.store.watchesOf(ctx.chatId)];
    const n = await w.store.unwatch(ctx.chatId, null);
    for (const a of list) w.tracker.forget(ctx.chatId, a);
    return n ? `Stopped watching ${n} wallet(s).` : "This chat watches no wallet.";
  }
  if (!isAddress(raw, { strict: false })) return `"${raw.slice(0, 64)}" is not a 0x address.`;
  const address = getAddress(raw);
  const n = await w.store.unwatch(ctx.chatId, address);
  w.tracker.forget(ctx.chatId, address);
  return n ? `Stopped watching ${address}.` : `This chat was not watching ${address}.`;
}
