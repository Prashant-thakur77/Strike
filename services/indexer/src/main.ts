import { loadIndexerSpec, settingsFromEnv } from "./config.js";
import { createLogger } from "./log.js";
import { IndexerService } from "./service.js";
import { errorMessage } from "./util.js";

// The service entry point (`node dist/main.js`, or `pnpm dev`). SIGTERM and SIGINT stop it gracefully: the API
// stops taking requests, the chunk in flight finishes, the writer lock is released, then the process exits 0.

const VERSION = process.env.STRIKE_INDEXER_VERSION?.trim() || "0.1.0";

async function main(): Promise<void> {
  const preliminary = settingsFromEnv();
  const log = createLogger(preliminary.logLevel);
  const spec = loadIndexerSpec({ chains: preliminary.chains });
  const settings = settingsFromEnv(process.env, spec);
  if (!spec.chains.length) throw new Error("no chain to index (check INDEXER_CHAINS and the config)");
  log.info(
    {
      source: spec.source,
      chains: spec.chains.map((c) => c.chainId),
      confirmations: Number(settings.confirmations),
      pollIntervalMs: settings.pollIntervalMs,
      maxRange: Number(settings.maxRange),
      port: settings.port,
    },
    "starting",
  );
  const service = new IndexerService({ settings, spec, log, version: VERSION });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => {
      log.error("shutdown timed out; exiting");
      process.exit(1);
    }, settings.shutdownTimeoutMs + 5000);
    force.unref();
    service.stop(signal).then(
      () => process.exit(0),
      (err) => {
        log.error({ err: errorMessage(err) }, "shutdown failed");
        process.exit(1);
      },
    );
  };
  // `on`, not `once`: a second signal while stopping is ignored instead of killing the process mid-commit.
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const address = await service.start();
  log.info({ address }, "listening");
}

main().catch((err: unknown) => {
  createLogger().fatal({ err: errorMessage(err) }, "could not start");
  process.exit(1);
});
