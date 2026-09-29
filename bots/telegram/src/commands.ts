import {
  FEED_STATUS_DESCRIPTIONS,
  type StrikeClient,
  type VaultState,
  explainError,
  getStrikeChain,
  parseAmount,
} from "@strike/sdk";
import { type Address, getAddress, isAddress } from "viem";
import { amount, shortAddress, usd, usdg, utc } from "./format.js";

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

/** The Strike reads the commands use (a subset of `StrikeClient`, so tests can fake it). */
export type StrikeReader = Pick<
  StrikeClient,
  | "chainId"
  | "listVaults"
  | "getVault"
  | "quoteBuy"
  | "agentStats"
  | "oracleStatus"
  | "marketOpen"
  | "saleCutoff"
  | "blockTimestamp"
> & { viem: { publicClient: Pick<StrikeClient["viem"]["publicClient"], "getBlock"> } };

/** Subscription state the commands touch (the {@link StateStore} satisfies it). */
export interface Subscriptions {
  readonly cursor: bigint | null;
  readonly subscribers: readonly number[];
  subscribe(chatId: number): Promise<boolean>;
  unsubscribe(chatId: number): Promise<boolean>;
}

export interface CommandContext {
  strike: StrikeReader;
  subscriptions: Subscriptions;
  chatId: number;
  usdgDecimals: number;
}

