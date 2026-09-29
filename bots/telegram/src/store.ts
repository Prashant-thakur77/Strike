import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What the bot persists between restarts. */
export interface BotState {
  version: 1;
  chainId: number;
  /** Next block to scan for alerts (null: start at the deploy block). */
  cursor: string | null;
  /** Next Telegram update id to ask for (getUpdates offset). */
  updateOffset: number;
  /** Chat ids that receive alerts. */
  subscribers: number[];
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
    const snapshot = `${JSON.stringify(this.state, null, 2)}\n`;
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
