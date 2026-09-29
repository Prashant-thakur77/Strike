import { AlertBuilder, viemLogFetcher } from "./logs.js";
import { runBot } from "./bot.js";
import { clientFromConfig, configFromEnv, loadDotEnv } from "./config.js";
import { StateStore } from "./store.js";
import { createTelegramApi } from "./telegram.js";

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
  const strike = clientFromConfig(config);
  const publicClient = strike.viem.publicClient;
  const [store, usdgDecimals] = await Promise.all([
    StateStore.open(config.dataDir, config.chainId),
    strike.usdgDecimals(),
  ]);
  const api = createTelegramApi({ token: config.token, baseUrl: config.telegramApiUrl });
  const me = await api.getMe();
  log(
    `@${me.username ?? me.id} on chain ${config.chainId}; ${store.subscribers.length} subscriber(s); cursor ${store.cursor ?? `deploy block ${config.startBlock}`}; state ${store.path}`,
  );

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
      strike,
      pipeline: {
        fetchLogs: viemLogFetcher(publicClient, strike.addresses.epochManager),
        builder: new AlertBuilder(strike),
        format: { explorerUrl: config.explorerUrl, usdgDecimals },
        maxRange: config.logBlockRange,
        log,
      },
      getBlockNumber: () => publicClient.getBlockNumber({ cacheTime: 0 }),
      startBlock: config.startBlock,
      pollIntervalMs: config.pollIntervalMs,
      usdgDecimals,
      botUsername: me.username,
      log,
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
