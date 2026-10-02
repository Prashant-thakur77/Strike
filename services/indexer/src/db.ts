import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Logger } from "pino";

/** Where the SQL migrations live: ../migrations from src/ or dist/ (MIGRATIONS_DIR overrides). */
export const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR?.trim() || fileURLToPath(new URL("../migrations/", import.meta.url));

/** Advisory lock keys (bigint): one for applying migrations, one for the single writer. "STRK" + 1 or 2. */
export const MIGRATION_LOCK_KEY = "357986078721";
export const WRITER_LOCK_KEY = "357986078722";

const INT8 = 20;
const parseInt8 = (v: string) => {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : v;
};

/** pg types: bigint columns (block numbers, counts, ids) as numbers while they are exact; numeric stays a string. */
const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === INT8 && format !== "binary"
      ? parseInt8
      : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
};

export function createPool(connectionString: string, max = 10): pg.Pool {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new pg.Pool({ connectionString, max, types, application_name: "strike-indexer" });
  // An idle client that loses its connection must not crash the process; the next query reconnects.
  pool.on("error", () => {});
  return pool;
}

/** A client of the same kind (for the writer's own connection). */
export function createClient(connectionString: string): pg.Client {
  return new pg.Client({ connectionString, types, application_name: "strike-indexer-writer" });
}

export interface Migration {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(`${dir.replace(/\/$/, "")}/${f}`, "utf8");
      return {
        version: f.slice(0, 4),
        name: f.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
}

/**
 * Apply the migrations not applied yet, in order, each in its own transaction, recorded in schema_migrations.
 * Instances starting together wait on an advisory lock, so each migration runs once. A migration whose file changed
 * after it was applied stops the start (write a new migration instead). Returns the names applied now.
 */
export async function migrate(pool: pg.Pool, opts: { dir?: string; log?: Logger } = {}): Promise<string[]> {
  const migrations = readMigrations(opts.dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      "SELECT version, checksum FROM schema_migrations",
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));
    for (const m of migrations) {
      const prior = done.get(m.version);
      if (prior !== undefined) {
        if (prior !== m.checksum) throw new Error(`migration ${m.name} changed after it was applied`);
        continue;
      }
      const started = Date.now();
      try {
        await client.query("BEGIN");
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          m.version,
          m.name,
          m.checksum,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
      }
      applied.push(m.name);
      opts.log?.info({ migration: m.name, durationMs: Date.now() - started }, "migration applied");
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
