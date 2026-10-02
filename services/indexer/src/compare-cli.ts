import { COUNTED, compareStats } from "./compare.js";
import type { UsageStats } from "./stats.js";
import { errorMessage } from "./util.js";

// `pnpm compare [indexer-url] [app-url]`: fetch two /stats answers (default: the local indexer and the live app)
// and check every counted figure, per deployment and in the total. Exit code 3 when one differs.

const [a = "http://127.0.0.1:8787/stats", b = "https://strike-options.vercel.app/api/stats"] =
  process.argv.slice(2);

async function get(url: string): Promise<UsageStats> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as UsageStats;
}

async function main(): Promise<void> {
  const [x, y] = await Promise.all([get(a), get(b)]);
  const diffs = compareStats(x, y);
  const out = (s: string) => process.stdout.write(`${s}\n`);
  out(`${a}: ${x.deployments.map((d) => `${d.key} to block ${d.toBlock}`).join(", ")}`);
  out(
    `${b}: ${y.deployments.map((d) => `${d.key} to block ${d.toBlock}`).join(", ")} (read ${y.generatedAt})`,
  );
  for (const k of COUNTED)
    out(`  ${k.padEnd(18)} ${String(x.total[k]).padStart(10)} ${String(y.total[k]).padStart(10)}`);
  out(
    `  ${"tvlUsd".padEnd(18)} ${String(x.total.tvlUsd).padStart(10)} ${String(y.total.tvlUsd).padStart(10)} (not compared)`,
  );
  if (diffs.length) {
    for (const d of diffs) out(`DIFFERS ${d.key} ${d.field}: ${String(d.indexer)} vs ${String(d.live)}`);
    process.exitCode = 3;
  } else {
    out(`All ${COUNTED.length} counts agree for ${x.deployments.length} deployments and the total.`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${errorMessage(err)}\n`);
  process.exit(1);
});
