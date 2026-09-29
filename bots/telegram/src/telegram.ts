import { splitMessage } from "./format.js";
import { type Sleep, backoffMs, sleep as defaultSleep } from "./retry.js";

/** The parts of a Telegram `Update` the bot reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    text?: string;
  };
}

/** A Bot API error (`ok: false`) or a transport failure (`code` 0). */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface TelegramApi {
  getMe(): Promise<{ id: number; username?: string }>;
  getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
}

/**
 * A minimal Bot API client over `fetch` (POST + JSON). Errors never include the token: the request URL is
 * never put in a message, and any echo of the token is redacted.
 */
export function createTelegramApi(opts: { token: string; fetch?: FetchFn; baseUrl?: string }): TelegramApi {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = `${opts.baseUrl ?? "https://api.telegram.org"}/bot${opts.token}`;
  const redact = (s: string) => (opts.token ? s.split(opts.token).join("<token>") : s);

  async function call<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TelegramError(
        `${method}: network error (${redact((err as Error).message ?? String(err))})`,
        0,
      );
    }
    let body: {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramError(`${method}: HTTP ${res.status} with a non-JSON body`, res.status);
    }
    if (!body.ok) {
      throw new TelegramError(
        `${method}: ${body.error_code ?? res.status} ${redact(body.description ?? "request failed")}`,
        body.error_code ?? res.status,
        body.parameters?.retry_after,
      );
    }
    return body.result as T;
  }

  return {
    getMe: () => call<{ id: number; username?: string }>("getMe", {}),
    getUpdates: (offset, timeoutSeconds, signal) =>
      call<TelegramUpdate[]>(
        "getUpdates",
        { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
        signal,
      ),
    async sendMessage(chatId, text) {
      await call("sendMessage", {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
      });
    },
  };
}

/** Errors that will not go away by retrying: the chat blocked the bot, left, or does not exist. */
export function isChatGone(err: unknown): boolean {
  if (!(err instanceof TelegramError)) return false;
  if (err.code === 403) return true;
  return err.code === 400 && /chat not found|user is deactivated|group chat was upgraded/i.test(err.message);
}

export interface SendOptions {
  /** Attempts after the first for rate limits (429), 5xx and network errors (default 3). */
  retries?: number;
  baseDelayMs?: number;
  sleep?: Sleep;
}

/**
 * Send one message (split if longer than Telegram's limit). Waits out `retry_after` on 429 and backs off on
 * 5xx and network errors; any other error (403, 400) is thrown at once.
 */
export async function sendWithRetry(
  api: TelegramApi,
  chatId: number,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? defaultSleep;
  for (const part of splitMessage(text)) {
    for (let attempt = 1; ; attempt++) {
      try {
        await api.sendMessage(chatId, part);
        break;
      } catch (err) {
        const retryable =
          err instanceof TelegramError && (err.code === 429 || err.code === 0 || err.code >= 500);
        if (!retryable || attempt > retries) throw err;
        const wait =
          err.code === 429 && err.retryAfter !== undefined
            ? err.retryAfter * 1000
            : backoffMs(attempt, opts.baseDelayMs ?? 1000);
        await sleep(wait);
      }
    }
  }
}

export interface BroadcastResult {
  sent: number[];
  failed: number[];
  /** Chats removed because they blocked the bot or no longer exist. */
  removed: number[];
}

/**
 * Send `text` to every chat in `chatIds`, one after another (a short gap keeps well under Telegram's ~30
 * messages per second). Chats that blocked the bot are passed to `onGone`; other failures are logged and skipped
 * so one bad chat never holds up the rest.
 */
export async function broadcast(
  api: TelegramApi,
  chatIds: readonly number[],
  text: string,
  opts: SendOptions & {
    onGone?: (chatId: number) => Promise<unknown>;
    log?: (message: string) => void;
    gapMs?: number;
  } = {},
): Promise<BroadcastResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const result: BroadcastResult = { sent: [], failed: [], removed: [] };
  for (const [i, chatId] of [...chatIds].entries()) {
    if (i > 0 && (opts.gapMs ?? 50) > 0) await sleep(opts.gapMs ?? 50);
    try {
      await sendWithRetry(api, chatId, text, opts);
      result.sent.push(chatId);
    } catch (err) {
      if (isChatGone(err)) {
        result.removed.push(chatId);
        await opts.onGone?.(chatId);
        opts.log?.(`chat ${chatId} is gone (${(err as Error).message}); unsubscribed`);
      } else {
        result.failed.push(chatId);
        opts.log?.(`could not send to chat ${chatId}: ${(err as Error).message}`);
      }
    }
  }
  return result;
}
