import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What the bot persists between restarts. */
export interface BotState {
  version: 1;
  chainId: number;
  /** Next block to scan for alerts on the primary chain's first deployment (null: start at the deploy block). */
  cursor: string | null;
  /**
   * Next block to scan for every other deployment, by `<chainId>:<EpochManager, lower case>`. Absent in files
   * written before the bot read every deployment; such files load as they were.
   */
  cursors?: Record<string, string>;
  /** Next Telegram update id to ask for (getUpdates offset). */
  updateOffset: number;
  /** Chat ids that receive alerts. */
  subscribers: number[];
  /**
   * Wallets each chat watches (/watch), by chat id: checksummed addresses, public chain data. Nothing else about a
   * wallet is stored. Absent in files written before /watch existed.
   */
  watches?: Record<string, string[]>;
}

/** Most wallets one chat may watch. */
export const MAX_WATCHES_PER_CHAT = 5;

function readWatches(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string[]> = {};
  for (const [chat, list] of Object.entries(raw)) {
    if (!/^-?\d+$/.test(chat) || !Array.isArray(list)) continue;
    const ok = [
      ...new Set(list.filter((a): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a))),
    ];
    if (ok.length) out[chat] = ok.slice(0, MAX_WATCHES_PER_CHAT);
  }
  return Object.keys(out).length ? out : undefined;
}

function readCursors(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && /^\d+$/.test(value)) out[key.toLowerCase()] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const empty = (chainId: number): BotState => ({
  version: 1,
  chainId,
  cursor: null,
  updateOffset: 0,
  subscribers: [],
});

/**
 * Subscribers, the log cursor and the Telegram update offset, in `<dataDir>/state-<chainId>.json`.
 * Writes go to a temporary file first and are renamed into place, so a crash never leaves a half-written file.
 * Saves are serialised, so the alert and command loops can both save safely.
 */
export class StateStore {
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    readonly path: string,
    private state: BotState,
  ) {}

  /** Load the state file for a chain, or start empty if there is none. */
  static async open(dataDir: string, chainId: number): Promise<StateStore> {
    await mkdir(dataDir, { recursive: true });
    const path = join(dataDir, `state-${chainId}.json`);
    let state = empty(chainId);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BotState>;
      state = {
        ...state,
        cursor: typeof parsed.cursor === "string" && /^\d+$/.test(parsed.cursor) ? parsed.cursor : null,
        updateOffset: Number.isInteger(parsed.updateOffset) ? (parsed.updateOffset as number) : 0,
        cursors: readCursors(parsed.cursors),
        watches: readWatches(parsed.watches),
        subscribers: Array.isArray(parsed.subscribers)
          ? [...new Set(parsed.subscribers.filter((id): id is number => Number.isSafeInteger(id)))]
          : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`cannot read ${path}: ${(err as Error).message}`);
      }
    }
    return new StateStore(path, state);
  }

  get cursor(): bigint | null {
    return this.state.cursor === null ? null : BigInt(this.state.cursor);
  }

  /** The next block to scan for a deployment other than the primary one (null: not scanned yet). */
  cursorOf(key: string): bigint | null {
    const raw = this.state.cursors?.[key.toLowerCase()];
    return raw === undefined ? null : BigInt(raw);
  }

  async setCursorOf(key: string, nextBlock: bigint): Promise<void> {
    this.state.cursors = { ...this.state.cursors, [key.toLowerCase()]: nextBlock.toString() };
    await this.save();
  }

  get updateOffset(): number {
    return this.state.updateOffset;
  }

  get subscribers(): readonly number[] {
    return this.state.subscribers;
  }

  isSubscribed(chatId: number): boolean {
    return this.state.subscribers.includes(chatId);
  }

  /** Add a chat. False if it was already subscribed. */
  async subscribe(chatId: number): Promise<boolean> {
    if (this.isSubscribed(chatId)) return false;
    this.state.subscribers = [...this.state.subscribers, chatId];
    await this.save();
    return true;
  }

  /** Remove a chat. False if it was not subscribed. */
  async unsubscribe(chatId: number): Promise<boolean> {
    if (!this.isSubscribed(chatId)) return false;
    this.state.subscribers = this.state.subscribers.filter((id) => id !== chatId);
    await this.save();
    return true;
  }

  /** The wallets a chat watches. */
  watchesOf(chatId: number): readonly string[] {
    return this.state.watches?.[String(chatId)] ?? [];
  }

  /** Every watched wallet and the chats watching it. */
  watchers(): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const [chat, list] of Object.entries(this.state.watches ?? {})) {
      for (const a of list) out.set(a, [...(out.get(a) ?? []), Number(chat)]);
    }
    return out;
  }

  /** Watch a wallet (checksummed address) in a chat. */
  async watch(chatId: number, address: string): Promise<"added" | "already" | "full"> {
    const list = this.watchesOf(chatId);
    if (list.some((a) => a.toLowerCase() === address.toLowerCase())) return "already";
    if (list.length >= MAX_WATCHES_PER_CHAT) return "full";
    this.state.watches = { ...this.state.watches, [String(chatId)]: [...list, address] };
    await this.save();
    return "added";
  }

  /** Stop watching one wallet, or every wallet (`address` null), in a chat. Returns how many were removed. */
  async unwatch(chatId: number, address: string | null): Promise<number> {
    const list = this.watchesOf(chatId);
    const keep = address === null ? [] : list.filter((a) => a.toLowerCase() !== address.toLowerCase());
    const removed = list.length - keep.length;
    if (removed === 0) return 0;
    const next = { ...this.state.watches };
    if (keep.length) next[String(chatId)] = keep;
    else delete next[String(chatId)];
    this.state.watches = next;
    await this.save();
    return removed;
  }

  async setCursor(nextBlock: bigint): Promise<void> {
    this.state.cursor = nextBlock.toString();
    await this.save();
  }

  async setUpdateOffset(offset: number): Promise<void> {
    if (offset === this.state.updateOffset) return;
    this.state.updateOffset = offset;
    await this.save();
  }

  /** Write the state atomically (temp file, then rename). */
  save(): Promise<void> {
    const { cursors, watches, ...rest } = this.state;
    const written = {
      ...rest,
      ...(cursors && Object.keys(cursors).length > 0 ? { cursors } : {}),
      ...(watches && Object.keys(watches).length > 0 ? { watches } : {}),
    };
    const snapshot = `${JSON.stringify(written, null, 2)}\n`;
    const tmp = `${this.path}.tmp`;
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.path);
      });
    return this.writing;
  }
}
