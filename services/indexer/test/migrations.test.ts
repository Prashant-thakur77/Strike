import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, migrate, readMigrations } from "../src/db.js";
import { freshDb } from "./helpers.js";

describe("migrations", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await freshDb();
    pool = createPool(db.url, 4);
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it("apply from an empty database, in order, and record each one", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    expect(before.rows[0].n).toBe(0);
    const applied = await migrate(pool);
    expect(applied).toEqual(readMigrations().map((m) => m.name));
    expect(applied).toEqual(["0001_schema", "0002_views"]);
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(tables.rows.map((r) => r.tablename)).toEqual([
      "blocks",
      "chain_heads",
      "chains",
      "contracts",
      "cursors",
      "deployments",
      "events",
      "reorgs",
      "schema_migrations",
      "vault_tvl",
    ]);
    const views = await pool.query(
      "SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname",
    );
    expect(views.rows.map((r) => r.viewname)).toEqual([
      "v_agents",
      "v_buys",
      "v_decision_records",
      "v_epochs",
      "v_mirror_pushes",
      "v_rejections",
      "v_series",
      "v_slashes",
      "v_vault_flows",
      "v_vaults",
      "v_wallet_roles",
    ]);
    const unique = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'events'::regclass AND contype = 'u'`,
    );
    expect(unique.rows.map((r) => r.def)).toEqual(["UNIQUE (chain_id, tx_hash, log_index)"]);
  });

  it("are a no-op the second time", async () => {
    expect(await migrate(pool)).toEqual([]);
    const { rows } = await pool.query("SELECT version, name FROM schema_migrations ORDER BY version");
    expect(rows).toEqual([
      { version: "0001", name: "0001_schema" },
      { version: "0002", name: "0002_views" },
    ]);
  });

  it("run once when two instances start together", async () => {
    const other = await freshDb();
    const p1 = createPool(other.url, 2);
    const p2 = createPool(other.url, 2);
    try {
      const [a, b] = await Promise.all([migrate(p1), migrate(p2)]);
      expect([...a, ...b].sort()).toEqual(["0001_schema", "0002_views"]);
      const { rows } = await p1.query("SELECT count(*)::int AS n FROM schema_migrations");
      expect(rows[0].n).toBe(2);
    } finally {
      await p1.end();
      await p2.end();
      await other.drop();
    }
  });

  it("refuse to start when an applied migration's file changed", async () => {
    await pool.query("UPDATE schema_migrations SET checksum = 'edited' WHERE version = '0001'");
    await expect(migrate(pool)).rejects.toThrow("migration 0001_schema changed after it was applied");
  });
});
