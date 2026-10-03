import { type AlertPipeline, processRange } from "./alerts.js";
import { type CommandContext, parseCommand, runCommand } from "./commands.js";
import { backoffMs, sleep } from "./retry.js";
import type { StateStore } from "./store.js";
import type { CommandTarget } from "./targets.js";
import {
  type SendOptions,
  type TelegramApi,
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
  await Promise.all([alerts(), commands()]);
}
