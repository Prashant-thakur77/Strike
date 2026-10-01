// Summarises a UI audit run (e2e/ui-audit.spec.ts): node scripts/ui-audit-summary.mjs [label]
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const label = process.argv[2] ?? "local";
const dir = join(homedir(), ".cache", "strike-ui-audit", label);
const reports = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
  .sort((a, b) => a.state.localeCompare(b.state) || b.width - a.width);

const KEYS = ["clipped", "spill", "pastRight", "overlap", "brokenImages", "ellipsisNoTitle", "brokenWords"];
let clean = 0;
for (const r of reports) {
  const issues = [];
  if (r.error) issues.push(`  error: ${r.error}`);
  if (r.status && r.status >= 400 && r.state !== "not-found") issues.push(`  status ${r.status}`);
  if (r.hOverflow > 0) issues.push(`  horizontal overflow: ${r.hOverflow}px`);
  if (r.cls > 0.1) issues.push(`  layout shift (CLS): ${r.cls}`);
  for (const k of KEYS) for (const e of r[k] ?? []) issues.push(`  ${k}: ${JSON.stringify(e)}`);
  for (const e of r.consoleErrors ?? []) {
    if (r.state === "not-found" && /404/.test(e)) continue;
    issues.push(`  console: ${e}`);
  }
  for (const e of r.failedRequests ?? []) {
    if (/ERR_ABORTED/.test(e) || (r.state === "not-found" && / 404 /.test(` ${e} `))) continue;
    issues.push(`  request: ${e}`);
  }
  if (issues.length === 0) {
    clean++;
    continue;
  }
  console.log(`${r.state} @ ${r.width}`);
  console.log(issues.join("\n"));
}
console.log(`\n${reports.length} captures, ${clean} clean (${dir})`);
