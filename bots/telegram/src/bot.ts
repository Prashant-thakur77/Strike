import { type AlertPipeline, processRange } from "./alerts.js";
import { type CommandContext, type StrikeReader, parseCommand, runCommand } from "./commands.js";
import { backoffMs, sleep } from "./retry.js";
import type { StateStore } from "./store.js";
import {
  type SendOptions,
  type TelegramApi,
  type TelegramUpdate,
  broadcast,
  sendWithRetry,
} from "./telegram.js";

export interface BotDeps {
  api: TelegramApi;
  store: StateStore;
  strike: StrikeReader;
  pipeline: AlertPipeline;
  /** Chain head, for the alert loop. */
  getBlockNumber: () => Promise<bigint>;
  /** First block to scan when the store has no cursor. */
  startBlock: bigint;
  pollIntervalMs: number;
  usdgDecimals: number;
  botUsername?: string;
  log: (message: string) => void;
  send?: SendOptions;
}

/** One alert pass: scan from the cursor to the head and broadcast each alert. Returns alerts delivered. */
export async function pollAlertsOnce(d: BotDeps): Promise<number> {
  const head = await d.getBlockNumber();
  const from = d.store.cursor ?? d.startBlock;
  if (from > head) return 0;
  return processRange(
    from,
    head,
    d.pipeline,
    async (text, alert) => {
      const chats = d.store.subscribers;
      if (chats.length === 0) return;
      const r = await broadcast(d.api, chats, text, {
        ...d.send,
        onGone: (id) => d.store.unsubscribe(id),
        log: d.log,
      });
      d.log(`${alert.name} (block ${alert.blockNumber}) sent to ${r.sent.length}/${chats.length} chat(s)`);
    },
    (next) => d.store.setCursor(next),
  );
}

/** Answer one update. Non-commands are ignored; a failed reply is logged, never thrown. */
export async function handleUpdate(update: TelegramUpdate, d: BotDeps): Promise<void> {
  const msg = update.message;
  if (!msg) return;
  const cmd = parseCommand(msg.text, d.botUsername);
  if (!cmd) return;
  const ctx: CommandContext = {
    strike: d.strike,
    subscriptions: d.store,
    chatId: msg.chat.id,
    usdgDecimals: d.usdgDecimals,
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
