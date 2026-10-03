import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AlertSource, type BotDeps, pollAlertsOnce, pollUpdatesOnce } from "../src/bot.js";
import { AlertBuilder, type ChainReader, type DecodedLog } from "../src/logs.js";
import { StateStore } from "../src/store.js";
import { type FetchFn, TelegramError, broadcast, createTelegramApi, sendWithRetry } from "../src/telegram.js";
import { CC_SERIES_STATE, CC_VAULT, CSP_VAULT, FORMAT, REAL_LOGS, targetV2, vaultState } from "./fixtures.js";

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

  function source(logs: DecodedLog[], head = 126_302_600n, over: Partial<AlertSource> = {}): AlertSource {
    return {
      key: "46630:0x5a3b58df27e4dd5e0fa6493d90ff653e0e199c99",
      label: "Robinhood Chain testnet · v2",
      primary: true,
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
      ...over,
    };
  }

  function deps(store: StateStore, api: BotDeps["api"], logs: DecodedLog[], head = 126_302_600n): BotDeps {
    return depsFor(store, api, [source(logs, head)]);
  }

  function depsFor(store: StateStore, api: BotDeps["api"], sources: AlertSource[]): BotDeps {
    return {
      api,
      store,
      targets: [targetV2()],
      sources,
      pollIntervalMs: 10,
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
    d.sources[0]!.pipeline.fetchLogs = vi.fn(async () => {
      throw new Error("503 Service Unavailable");
    });
    d.sources[0]!.pipeline.retries = 1;
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

  describe("alerts from every deployment", () => {
    const V3_KEY = "46630:0x256d4546486368dcb23e94758b4cb500c215929f";
    const SEP_KEY = "421614:0xb8ed17588ab022d8f84b8305d784fa01478cb7f0";
    const V3_LOG: DecodedLog = {
      ...REAL_LOGS[0]!,
      transactionHash: `0x${"d4".repeat(32)}`,
      blockNumber: 126_800_010n,
    } as DecodedLog;
    const SEP_LOG: DecodedLog = {
      ...REAL_LOGS[0]!,
      transactionHash: `0x${"e5".repeat(32)}`,
      blockNumber: 315_000_010n,
    } as DecodedLog;

    const v3Source = (head = 126_800_100n, over: Partial<AlertSource> = {}) =>
      source([V3_LOG], head, {
        key: V3_KEY,
        label: "Robinhood Chain testnet · v3",
        primary: false,
        startBlock: 126_713_718n,
        ...over,
      });
    const sepoliaSource = (head = 315_000_100n, over: Partial<AlertSource> = {}) =>
      source([SEP_LOG], head, {
        key: SEP_KEY,
        label: "Arbitrum Sepolia · v3",
        primary: false,
        startBlock: 314_350_623n,
        ...over,
      });

    it("sends each deployment's alerts to the same subscribers, with its own cursor", async () => {
      const store = await StateStore.open(dir, 46630);
      await store.subscribe(11);
      const { calls, api } = fakeTelegram();
      const d = depsFor(store, api, [source(REAL_LOGS.slice(0, 1)), v3Source(), sepoliaSource()]);

      // A fresh store: every deployment catches up from its own deploy block.
      expect(await pollAlertsOnce(d)).toBe(3);
      expect(sent(calls).map((m) => m.chat_id)).toEqual([11, 11, 11]);
      expect(store.cursor).toBe(126_302_601n);
      expect(store.cursorOf(V3_KEY)).toBe(126_800_101n);
      expect(store.cursorOf(SEP_KEY)).toBe(315_000_101n);

      // Nothing new on any deployment: no repeats.
      expect(await pollAlertsOnce(d)).toBe(0);
      expect(sent(calls)).toHaveLength(3);

      // The cursors survive a restart, in the same state file.
      const again = await StateStore.open(dir, 46630);
      expect(again.cursor).toBe(126_302_601n);
      expect(again.cursorOf(V3_KEY)).toBe(126_800_101n);
      expect(again.cursorOf(SEP_KEY)).toBe(315_000_101n);
    });

    it("names the deployment in an alert when the pipeline has a label", async () => {
      const store = await StateStore.open(dir, 46630);
      await store.subscribe(11);
      const { calls, api } = fakeTelegram();
      const labelled = v3Source();
      labelled.pipeline.format = { ...FORMAT, label: "Robinhood Chain testnet · v3" };
      await pollAlertsOnce(depsFor(store, api, [labelled]));
      const lines = (sent(calls)[0]?.text as string).split("\n");
      expect(lines.at(-2)).toBe("Deployment: Robinhood Chain testnet · v3");
      expect(lines.at(-1)).toMatch(/^Tx: https:\/\/explorer\.testnet\.chain\.robinhood\.com\/tx\/0xd4d4/);
    });

    it("upgrading an existing store: new deployments start at their head, not at their history", async () => {
      // The one-deployment bot's state file: a cursor, one subscriber, no per-deployment cursors.
      const store = await StateStore.open(dir, 46630);
      await store.subscribe(11);
      await store.setCursor(126_302_000n);
      const { calls, api } = fakeTelegram();
      const d = depsFor(store, api, [source([]), v3Source(), sepoliaSource()]);

      expect(await pollAlertsOnce(d)).toBe(0);
      expect(sent(calls)).toHaveLength(0);
      expect(store.cursor).toBe(126_302_601n);
      // v3's alert at block 126800010 is older than its head (126800100): skipped, and the cursor moves on.
      expect(store.cursorOf(V3_KEY)).toBe(126_800_101n);

      // From now on a new alert on a new deployment is sent.
      const newer = {
        ...V3_LOG,
        transactionHash: `0x${"f6".repeat(32)}`,
        blockNumber: 126_800_150n,
      } as DecodedLog;
      const live = v3Source(126_800_200n);
      live.pipeline.fetchLogs = async (from, to) =>
        [newer].filter((l) => l.blockNumber >= from && l.blockNumber <= to);
      expect(await pollAlertsOnce(depsFor(store, api, [source([]), live, sepoliaSource()]))).toBe(1);
      expect(sent(calls)).toHaveLength(1);
    });

    it("keeps the legacy cursor field for the primary deployment and writes cursors only for the rest", async () => {
      const store = await StateStore.open(dir, 46630);
      await store.setCursor(5n);
      expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual({
        version: 1,
        chainId: 46630,
        cursor: "5",
        updateOffset: 0,
        subscribers: [],
      });
      await store.setCursorOf(V3_KEY, 7n);
      expect(JSON.parse(await readFile(store.path, "utf8")).cursors).toEqual({ [V3_KEY]: "7" });
    });

    it("never sends the same alert twice, even if a cursor save is lost", async () => {
      const store = await StateStore.open(dir, 46630);
      await store.subscribe(11);
      const { calls, api } = fakeTelegram();
      const d = depsFor(store, api, [v3Source(), sepoliaSource()]);
      await pollAlertsOnce(d);
      expect(sent(calls)).toHaveLength(2);
      // Rewind the cursors, as a crash between the broadcast and the save would.
      await store.setCursorOf(V3_KEY, 126_713_718n);
      await store.setCursorOf(SEP_KEY, 314_350_623n);
      expect(await pollAlertsOnce(d)).toBe(2); // scanned again ...
      expect(sent(calls)).toHaveLength(2); // ... but nothing re-sent
    });

    it("one deployment failing does not hold up the others, and keeps its own cursor", async () => {
      const store = await StateStore.open(dir, 46630);
      await store.subscribe(11);
      await store.setCursor(126_302_000n);
      await store.setCursorOf(V3_KEY, 126_800_000n);
      const { calls, api } = fakeTelegram();
      const failing = v3Source();
      failing.pipeline.fetchLogs = async () => {
        throw new Error("503 Service Unavailable");
      };
      failing.pipeline.retries = 0;
      const d = depsFor(store, api, [failing, sepoliaSource()]);
      await store.setCursorOf(SEP_KEY, 315_000_000n);
      await expect(pollAlertsOnce(d)).rejects.toThrow(/503/);
      expect(sent(calls)).toHaveLength(1); // Arbitrum Sepolia's alert went out
      expect(store.cursorOf(V3_KEY)).toBe(126_800_000n);
      expect(store.cursorOf(SEP_KEY)).toBe(315_000_101n);
    });
  });
});
