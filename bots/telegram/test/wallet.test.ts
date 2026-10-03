import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claimables, SeriesState, VaultState } from "@strike/sdk";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AlertSource, type BotDeps, pollAlertsOnce, pollWatchesOnce } from "../src/bot.js";
import { HELP, parseCommand, runCommand } from "../src/commands.js";
import { AlertBuilder, type ChainReader } from "../src/logs.js";
import { MAX_WATCHES_PER_CHAT, StateStore } from "../src/store.js";
import { type FetchFn, createTelegramApi } from "../src/telegram.js";
import type { CommandTarget } from "../src/targets.js";
import { WatchTracker, optionItems, vaultItems, type WalletSource } from "../src/wallet.js";
import {
  AFTER_EXPIRY,
  CC_SERIES_STATE,
  CC_VAULT,
  CSP_VAULT,
  DEPLOYER,
  FORMAT,
  REAL_LOGS,
  V3_CSP_VAULT,
  WAD,
  selling,
  targetV2,
  targetV3,
  vaultState,
} from "./fixtures.js";

// /watch, /unwatch and /status <address> (src/wallet.ts, the store's watch list, the watch loop in bot.ts). The
// wallet state is the deployer's on 3 October, as the dry run read it from the chains: 5 sTSLA-CC shares and 4 TSLA
// calls on v2 (the series expired Friday and waits for its settlement price), 60 sTSLA-CSP shares on v3 with
// 9.999999 USDG of premium to claim (the 1 October slash, paid to depositors).

const QA: Address = "0x7767ca2d944A91e6ae896f85cACA4DfDE1810044";
const none: Claimables = {
  premium: 0n,
  depositShares: 0n,
  redeemAssets: 0n,
  depositRequest: { epoch: 0n, amount: 0n },
  redeemRequest: { epoch: 0n, amount: 0n },
  shares: 0n,
};

type Book = Record<string, Partial<Claimables>>; // by `${vault}:${wallet}`, lower case

function walletSource(
  t: CommandTarget,
  book: Book,
  opts: { options?: Record<string, bigint>; series?: SeriesState[]; fail?: boolean } = {},
): WalletSource {
  return {
    reader: {
      listVaults: vi.fn(async () => {
        if (opts.fail) throw new Error("RPC down");
        return t.strike.listVaults();
      }),
      blockTimestamp: vi.fn(async () => t.strike.blockTimestamp()),
      claimables: vi.fn(async (vault: Address, who?: Address) => ({
        ...none,
        ...book[`${vault}:${who}`.toLowerCase()],
      })),
      optionBalance: vi.fn(
        async (id: bigint, who?: Address) => opts.options?.[`${id}:${who}`.toLowerCase()] ?? 0n,
      ),
      getSeries: vi.fn(async (id: bigint) => opts.series?.find((s) => s.id === id) ?? null),
    } as unknown as WalletSource["reader"],
    heldSeries: vi.fn(async () => (opts.series ?? []).map((s) => s.id)),
  };
}

const deployerBook = (): Book => ({
  [`${CC_VAULT.address}:${DEPLOYER}`.toLowerCase()]: { shares: 5n * WAD },
  [`${V3_CSP_VAULT.address}:${DEPLOYER}`.toLowerCase()]: { shares: 60_000_000n, premium: 9_999_999n },
});

function deployerTargets(book = deployerBook(), fail = false) {
  const v2 = targetV2();
  const v3 = targetV3();
  v2.wallet = walletSource(v2, book, {
    options: { [`${CC_SERIES_STATE.id}:${DEPLOYER}`.toLowerCase()]: 4n * WAD },
    series: [CC_SERIES_STATE],
  });
  v3.wallet = walletSource(v3, book, { fail });
  return [v2, v3];
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "strike-bot-wallet-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeTelegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetch: FetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: url.split("/").pop() as string, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
  });
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.body);
  return { api: createTelegramApi({ token: "1:TEST", fetch }), sent };
}

async function setup(targets = deployerTargets()) {
  const store = await StateStore.open(dir, 46630);
  const tracker = new WatchTracker();
  const run = (text: string, chatId = 7) =>
    runCommand(parseCommand(text)!, {
      targets,
      subscriptions: store,
      chatId,
      watches: { store, tracker, appUrl: "https://strike-options.vercel.app" },
    });
  return { store, tracker, run, targets };
}

