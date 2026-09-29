/**
 * Print the alerts the bot would send for the on-chain history (deploy block to head), without a Telegram
 * token and without touching the state file. Extra arguments are run as commands and their replies printed:
 *
 *   pnpm --filter @strike/telegram-bot dry-run "/vaults" "/quote sTSLA-CC 1" "/agent 1" "/status"
 */
import { processRange } from "./alerts.js";
import { type Subscriptions, parseCommand, runCommand } from "./commands.js";
import { clientFromConfig, configFromEnv, loadDotEnv } from "./config.js";
import { AlertBuilder, viemLogFetcher } from "./logs.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = configFromEnv();
  const strike = clientFromConfig(config);
  const publicClient = strike.viem.publicClient;
  const [head, usdgDecimals] = await Promise.all([publicClient.getBlockNumber(), strike.usdgDecimals()]);
  console.log(
    `Dry run on chain ${config.chainId}: EpochManager ${strike.addresses.epochManager}, blocks ${config.startBlock} to ${head}. Nothing is sent.\n`,
  );

  let cursor: bigint | null = null;
  const count = await processRange(
    config.startBlock,
    head,
    {
      fetchLogs: viemLogFetcher(publicClient, strike.addresses.epochManager),
      builder: new AlertBuilder(strike),
      format: { explorerUrl: config.explorerUrl, usdgDecimals },
      maxRange: config.logBlockRange,
      log: (m) => console.error(m),
    },
    async (text, alert) => {
      console.log(`--- ${alert.name}, block ${alert.blockNumber}`);
      console.log(`${text}\n`);
    },
    async (next) => {
      cursor = next;
    },
  );
  console.log(`${count} alert(s). The cursor would now be block ${cursor ?? config.startBlock}.`);

  const commands = process.argv.slice(2).filter((a) => a.startsWith("/"));
  if (commands.length === 0) return;
  const subscriptions: Subscriptions = {
    cursor,
    subscribers: [],
    subscribe: async () => true,
    unsubscribe: async () => true,
  };
  for (const text of commands) {
    const cmd = parseCommand(text);
    if (!cmd) continue;
    console.log(`\n>>> ${text}`);
    console.log(await runCommand(cmd, { strike, subscriptions, chatId: 0, usdgDecimals }));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
