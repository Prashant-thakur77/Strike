import { type AlertPipeline, processRange } from "./alerts.js";
import { type CommandContext, parseCommand, runCommand } from "./commands.js";
import { backoffMs, sleep } from "./retry.js";
import type { StateStore } from "./store.js";
import type { CommandTarget } from "./targets.js";
import { type WalletReader, type WatchTracker, slashItems, walletViews, watchAlertText } from "./wallet.js";
import type { Address } from "viem";
import {
  type SendOptions,
  type TelegramApi,
  TelegramError,
  type TelegramUpdate,
  broadcast,
  sendWithRetry,
} from "./telegram.js";

/** One deployment's alert feed: its own logs, head and cursor. */
export interface AlertSource {
  /** `CommandTarget.key`: the cursor is stored under it. */
  key: string;
  /** "Robinhood Chain testnet · v3", for the log. */
  label: string;
  /** The first deployment of the primary chain: its cursor is the state file's legacy `cursor`. */
  primary: boolean;
  pipeline: AlertPipeline;
  /** Chain head, for the alert loop. */
  getBlockNumber: () => Promise<bigint>;
  /** First block to scan when the store has no cursor: the deployment's block. */
  startBlock: bigint;
  /** Reads for the per-wallet slash notice (a slash paid into a vault a watched wallet is in). */
  wallet?: { reader: Pick<WalletReader, "claimables">; usdgDecimals: number };
}

/** Per-wallet alerts (/watch): how often to look, and what each chat has been told. */
export interface WatchOptions {
  tracker: WatchTracker;
  intervalMs: number;
  appUrl?: string;
}

export interface BotDeps {
  api: TelegramApi;
  store: StateStore;
  /** Every deployment the commands read. */
  targets: readonly CommandTarget[];
  /** Every deployment the alert loop scans (one cursor each; the subscribers are shared). */
  sources: readonly AlertSource[];
  pollIntervalMs: number;
  botUsername?: string;
  log: (message: string) => void;
  send?: SendOptions;
  /** /watch alerts; absent, the commands say they are not available and no watch loop runs. */
  watch?: WatchOptions;
}

// Alerts sent by this process, by deployment, transaction and log index: a chunk whose cursor save failed (or an
// RPC that serves an old block range twice) never sends the same alert twice. Bounded; the cursor does the rest.
const SEEN_LIMIT = 5000;
const seenByStore = new WeakMap<StateStore, Set<string>>();

function cursorOf(d: BotDeps, s: AlertSource): bigint | null {
  return s.primary ? d.store.cursor : d.store.cursorOf(s.key);
}

async function setCursor(d: BotDeps, s: AlertSource, next: bigint): Promise<void> {
  if (s.primary) await d.store.setCursor(next);
  else await d.store.setCursorOf(s.key, next);
}

/** One alert pass over one deployment: scan from its cursor to its head and broadcast each alert. */
async function pollSource(d: BotDeps, s: AlertSource, freshStore: boolean): Promise<number> {
  const head = await s.getBlockNumber();
  let from = cursorOf(d, s);
  if (from === null) {
    // A deployment the stored state has never scanned. On a fresh store every deployment catches up from its
    // deploy block (as the first start always did). Next to an existing cursor (an upgrade from the one-deployment
    // bot) it starts at the head: the subscribers get alerts from now on, not the older deployments' history.
    from = !s.primary && !freshStore ? head : s.startBlock;
    if (!s.primary) await setCursor(d, s, from);
  }
  if (from > head) return 0;
  const seen = seenByStore.get(d.store) ?? new Set<string>();
  seenByStore.set(d.store, seen);
  return processRange(
    from,
    head,
    s.pipeline,
    async (text, alert) => {
      const id = `${s.key}:${alert.txHash}:${alert.logIndex}`;
      if (seen.has(id)) return;
      if (seen.size >= SEEN_LIMIT) seen.delete(seen.values().next().value as string);
      seen.add(id);
      await notifyWatchersOfSlash(d, s, alert);
      const chats = d.store.subscribers;
      if (chats.length === 0) return;
      const r = await broadcast(d.api, chats, text, {
        ...d.send,
        onGone: (id) => d.store.unsubscribe(id),
        log: d.log,
      });
      d.log(
        `${s.label}: ${alert.name} (block ${alert.blockNumber}) sent to ${r.sent.length}/${chats.length} chat(s)`,
      );
    },
    (next) => setCursor(d, s, next),
  );
}