describe("wallet items from chain state", () => {
  const v = vaultState(CSP_VAULT, { lastProcessedEpoch: 2n });
  it("premium, a processed queued deposit and a ready withdrawal, each with a stable key", () => {
    const x = vaultItems(
      "Robinhood Chain testnet · v2",
      "46630:em",
      v,
      {
        ...none,
        premium: 1_500_000n,
        depositShares: 5_000_000n,
        depositRequest: { epoch: 2n, amount: 5_000_000n },
        redeemAssets: 20_000_000n,
        redeemRequest: { epoch: 2n, amount: 20_000_000n },
      },
      AFTER_EXPIRY,
      6,
    );
    expect(x.items.map((i) => [i.kind, i.text])).toEqual([
      [
        "premium",
        "Premium ready to claim: 1.5 USDG from sTSLA-CSP (Robinhood Chain testnet · v2) (claimPremium).",
      ],
      [
        "deposit-processed",
        "Queued deposit processed: claim 5 sTSLA-CSP shares in sTSLA-CSP (Robinhood Chain testnet · v2) (claimDeposit).",
      ],
      [
        "withdrawal-ready",
        "Withdrawal ready: claim 20 USDG from sTSLA-CSP (Robinhood Chain testnet · v2) (claimRedeem).",
      ],
    ]);
    expect(x.items.map((i) => i.key)).toEqual([
      `46630:em:${CSP_VAULT.address.toLowerCase()}:premium:2`,
      `46630:em:${CSP_VAULT.address.toLowerCase()}:deposit:2`,
      `46630:em:${CSP_VAULT.address.toLowerCase()}:redeem:2`,
    ]);
  });

  it("a queued deposit still waiting is a position, not an item", () => {
    const x = vaultItems("L", "k", v, { ...none, depositRequest: { epoch: 3n, amount: 5_000_000n } }, 0n, 6);
    expect(x.items).toEqual([]);
    expect(x.positions).toEqual(["sTSLA-CSP (L): deposit of 5 USDG queued for epoch 3"]);
  });

  it("options: in the money at settlement, a cancelled series, waiting for the price; nothing when out of the money", () => {
    const vault = { symbol: "sTSLA-CC", underlyingSymbol: "TSLA", underlyingDecimals: 18 };
    const itm = optionItems(
      "L",
      "k",
      { ...CC_SERIES_STATE, settled: true, settlementPrice: 375n * WAD, payoutPerOption: WAD / 100n },
      vault,
      4n * WAD,
      AFTER_EXPIRY,
    );
    expect(itm.items[0]!.text).toBe(
      "In the money at settlement ($375.00): redeem your 4 TSLA calls at $369.86 (sTSLA-CC, L) for the payout (redeem).",
    );
    expect(
      optionItems("L", "k", { ...CC_SERIES_STATE, cancelled: true }, vault, WAD, 0n).items[0]!.kind,
    ).toBe("option-refund");
    expect(optionItems("L", "k", CC_SERIES_STATE, vault, WAD, AFTER_EXPIRY).items[0]!.kind).toBe(
      "awaiting-price",
    );
    expect(
      optionItems(
        "L",
        "k",
        { ...CC_SERIES_STATE, settled: true, settlementPrice: 360n * WAD },
        vault,
        WAD,
        AFTER_EXPIRY,
      ).items,
    ).toEqual([]);
    expect(optionItems("L", "k", CC_SERIES_STATE, vault, 0n, AFTER_EXPIRY).positions).toEqual([]);
  });
});

