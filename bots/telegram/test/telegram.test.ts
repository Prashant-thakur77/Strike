import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BotDeps, pollAlertsOnce, pollUpdatesOnce } from "../src/bot.js";
import type { StrikeReader } from "../src/commands.js";
import { AlertBuilder, type ChainReader, type DecodedLog } from "../src/logs.js";
import { StateStore } from "../src/store.js";
import { type FetchFn, TelegramError, broadcast, createTelegramApi, sendWithRetry } from "../src/telegram.js";
import { CC_SERIES_STATE, CC_VAULT, CSP_VAULT, FORMAT, REAL_LOGS, vaultState } from "./fixtures.js";

const TOKEN = "123456:TEST-token_abcdefghijklmnopqrstuvwxyz";

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** A fake Bot API: records every call and answers with `reply(method, body)`. */
function fakeTelegram(
  reply: (call: Call, n: number) => { status?: number; body: unknown } | Error = () => ({
    body: { ok: true, result: true },
  }),
) {
  const calls: Call[] = [];
  const fetch: FetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    expect(init?.method).toBe("POST");
    const call = { method: url.split("/").pop() as string, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const r = reply(call, calls.length);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return { calls, fetch, api: createTelegramApi({ token: TOKEN, fetch }) };
}

const noSleep = vi.fn(async () => undefined);
const sent = (calls: Call[]) => calls.filter((c) => c.method === "sendMessage").map((c) => c.body);

describe("Telegram API client", () => {
  it("sends plain-text messages with link previews off", async () => {
    const { calls, api } = fakeTelegram();
    await api.sendMessage(42, "hello");
    expect(calls).toEqual([
      {
        method: "sendMessage",
        body: { chat_id: 42, text: "hello", link_preview_options: { is_disabled: true } },
      },
    ]);
  });

  it("turns ok:false into a TelegramError with the code and retry_after, never echoing the token", async () => {
    const { api } = fakeTelegram(() => ({
      status: 429,
      body: {
        ok: false,
        error_code: 429,
        description: `Too Many Requests for bot${TOKEN}`,
        parameters: { retry_after: 3 },
      },
    }));
    const err = await api.sendMessage(1, "x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).code).toBe(429);
    expect((err as TelegramError).retryAfter).toBe(3);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).toContain("<token>");
  });

  it("reports network failures as code 0 without the URL", async () => {
    const { api } = fakeTelegram(() => new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/x`));
    const err = (await api.getMe().catch((e: unknown) => e)) as TelegramError;
    expect(err.code).toBe(0);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe("sendWithRetry", () => {
  beforeEach(() => noSleep.mockClear());

  it("waits out a 429 retry_after, then sends", async () => {
    const { calls, api } = fakeTelegram((_c, n) =>
      n === 1
        ? {
            status: 429,
            body: {
              ok: false,
              error_code: 429,
              description: "Too Many Requests",
              parameters: { retry_after: 2 },
            },
          }
        : { body: { ok: true, result: {} } },
    );
    await sendWithRetry(api, 5, "hi", { sleep: noSleep });
    expect(calls).toHaveLength(2);
    expect(noSleep).toHaveBeenCalledWith(2000);
  });

  it("backs off on 5xx and network errors, then gives up", async () => {
    const { calls, api } = fakeTelegram(() => ({
      status: 502,
      body: { ok: false, error_code: 502, description: "Bad Gateway" },
    }));
    await expect(
      sendWithRetry(api, 5, "hi", { sleep: noSleep, retries: 2, baseDelayMs: 100 }),
    ).rejects.toThrow(/502/);
    expect(calls).toHaveLength(3);
    expect(noSleep.mock.calls).toEqual([[100], [200]]);
  });

  it("does not retry a 403 (bot blocked)", async () => {
    const { calls, api } = fakeTelegram(() => ({
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    }));
    await expect(sendWithRetry(api, 5, "hi", { sleep: noSleep })).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });

  it("splits a message longer than 4096 characters", async () => {
    const { calls, api } = fakeTelegram();
    const long = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(60, ".")).join("\n");
    await sendWithRetry(api, 5, long, { sleep: noSleep });
    const texts = sent(calls).map((b) => b.text as string);
    expect(texts).toHaveLength(2);
    expect(texts.every((t) => t.length <= 4096)).toBe(true);
    expect(texts.join("\n")).toBe(long);
  });
});

describe("broadcast", () => {
  it("sends to every chat, drops blocked chats, and skips failures without stopping", async () => {
    const { calls, api } = fakeTelegram((c) => {
      if (c.body.chat_id === 2)
        return {
          status: 403,
          body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
        };
      if (c.body.chat_id === 3)
        return {
          status: 400,
          body: { ok: false, error_code: 400, description: "Bad Request: message is too long" },
        };
      return { body: { ok: true, result: {} } };
    });
    const onGone = vi.fn(async () => undefined);
    const log = vi.fn();
    const r = await broadcast(api, [1, 2, 3, 4], "alert", { onGone, log, sleep: noSleep });
    expect(r).toEqual({ sent: [1, 4], failed: [3], removed: [2] });
    expect(onGone).toHaveBeenCalledWith(2);
    expect(sent(calls).map((b) => b.chat_id)).toEqual([1, 2, 3, 4]);
    expect(log).toHaveBeenCalledTimes(2);
  });
});

describe("bot loops against a fake Telegram API", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "strike-bot-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const reader: ChainReader = {
    getVault: vi.fn(async (a) => vaultState(a === CC_VAULT.address ? CC_VAULT : CSP_VAULT)),
    getSeries: vi.fn(async () => CC_SERIES_STATE),
  };

  function deps(store: StateStore, api: BotDeps["api"], logs: DecodedLog[], head = 126_302_600n): BotDeps {
    return {
      api,
      store,
      strike: { chainId: 46630 } as unknown as StrikeReader,
      pipeline: {
        fetchLogs: vi.fn(async (from: bigint, to: bigint) =>
          logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to),
        ),
        builder: new AlertBuilder(reader),
        format: FORMAT,
        maxRange: 100_000n,
        sleep: noSleep,
      },
      getBlockNumber: async () => head,
      startBlock: 125_880_607n,
      pollIntervalMs: 10,
      usdgDecimals: 6,
      botUsername: "StrikeAlertsBot",
      log: () => undefined,
      send: { sleep: noSleep },
    };
  }

  it("broadcasts each alert to each subscriber and advances the cursor to head + 1", async () => {
    const store = await StateStore.open(dir, 46630);
    await store.subscribe(11);
    await store.subscribe(22);
    const { calls, api } = fakeTelegram();
    const d = deps(store, api, REAL_LOGS);

    expect(await pollAlertsOnce(d)).toBe(4);
    const msgs = sent(calls);
    expect(msgs).toHaveLength(8);
    expect(msgs.map((m) => m.chat_id)).toEqual([11, 22, 11, 22, 11, 22, 11, 22]);
    expect((msgs[4]?.text as string).split("\n")[0]).toBe(
      "sTSLA-CSP: agent 1 proposal rejected, DeltaOutOfBand (epoch 1)",
    );
    expect((msgs[6]?.text as string).split("\n")[0]).toBe("sTSLA-CC: 4 TSLA calls bought for 10.005944 USDG");
    expect(store.cursor).toBe(126_302_601n);

    // Nothing new: no messages, cursor unchanged. And the cursor survives a restart.
    expect(await pollAlertsOnce(d)).toBe(0);
    expect(sent(calls)).toHaveLength(8);
    expect((await StateStore.open(dir, 46630)).cursor).toBe(126_302_601n);
  });

  it("unsubscribes a chat that blocked the bot while alerting the others", async () => {
    const store = await StateStore.open(dir, 46630);
    await store.subscribe(11);
    await store.subscribe(22);
    const { api } = fakeTelegram((c) =>
      c.body.chat_id === 22
        ? {
            status: 403,
            body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
          }
        : { body: { ok: true, result: {} } },
    );
    await pollAlertsOnce(deps(store, api, REAL_LOGS.slice(0, 1)));
    expect(store.subscribers).toEqual([11]);
  });

  it("does not advance the cursor when the log fetch keeps failing", async () => {
    const store = await StateStore.open(dir, 46630);
    await store.setCursor(126_000_000n);
    const { api } = fakeTelegram();
    const d = deps(store, api, []);
    d.pipeline.fetchLogs = vi.fn(async () => {
      throw new Error("503 Service Unavailable");
    });
    d.pipeline.retries = 1;
    await expect(pollAlertsOnce(d)).rejects.toThrow(/503/);
    expect(store.cursor).toBe(126_000_000n);
  });

  it("answers commands from getUpdates, records /subscribe, and advances the offset", async () => {
    const store = await StateStore.open(dir, 46630);
    const { calls, api } = fakeTelegram((c) => {
      if (c.method === "getUpdates") {
        return {
          body: {
            ok: true,
            result: [
              {
                update_id: 500,
                message: { message_id: 1, chat: { id: 7, type: "private" }, text: "/subscribe" },
              },
              { update_id: 501, message: { message_id: 2, chat: { id: 8, type: "group" }, text: "gm" } },
              {
                update_id: 502,
                message: { message_id: 3, chat: { id: 8, type: "group" }, text: "/help@OtherBot" },
              },
              {
                update_id: 503,
                message: { message_id: 4, chat: { id: 8, type: "group" }, text: "/help@StrikeAlertsBot" },
              },
            ],
          },
        };
      }
      return { body: { ok: true, result: {} } };
    });
    const d = deps(store, api, []);
    expect(await pollUpdatesOnce(d, 0)).toBe(4);
    expect(calls[0]).toEqual({
      method: "getUpdates",
      body: { offset: 0, timeout: 0, allowed_updates: ["message"] },
    });
    expect(store.subscribers).toEqual([7]);
    expect(store.updateOffset).toBe(504);
    const replies = sent(calls);
    expect(replies.map((r) => r.chat_id)).toEqual([7, 8]);
    expect(replies[0]?.text).toMatch(/^Subscribed/);
    expect(replies[1]?.text).toContain("/quote <vault> [amount]");

    await pollUpdatesOnce(d, 0);
    expect(calls.filter((c) => c.method === "getUpdates")[1]?.body.offset).toBe(504);
  });
});