export const HELP = [
  "Strike alerts and read-only lookups for Strike options vaults.",
  "",
  "/subscribe - get alerts for epochs, proposals, rejections, sales and settlements",
  "/unsubscribe - stop alerts",
  "/vaults - each vault's state, TVL and live series",
  "/quote <vault> [amount] - premium for N options of the vault's live series (default 1)",
  "/agent <id> - an agent's bond, strikes, proposals and status",
  "/status - chain head and the price feed status of each underlying",
  "/help - this list",
  "",
  "This bot never asks for keys and cannot send transactions.",
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
          ? "Subscribed. This chat will get an alert for each Strike epoch, proposal, rejection, sale and settlement. /unsubscribe to stop."
          : "This chat is already subscribed. /unsubscribe to stop.";
      case "unsubscribe":
        return (await ctx.subscriptions.unsubscribe(ctx.chatId))
          ? "Unsubscribed. No more alerts for this chat."
          : "This chat was not subscribed.";
      case "vaults":
        return await vaultsReply(ctx);
      case "quote":
        return await quoteReply(cmd.args, ctx);
      case "agent":
        return await agentReply(cmd.args, ctx);
      case "status":
        return await statusReply(ctx);
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

async function vaultsReply(ctx: CommandContext): Promise<string> {
  const vaults = await ctx.strike.listVaults();
  if (vaults.length === 0) return "No Strike vaults are registered on this chain yet.";
  const blocks = vaults.map((v) => {
    const lines = [
      `${v.symbol}, ${v.isCall ? "covered call" : "cash-secured put"} on ${v.underlyingSymbol} (${shortAddress(v.address)})`,
      `Epoch ${v.currentEpoch}: ${v.epoch.state}. TVL ${tvl(v)}.`,
    ];
    if (v.series) {
      const s = v.series;
      lines.push(
        `Live series: ${s.isCall ? "call" : "put"} strike ${usd(s.strike)}, expiry ${utc(s.expiry)}, ${amount(s.sold, v.underlyingDecimals, 6)} of ${amount(s.size, v.underlyingDecimals, 6)} sold`,
      );
    } else if (v.epoch.state === "Open") {
      lines.push("No live series yet: waiting for the agent's proposal.");
    } else {
      lines.push("No live series.");
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/** Find a vault by share symbol (case-insensitive) or address. */
async function findVault(query: string, strike: StrikeReader): Promise<VaultState | string> {
  const vaults = await strike.listVaults();
  if (isAddress(query, { strict: false })) {
    const address: Address = getAddress(query);
    const hit = vaults.find((v) => v.address === address);
    return hit ?? `${query} is not a registered Strike vault.`;
  }
  const hit = vaults.find((v) => v.symbol.toLowerCase() === query.toLowerCase());
  if (hit) return hit;
  const known = vaults.map((v) => v.symbol).join(", ") || "none";
  return `No vault named ${query}. Vaults: ${known}.`;
}

async function quoteReply(args: string[], ctx: CommandContext): Promise<string> {
  const [query, amountArg = "1"] = args;
  if (!query) return "Usage: /quote <vault symbol or address> [amount], for example /quote sTSLA-CC 2";
  const found = await findVault(query, ctx.strike);
  if (typeof found === "string") return found;
  const v = found;
  let raw: bigint;
  try {
    raw = parseAmount(amountArg, v.underlyingDecimals);
  } catch {
    return `"${amountArg}" is not a number. Usage: /quote ${v.symbol} 2`;
  }
  if (raw <= 0n) return "The amount must be more than 0.";
  const s = v.series;
  if (!s) return `${v.symbol} has no live series (epoch ${v.currentEpoch} is ${v.epoch.state}).`;

  const [q, now, cutoff, marketOpen] = await Promise.all([
    ctx.strike.quoteBuy(s.id, raw),
    ctx.strike.blockTimestamp(),
    ctx.strike.saleCutoff(),
    ctx.strike.marketOpen(),
  ]);
  const perOption = (q.premium * 10n ** BigInt(v.underlyingDecimals)) / raw;
  const n = amount(raw, v.underlyingDecimals, 6);
  const kind = s.isCall ? "call" : "put";
  const remaining = s.size - s.sold;
  const notes: string[] = [];
  const size = amount(s.size, v.underlyingDecimals, 6);
  if (remaining === 0n) notes.push(`the series is sold out (${size} of ${size} sold)`);
  else if (raw > remaining)
    notes.push(`only ${amount(remaining, v.underlyingDecimals, 6)} of ${size} options are left`);
  if (now + BigInt(cutoff) >= s.expiry) notes.push("sales have closed for this series");
  if (!marketOpen) notes.push("the NYSE session is closed");
  return [
    `${v.symbol}: ${n} ${v.underlyingSymbol} ${kind}${n === "1" ? "" : "s"}, strike ${usd(s.strike)}, expiry ${utc(s.expiry)}`,
    `Premium ${usdg(q.premium, ctx.usdgDecimals)} USDG (${usdg(perOption, ctx.usdgDecimals)} per option)`,
    `Vault collateral locked: ${amount(q.collateral, v.assetDecimals, 6)} ${v.assetSymbol}`,
    notes.length === 0 ? "Buyable now." : `Not buyable now: ${notes.join("; ")}.`,
  ].join("\n");
}

async function agentReply(args: string[], ctx: CommandContext): Promise<string> {
  const [idArg] = args;
  if (!idArg || !/^\d+$/.test(idArg)) return "Usage: /agent <id>, for example /agent 1";
  const a = await ctx.strike.agentStats(BigInt(idArg));
  if (a.status === "None") return `Agent ${idArg} is not registered.`;
  const money = (x: bigint) => `${usdg(x, ctx.usdgDecimals)} USDG`;
  const lines = [
    `Agent ${a.agentId}: ${a.status}, ${a.active ? "can propose" : "cannot propose now"}`,
    `Bond ${money(a.bond)} (minimum ${money(a.params.minBond)}), strikes ${a.strikes} of ${a.params.maxStrikes}`,
    `Proposals: ${a.accepted} accepted, ${a.rejected} rejected`,
    `Settled epochs: ${a.settledEpochs}, cumulative depositor PnL ${money(a.cumulativePnl)}`,
  ];
  if (a.unbonding > 0n) lines.push(`Unbonding: ${money(a.unbonding)} from ${utc(a.unbondAt)}`);
  lines.push(`Signer ${shortAddress(a.signer)}`);
  return lines.join("\n");
}

async function statusReply(ctx: CommandContext): Promise<string> {
  const { strike } = ctx;
  const [block, marketOpen, vaults] = await Promise.all([
    strike.viem.publicClient.getBlock({ blockTag: "latest" }),
    strike.marketOpen(),
    strike.listVaults(),
  ]);
  let chainName = `chain ${strike.chainId}`;
  try {
    chainName = `${getStrikeChain(strike.chainId).name} (${strike.chainId})`;
  } catch {
    // keep the plain id
  }
  const lines = [
    `${chainName}: head block ${block.number}, ${utc(block.timestamp)}`,
    `NYSE session: ${marketOpen ? "open" : "closed"}`,
  ];
  const underlyings = new Map<Address, string>();
  for (const v of vaults) underlyings.set(v.underlying, v.underlyingSymbol);
  const feeds = await Promise.all(
    [...underlyings].map(async ([token, symbol]) => ({ symbol, status: await strike.oracleStatus(token) })),
  );
  for (const { symbol, status } of feeds) {
    const price = status.price > 0n ? `, ${usd(status.price)}` : "";
    const updated = status.updatedAt > 0n ? `, updated ${utc(status.updatedAt)}` : "";
    const why = status.ok ? "" : ` (${FEED_STATUS_DESCRIPTIONS[status.status]})`;
    lines.push(`${symbol} feed: ${status.status}${price}${updated}${why}`);
  }
  const cursor = ctx.subscriptions.cursor;
  lines.push(
    `Alerts: scanned to block ${cursor === null ? "none yet" : (cursor - 1n).toString()}, ${ctx.subscriptions.subscribers.length} subscribed chat(s)`,
  );
  return lines.join("\n");
}
