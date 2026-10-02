import pino from "pino";
import { COUNTED, compareStats } from "./compare.js";
import { loadIndexerSpec, settingsFromEnv } from "./config.js";
import { createLogger } from "./log.js";
import { IndexerService } from "./service.js";
import { type UsageStats, readStats } from "./stats.js";
import { refreshTvl } from "./tvl.js";
import { errorMessage } from "./util.js";

// `pnpm once [--compare <url>] [--no-tvl]`: index every configured chain up to head - CONFIRMATIONS into
// DATABASE_URL, read vault values, print the counts and, with --compare, check them against another /stats answer
// (the app's https://strike-options.vercel.app/api/stats). Logs go to stderr, the tables to stdout. Exit code 3
// when a chain failed or a compared count differs.

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  "))
    .join("\n");
}

const out = (s = "") => process.stdout.write(`${s}\n`);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf("--compare");
  const compareUrl = at >= 0 ? args[at + 1] : undefined;
  const withTvl = !args.includes("--no-tvl");

  const pre = settingsFromEnv();
  const log = createLogger(pre.logLevel, pino.destination(2));
  const spec = loadIndexerSpec({ chains: pre.chains });
  const settings = settingsFromEnv(process.env, spec);
  const service = new IndexerService({ settings, spec, log });
  const started = Date.now();
  let failed = false;
  try {
    await service.migrate();
    if (!(await service.ensureWriter()))
      throw new Error("another instance holds the writer lock; stop it first");
    for (const ix of service.indexers) {
      const t0 = Date.now();
      try {
        const r = await ix.tick();
        const per = Object.entries(r.deployments)
          .map(
            ([id, x]) =>
              `${id}: ${x ? `${x.logs} logs in ${x.chunks} chunk(s), ${x.inserted} new rows` : "up to date"}`,
          )
          .join("; ");
        out(
          `chain ${ix.chainId}: indexed to block ${r.target} (head ${r.head}, finalized ${r.finalized ?? "?"}) in ${Date.now() - t0} ms. ${per}`,
        );
      } catch (err) {
        failed = true;
        out(`chain ${ix.chainId}: FAILED ${errorMessage(err)}`);
        continue;
      }
      const state = service.stateOf(ix.chainId);
      if (withTvl && state) {
        await refreshTvl({ chain: ix.chain, state, pool: service.pool, writer: service.writer, log });
      }
    }

    const events = await service.pool.query(
      "SELECT deployment_id, source, count(*)::int AS n FROM events GROUP BY 1, 2 ORDER BY 1, 2",
    );
    out("\nStored events, by deployment and contract kind");
    out(
      table([
        ["deployment", "source", "events"],
        ...events.rows.map((r) => [r.deployment_id, r.source, String(r.n)]),
      ]),
    );

    const stats = await readStats(service.pool);
    out(`\nIndexer /stats (${((Date.now() - started) / 1000).toFixed(1)} s in total)`);
    const deps = stats.deployments;
    out(
      table([
        ["count", ...deps.map((d) => d.key), "total"],
        ...[...COUNTED, "tvlUsd" as const].map((k) => [
          k,
          ...deps.map((d) => String(d[k] ?? "–")),
          String(stats.total[k] ?? "–"),
        ]),
      ]),
    );
    if (stats.errors.length) out(`errors: ${JSON.stringify(stats.errors)}`);

    if (compareUrl) {
      const res = await fetch(compareUrl, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`${compareUrl}: HTTP ${res.status}`);
      const live = (await res.json()) as UsageStats;
      const diffs = compareStats(stats, live);
      const liveDeps = new Map(live.deployments.map((d) => [d.key, d]));
      out(`\nCompared with ${compareUrl} (its logs read at ${live.generatedAt})`);
      out(
        table([
          ["deployment", "indexed to", "live read to", "counts equal"],
          ...deps.map((d) => [
            d.key,
            String(d.toBlock),
            String(liveDeps.get(d.key)?.toBlock ?? "missing"),
            diffs.some((x) => x.key === d.key) ? "NO" : "yes",
          ]),
        ]),
      );
      out(
        `Value locked (moves with the spot price, so not compared): indexer $${stats.total.tvlUsd ?? "–"}, live $${live.total.tvlUsd ?? "–"}`,
      );
      if (diffs.length) {
        failed = true;
        out("Differences:");
        for (const d of diffs)
          out(`  ${d.key} ${d.field}: indexer ${String(d.indexer)}, live ${String(d.live)}`);
      } else {
        out(`All ${COUNTED.length} counts agree for every deployment and for the total.`);
      }
    }
  } finally {
    await service.writer.release().catch(() => {});
    await service.pool.end().catch(() => {});
  }
  process.exitCode = failed ? 3 : 0;
}

main().catch((err: unknown) => {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exit(1);
});