describe("/status <address>", () => {
  it("lists positions, what needs action and what waits for a price, across deployments", async () => {
    const { run } = await setup();
    expect(await run(`/status ${DEPLOYER.toLowerCase()}`)).toBe(
      [
        `Wallet ${DEPLOYER}`,
        "",
        "Positions:",
        "• sTSLA-CC (Robinhood Chain testnet · v2): 5 shares, about 5 TSLA",
        "• 4 TSLA calls at $369.86 (sTSLA-CC, Robinhood Chain testnet · v2), expiry 2026-10-02 20:00 UTC",
        "• sTSLA-CSP (Robinhood Chain testnet · v3): 60 shares, about 60 USDG",
        "",
        "Needs your action:",
        "• Premium ready to claim: 9.999999 USDG from sTSLA-CSP (Robinhood Chain testnet · v3) (claimPremium).",
        "",
        "Waiting for a settlement price:",
        "• sTSLA-CC (Robinhood Chain testnet · v2): the call series at $369.86 expired 2026-10-02 20:00 UTC and is waiting for its settlement price (the first mainnet Chainlink price at or after expiry). Nothing to do yet.",
        "• Your 4 TSLA calls at $369.86 (sTSLA-CC, Robinhood Chain testnet · v2) expired 2026-10-02 20:00 UTC and the series is waiting for its settlement price. Nothing to do yet.",
        "",
        "Act in the app: https://strike-options.vercel.app/app/portfolio",
      ].join("\n"),
    );
  });

  it("keeps /status [chain] for chains, and names a deployment it cannot read", async () => {
    const { run } = await setup(deployerTargets(deployerBook(), true));
    const reply = await run(`/status ${DEPLOYER}`);
    expect(reply).toContain("Robinhood Chain testnet · v3: could not read (RPC down)");
    expect(reply).toContain("sTSLA-CC (Robinhood Chain testnet · v2): 5 shares");
    expect(await run("/status 46630")).toMatch(/^Robinhood Chain testnet \(46630\): head block/);
    expect(await run(`/status ${QA}`)).toContain("No Strike positions on the deployments read.");
  });
});

describe("/watch and /unwatch", () => {
  it("watches a wallet, shows what it needs now, and stores only the chat-to-address mapping", async () => {
    const { run, store } = await setup();
    const reply = await run(`/watch ${DEPLOYER.toLowerCase()}`);
    expect(reply.split("\n")[0]).toBe(
      `Watching ${DEPLOYER}. This chat gets an alert when it has something to do on any Strike deployment. Addresses are public chain data; the bot stores only this chat's watch list.`,
    );
    expect(reply).toContain("Premium ready to claim: 9.999999 USDG");
    expect(await run(`/watch ${DEPLOYER}`)).toMatch(/^This chat already watches/);
    expect(await run("/watch")).toBe(
      `This chat watches:\n• ${DEPLOYER}\n/unwatch <address> or /unwatch all to stop.`,
    );
    const file = JSON.parse(await readFile(store.path, "utf8"));
    expect(file.watches).toEqual({ "7": [DEPLOYER] });
    expect(JSON.stringify(file)).not.toMatch(/premium|shares|9999999/i);
    expect((await StateStore.open(dir, 46630)).watchesOf(7)).toEqual([DEPLOYER]);
  });

  it("refuses a bad address and more than the limit; unwatches one or all", async () => {
    const { run, store } = await setup();
    expect(await run("/watch 0x1234")).toMatch(/is not a 0x address/);
    for (let i = 1; i <= MAX_WATCHES_PER_CHAT; i++) {
      await run(`/watch 0x${i.toString(16).padStart(40, "0")}`);
    }
    expect(await run(`/watch ${DEPLOYER}`)).toMatch(/the most it can/);
    expect(await run("/unwatch 0x0000000000000000000000000000000000000001")).toBe(
      "Stopped watching 0x0000000000000000000000000000000000000001.",
    );
    expect(await run("/unwatch all")).toBe("Stopped watching 4 wallet(s).");
    expect(store.watchesOf(7)).toEqual([]);
    expect(await run("/unwatch all")).toBe("This chat watches no wallet.");
  });

  it("says in /help that addresses are public chain data", () => {
    expect(HELP).toContain("/watch <address>");
    expect(HELP).toContain("Addresses are public chain data");
  });
});