/** A slash paid into a vault: tell each chat watching a wallet that is in that vault. */
async function notifyWatchersOfSlash(d: BotDeps, s: AlertSource, alert: Parameters<typeof slashItems>[0]) {
  if (!d.watch || !s.wallet || alert.name !== "ProposalRejected" || alert.slashed === 0n) return;
  const watchers = d.store.watchers();
  if (watchers.size === 0) return;
  const items = await slashItems(
    alert,
    s.wallet.reader,
    [...watchers.keys()] as Address[],
    s.label,
    s.key,
    s.wallet.usdgDecimals,
  );
  for (const [address, item] of items) {
    for (const chat of watchers.get(address) ?? []) {
      const fresh = d.watch.tracker.fresh(chat, address, [item], false);
      if (!fresh.length) continue;
      try {
        await sendWithRetry(d.api, chat, watchAlertText(address, fresh, d.watch.appUrl), d.send);
      } catch (err) {
        d.log(`slash notice to chat ${chat} failed: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * One /watch pass: read each watched wallet on every deployment and send each chat watching it the items it has not
 * been told about. Returns the messages sent. A wallet whose reads fail on some deployment keeps its other items.
 */
export async function pollWatchesOnce(d: BotDeps): Promise<number> {
  if (!d.watch) return 0;
  const watchers = d.store.watchers();
  let sent = 0;
  for (const [address, chats] of watchers) {
    const { views, errors } = await walletViews(d.targets, address as Address);
    const items = views.flatMap((v) => v.items);
    for (const e of errors) d.log(`watch ${address}: ${e}`);
    for (const chat of chats) {
      // Prune forgotten items only when every deployment answered (a failed read is not "the item went away").
      const fresh = d.watch.tracker.fresh(chat, address, items, errors.length === 0);
      if (!fresh.length) continue;
      try {
        await sendWithRetry(d.api, chat, watchAlertText(address as Address, fresh, d.watch.appUrl), d.send);
        sent += 1;
        d.log(`watch ${address}: ${fresh.length} item(s) sent to chat ${chat}`);
      } catch (err) {
        // A chat that blocked the bot or no longer exists stops watching.
        if (err instanceof TelegramError && err.code === 403) await d.store.unwatch(chat, null);
        d.log(`watch alert to chat ${chat} failed: ${(err as Error).message}`);
      }
    }
  }
  return sent;
}

/**
 * One alert pass: scan every deployment from its cursor to its head and broadcast each alert. Returns alerts
 * delivered. A deployment that fails does not hold up the others; the first failure is thrown once all have run.
 */
export async function pollAlertsOnce(d: BotDeps): Promise<number> {
  let delivered = 0;
  let failure: unknown;
  const freshStore = d.store.cursor === null; // before the primary deployment's first chunk sets it
  for (const s of d.sources) {
    try {
      delivered += await pollSource(d, s, freshStore);
    } catch (err) {
      d.log(`${s.label}: alert pass failed: ${(err as Error).message.split("\n")[0]}`);
      failure ??= err;
    }
  }
  if (failure !== undefined) throw failure;
  return delivered;
}

/** Answer one update. Non-commands are ignored; a failed reply is logged, never thrown. */
export async function handleUpdate(update: TelegramUpdate, d: BotDeps): Promise<void> {
  const msg = update.message;
  if (!msg) return;
  const cmd = parseCommand(msg.text, d.botUsername);
  if (!cmd) return;
  const ctx: CommandContext = {
    targets: d.targets,
    subscriptions: d.store,
    chatId: msg.chat.id,
    watches: d.watch ? { store: d.store, tracker: d.watch.tracker, appUrl: d.watch.appUrl } : undefined,
  };
  const reply = await runCommand(cmd, ctx);
  try {
    await sendWithRetry(d.api, msg.chat.id, reply, d.send);
  } catch (err) {
    d.log(`reply to chat ${msg.chat.id} failed: ${(err as Error).message}`);
  }
}

/** One long poll: fetch updates after the stored offset, answer each, and advance the offset. */
export async function pollUpdatesOnce(
  d: BotDeps,
  timeoutSeconds = 30,
  signal?: AbortSignal,
): Promise<number> {
  const updates = await d.api.getUpdates(d.store.updateOffset, timeoutSeconds, signal);
  for (const update of updates) {
    await handleUpdate(update, d);
    await d.store.setUpdateOffset(update.update_id + 1);
  }
  return updates.length;
}

/** Run the alert loop and the command loop until `signal` aborts. */
export async function runBot(d: BotDeps, signal: AbortSignal): Promise<void> {
  const alerts = async () => {
    while (!signal.aborted) {
      try {
        await pollAlertsOnce(d);
      } catch (err) {
        d.log(`alert pass failed, retrying next poll: ${(err as Error).message.split("\n")[0]}`);
      }
      await sleep(d.pollIntervalMs, signal);
    }
  };
  const commands = async () => {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await pollUpdatesOnce(d, 30, signal);
        failures = 0;
      } catch (err) {
        if (signal.aborted) break;
        failures += 1;
        d.log(`getUpdates failed: ${(err as Error).message}`);
        await sleep(backoffMs(failures, 1000), signal);
      }
    }
  };
  const watches = async () => {
    if (!d.watch) return;
    while (!signal.aborted) {
      try {
        await pollWatchesOnce(d);
      } catch (err) {
        d.log(`watch pass failed, retrying next time: ${(err as Error).message.split("\n")[0]}`);
      }
      await sleep(d.watch.intervalMs, signal);
    }
  };
  await Promise.all([alerts(), commands(), watches()]);
}
