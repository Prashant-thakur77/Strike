/**
 * Print the alerts the bot would send for the on-chain history (deploy block to head), without a Telegram
 * token and without touching the state file. Extra arguments are run as commands and their replies printed:
 *
 *   pnpm --filter @strike/telegram-bot dry-run "/vaults" "/quote sTSLA-CC 1" "/agent 1" "/status"
 */
import { processRange } from "./alerts.js";
import { type Subscriptions, parseCommand, runCommand } from "./commands.js";
import { configFromEnv, loadDotEnv } from "./config.js";
import { AlertBuilder, viemLogFetcher } from "./logs.js";
import { openTargets } from "./targets.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = configFromEnv();
  const targets = await openTargets(config);
  const heads = new Map<string, bigint>();
  let primaryCursor: bigint | null = null;
  for (const t of targets) {
    const head = await t.publicClient.getBlockNumber();
    heads.set(t.key, head);
    console.log(
      `Dry run on ${t.label} (chain ${t.chainId}): EpochManager ${t.epochManager}, blocks ${t.startBlock} to ${head}. Nothing is sent.\n`,
    );
    let cursor: bigint | null = null;
    const count = await processRange(
      t.startBlock,
      head,
      {
        fetchLogs: viemLogFetcher(t.publicClient, t.epochManager),
        builder: new AlertBuilder(t.client),
        format: { explorerUrl: t.explorerUrl, usdgDecimals: t.usdgDecimals, label: t.label },
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
    console.log(`${t.label}: ${count} alert(s). The cursor would now be block ${cursor ?? t.startBlock}.\n`);
    if (t.primary) primaryCursor = cursor;
  }

  const commands = process.argv.slice(2).filter((a) => a.startsWith("/"));
  if (commands.length === 0) return;
  const subscriptions: Subscriptions = {
    cursor: primaryCursor,
    cursorOf: (key) => (heads.has(key) ? heads.get(key)! + 1n : null),
    subscribers: [],
    subscribe: async () => true,
    unsubscribe: async () => true,
  };
  for (const text of commands) {
    const cmd = parseCommand(text);
    if (!cmd) continue;
    console.log(`\n>>> ${text}`);
    console.log(await runCommand(cmd, { targets, subscriptions, chatId: 0 }));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