describe("watch loop", () => {
  function deps(
    store: StateStore,
    api: BotDeps["api"],
    targets: CommandTarget[],
    tracker: WatchTracker,
  ): BotDeps {
    return {
      api,
      store,
      targets,
      sources: [],
      pollIntervalMs: 10,
      log: () => undefined,
      send: { sleep: async () => undefined },
      watch: { tracker, intervalMs: 10, appUrl: "https://strike-options.vercel.app" },
    };
  }

  it("sends each new item once per watching chat, and again only after it went away and came back", async () => {
    const book = deployerBook();
    const targets = deployerTargets(book);
    const { run, store, tracker } = await setup(targets);
    await run(`/watch ${DEPLOYER}`, 7);
    await store.watch(8, DEPLOYER); // a chat that never saw the items
    const { api, sent } = fakeTelegram();
    const d = deps(store, api, targets, tracker);

    expect(await pollWatchesOnce(d)).toBe(1);
    expect(sent().map((m) => m.chat_id)).toEqual([8]);
    expect(String(sent()[0]!.text).split("\n")[0]).toBe("Wallet 0x26b2…13Ff:");

    // A queued deposit gets processed on v3: one alert to each chat, then silence.
    book[`${V3_CSP_VAULT.address}:${DEPLOYER}`.toLowerCase()] = {
      shares: 60_000_000n,
      premium: 9_999_999n,
      depositShares: 2_000_000n,
      depositRequest: { epoch: 2n, amount: 2_000_000n },
    };
    expect(await pollWatchesOnce(d)).toBe(2);
    expect(String(sent()[1]!.text)).toBe(
      "Wallet 0x26b2…13Ff:\n• Queued deposit processed: claim 2 sTSLA-CSP shares in sTSLA-CSP (Robinhood Chain testnet · v3) (claimDeposit).\nAct in the app: https://strike-options.vercel.app/app/portfolio",
    );
    expect(await pollWatchesOnce(d)).toBe(0);

    // The premium is claimed (gone), then a new epoch's premium appears: a fresh alert.
    book[`${V3_CSP_VAULT.address}:${DEPLOYER}`.toLowerCase()] = { shares: 60_000_000n };
    expect(await pollWatchesOnce(d)).toBe(0);
    book[`${V3_CSP_VAULT.address}:${DEPLOYER}`.toLowerCase()] = { shares: 60_000_000n, premium: 1_000_000n };
    expect(await pollWatchesOnce(d)).toBe(2);
    expect(String(sent().at(-1)!.text)).toContain("Premium ready to claim: 1 USDG");
  });

  it("a deployment that cannot be read does not make its items look new later", async () => {
    const book = deployerBook();
    const ok = deployerTargets(book);
    const { run, store, tracker } = await setup(ok);
    await run(`/watch ${DEPLOYER}`);
    const { api, sent } = fakeTelegram();
    expect(await pollWatchesOnce(deps(store, api, deployerTargets(book, true), tracker))).toBe(0);
    expect(await pollWatchesOnce(deps(store, api, ok, tracker))).toBe(0);
    expect(sent()).toEqual([]);
  });

  it("tells a watching chat when a slash is paid into a vault its wallet is in", async () => {
    const store = await StateStore.open(dir, 46630);
    await store.watch(7, DEPLOYER);
    await store.watch(9, QA);
    const book: Book = { [`${CSP_VAULT.address}:${DEPLOYER}`.toLowerCase()]: { shares: 20_000_000n } };
    const target = targetV2({ vaults: [selling(CC_VAULT), vaultState(CSP_VAULT)] });
    const wallet = walletSource(target, book);
    const reader: ChainReader = {
      getVault: vi.fn(async (a) => vaultState(a === CC_VAULT.address ? CC_VAULT : CSP_VAULT)),
      getSeries: vi.fn(async () => CC_SERIES_STATE),
    };
    const source: AlertSource = {
      key: target.key,
      label: target.label,
      primary: true,
      pipeline: {
        fetchLogs: vi.fn(async () => REAL_LOGS),
        builder: new AlertBuilder(reader),
        format: FORMAT,
        maxRange: 1_000_000n,
      },
      getBlockNumber: async () => 126_302_600n,
      startBlock: 126_302_000n,
      wallet: { reader: wallet.reader, usdgDecimals: 6 },
    };
    const { api, sent } = fakeTelegram();
    await pollAlertsOnce({ ...deps(store, api, [target], new WatchTracker()), sources: [source] });
    expect(sent()).toEqual([
      {
        chat_id: 7,
        text: "Wallet 0x26b2…13Ff:\n• Agent 1 proposed outside sTSLA-CSP's mandate (Robinhood Chain testnet · v2): 10 USDG of its bond was slashed to the vault, paid to its depositors (you included) at epoch close.",
        link_preview_options: { is_disabled: true },
      },
    ]);
  });
});

export type { VaultState };
