import { describeRpc } from "@strike/sdk";
import { AlertBuilder, viemLogFetcher } from "./logs.js";
import { type AlertSource, runBot } from "./bot.js";
import { configFromEnv, loadDotEnv } from "./config.js";
import { StateStore } from "./store.js";
import { openTargets } from "./targets.js";
import { createTelegramApi } from "./telegram.js";
import { WatchTracker } from "./wallet.js";

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);

async function main(): Promise<void> {
  loadDotEnv();
  const config = configFromEnv();
  if (!config.token) {
    console.error(
      "TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put the token in .env, or run `pnpm dry-run` to preview alerts without one.",
    );
    process.exit(1);
  }
  const [store, targets] = await Promise.all([
    StateStore.open(config.dataDir, config.chainId),
    openTargets(config),
  ]);
  const sources: AlertSource[] = targets.map((t) => {
    const { publicClient } = t;
    return {
      key: t.key,
      label: t.label,
      primary: t.primary,
      pipeline: {
        fetchLogs: viemLogFetcher(publicClient, t.epochManager),
        builder: new AlertBuilder(t.client),
        format: { explorerUrl: t.explorerUrl, usdgDecimals: t.usdgDecimals, label: t.label },
        maxRange: config.logBlockRange,
        log,
      },
      getBlockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
      startBlock: t.startBlock,
      wallet: { reader: t.client, usdgDecimals: t.usdgDecimals },
    };
  });
  const api = createTelegramApi({ token: config.token, baseUrl: config.telegramApiUrl });
  const me = await api.getMe();
  log(
    `@${me.username ?? me.id} on chain ${config.chainId} via ${describeRpc(config.rpcEndpoints)}; ${store.subscribers.length} subscriber(s); cursor ${store.cursor ?? `deploy block ${config.startBlock}`}; state ${store.path}; ${store.watchers().size} watched wallet(s)`,
  );
  for (const t of targets) {
    const cursor = t.primary ? store.cursor : store.cursorOf(t.key);
    log(
      `watching ${t.label}: EpochManager ${t.epochManager}, ${cursor === null ? (t.primary || store.cursor === null ? `from deploy block ${t.startBlock}` : "from the current head") : `cursor ${cursor}`}`,
    );
  }

  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      log(`${sig}: stopping`);
      controller.abort();
    });
  }

  await runBot(
    {
      api,
      store,
      targets,
      sources,
      pollIntervalMs: config.pollIntervalMs,
      botUsername: me.username,
      log,
      watch: { tracker: new WatchTracker(), intervalMs: config.watchIntervalMs, appUrl: config.appUrl },
    },
    controller.signal,
  );
  await store.save();
  log("stopped");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
