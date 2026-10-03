import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../src/store.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "strike-bot-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("StateStore", () => {
  it("starts empty and creates the data dir", async () => {
    const store = await StateStore.open(join(dir, "nested", "data"), 46630);
    expect(store.cursor).toBeNull();
    expect(store.updateOffset).toBe(0);
    expect(store.subscribers).toEqual([]);
    expect(store.path).toBe(join(dir, "nested", "data", "state-46630.json"));
  });

  it("persists subscribers, the cursor and the update offset across reopen", async () => {
    const store = await StateStore.open(dir, 46630);
    expect(await store.subscribe(111)).toBe(true);
    expect(await store.subscribe(-100222)).toBe(true);
    expect(await store.subscribe(111)).toBe(false);
    await store.setCursor(126_332_565n);
    await store.setUpdateOffset(7);

    const again = await StateStore.open(dir, 46630);
    expect(again.subscribers).toEqual([111, -100222]);
    expect(again.cursor).toBe(126_332_565n);
    expect(again.updateOffset).toBe(7);

    expect(await again.unsubscribe(111)).toBe(true);
    expect(await again.unsubscribe(111)).toBe(false);
    expect((await StateStore.open(dir, 46630)).subscribers).toEqual([-100222]);
  });

  it("keeps one file per chain", async () => {
    const test = await StateStore.open(dir, 46630);
    await test.subscribe(1);
    const main = await StateStore.open(dir, 4663);
    expect(main.subscribers).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(["state-46630.json"]);
  });

  it("stores the cursor as a decimal string (block numbers can exceed 2^53 in principle)", async () => {
    const store = await StateStore.open(dir, 46630);
    await store.setCursor(9_007_199_254_740_993n);
    const raw = JSON.parse(await readFile(store.path, "utf8"));
    expect(raw).toEqual({
      version: 1,
      chainId: 46630,
      cursor: "9007199254740993",
      updateOffset: 0,
      subscribers: [],
    });
    expect((await StateStore.open(dir, 46630)).cursor).toBe(9_007_199_254_740_993n);
  });

  it("serialises concurrent saves and leaves no temp file", async () => {
    const store = await StateStore.open(dir, 46630);
    await Promise.all([
      store.subscribe(1),
      store.subscribe(2),
      store.setCursor(5n),
      store.setUpdateOffset(3),
    ]);
    expect(await readdir(dir)).toEqual(["state-46630.json"]);
    const again = await StateStore.open(dir, 46630);
    expect(again.subscribers).toEqual([1, 2]);
    expect(again.cursor).toBe(5n);
    expect(again.updateOffset).toBe(3);
  });

  it("drops invalid values from a hand-edited file", async () => {
    await writeFile(
      join(dir, "state-46630.json"),
      JSON.stringify({ cursor: "abc", updateOffset: 1.5, subscribers: [1, "2", 1, null, 3] }),
    );
    const store = await StateStore.open(dir, 46630);
    expect(store.cursor).toBeNull();
    expect(store.updateOffset).toBe(0);
    expect(store.subscribers).toEqual([1, 3]);
  });

  it("refuses to start over a corrupt file instead of silently losing subscribers", async () => {
    await writeFile(join(dir, "state-46630.json"), "{ not json");
    await expect(StateStore.open(dir, 46630)).rejects.toThrow(/cannot read/);
  });

  it("reads a state file from before per-deployment cursors, and keeps its fields on save", async () => {
    await writeFile(
      join(dir, "state-46630.json"),
      JSON.stringify({
        version: 1,
        chainId: 46630,
        cursor: "128057788",
        updateOffset: 932382290,
        subscribers: [7],
      }),
    );
    const store = await StateStore.open(dir, 46630);
    expect(store.cursor).toBe(128_057_788n);
    expect(store.cursorOf("46630:0xabc")).toBeNull();
    expect(store.subscribers).toEqual([7]);
    await store.subscribe(8);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual({
      version: 1,
      chainId: 46630,
      cursor: "128057788",
      updateOffset: 932382290,
      subscribers: [7, 8],
    });
  });

  it("stores per-deployment cursors by lower-case key and drops invalid ones", async () => {
    const store = await StateStore.open(dir, 46630);
    await store.setCursorOf("421614:0xABC", 9n);
    expect(store.cursorOf("421614:0xabc")).toBe(9n);
    expect((await StateStore.open(dir, 46630)).cursorOf("421614:0xAbC")).toBe(9n);
    await writeFile(
      join(dir, "state-421614.json"),
      JSON.stringify({ version: 1, chainId: 421614, cursors: { good: "5", bad: 5, worse: "x1" } }),
    );
    const hand = await StateStore.open(dir, 421614);
    expect(hand.cursorOf("good")).toBe(5n);
    expect(hand.cursorOf("bad")).toBeNull();
    expect(hand.cursorOf("worse")).toBeNull();
  });
});
