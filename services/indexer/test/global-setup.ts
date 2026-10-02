import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

// One real Postgres for the whole run. TEST_DATABASE_URL (a server you run, or CI's service container) when set;
// otherwise an embedded Postgres 17 (the embedded-postgres package ships the server binaries) in ~/.cache, removed
// afterwards. Each test file then creates and drops its own database on it (test/helpers.ts).

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const given = process.env.TEST_DATABASE_URL?.trim();
  if (given) {
    project.provide("pgAdminUrl", given);
    return async () => {};
  }
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const port = await freePort();
  const base = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "strike-indexer-test-pg");
  mkdirSync(base, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: join(base, `${process.pid}-${Date.now()}`),
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  project.provide("pgAdminUrl", `postgres://postgres:postgres@127.0.0.1:${port}/postgres`);
  return async () => {
    await pg.stop();
  };
}
