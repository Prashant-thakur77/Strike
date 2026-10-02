import { createPool, migrate } from "./db.js";
import { createLogger } from "./log.js";
import { errorMessage } from "./util.js";

// `pnpm migrate`: apply pending migrations to DATABASE_URL and exit (the service also does this at start).

const log = createLogger(process.env.LOG_LEVEL || "info");
const pool = createPool(process.env.DATABASE_URL?.trim() ?? "");
migrate(pool, { log })
  .then((applied) => log.info({ applied }, applied.length ? "migrations applied" : "schema up to date"))
  .catch((err: unknown) => {
    log.fatal({ err: errorMessage(err) }, "migration failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
