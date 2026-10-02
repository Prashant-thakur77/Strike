// Summarises a Playwright JSON report as Markdown: what passed, failed and was skipped, and why each skip happened.
// CI appends the output to the job summary ($GITHUB_STEP_SUMMARY).
//
//   PLAYWRIGHT_JSON_OUTPUT_FILE=report.json pnpm exec playwright test --reporter=list,json
//   node scripts/e2e-summary.mjs report.json "Playwright on the v2 devnet"
import { existsSync, readFileSync } from "node:fs";

const [file, title = "Playwright"] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/e2e-summary.mjs <report.json> [title]");
  process.exit(2);
}
if (!existsSync(file)) {
  console.log(`### ${title}\n\nNo report at \`${file}\`: the run did not finish.\n`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(file, "utf8"));

/** Every test run (one per project) with its file, line, title and the reason it was skipped, if it was. */
function runs(suites, path = null) {
  const out = [];
  for (const suite of suites ?? []) {
    // The top-level suites are the files (path null); nested suites are describe blocks.
    const titles = path === null ? [] : [...path, suite.title];
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const notes = [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r) => r.annotations ?? [])];
        const skip = notes.find((a) => a.type === "skip" || a.type === "fixme");
        out.push({
          file: spec.file ?? suite.file,
          line: spec.line,
          title: [...titles, spec.title].join(" › "),
          project: t.projectName,
          status: t.status, // expected, unexpected, flaky, skipped
          reason: t.status === "skipped" ? (skip?.description ?? "skipped (no reason given)") : null,
          error: (t.results ?? []).map((r) => r.error?.message).find(Boolean) ?? null,
        });
      }
    }
    out.push(...runs(suite.suites, titles));
  }
  return out;
}

const all = runs(report.suites);
const count = (s) => all.filter((r) => r.status === s).length;
const skipped = all.filter((r) => r.status === "skipped");
const failed = all.filter((r) => r.status === "unexpected");
const minutes = ((report.stats?.duration ?? 0) / 60000).toFixed(1);
const cell = (s) => String(s).replace(/\|/g, "\\|");
// Spec paths in the report are relative to playwright.config.ts's testDir.
const where = (r) => `\`app/e2e/${r.file}:${r.line}\``;

const lines = [`### ${title}`, ""];
lines.push(
  `${all.length} runs in ${minutes} min: ${count("expected")} passed, ${count("flaky")} flaky, ` +
    `${failed.length} failed, ${skipped.length} skipped.`,
  "",
);
if (failed.length) {
  lines.push("**Failed**", "");
  for (const r of failed) {
    lines.push(`- ${where(r)} [${r.project}] ${cell(r.title)}`);
    // The first lines of the error, without the terminal colour codes.
    const error = (r.error ?? "")
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .slice(0, 12)
      .join("\n");
    if (error) lines.push("", "  ```", ...error.split("\n").map((l) => `  ${l}`), "  ```");
  }
  lines.push("");
}
if (skipped.length) {
  const byReason = new Map();
  for (const r of skipped) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r]);
  lines.push("**Skipped, by reason**", "", "| Reason | Runs | Files |", "| --- | ---: | --- |");
  const groups = [...byReason].sort((a, b) => b[1].length - a[1].length);
  for (const [reason, rs] of groups) {
    const files = [...new Set(rs.map((r) => `\`${r.file}\``))].join(", ");
    lines.push(`| ${cell(reason)} | ${rs.length} | ${files} |`);
  }
  lines.push(
    "",
    "Most skips are the second viewport of a test that runs once (pure functions, HTTP-only routes, flows that " +
      "change the chain): it ran in the other project. `ui-audit.spec.ts` is an opt-in capture tool with no " +
      "assertions (screenshots and DOM reports for review, `UI_AUDIT=1`). A reason that names an RPC or GitHub " +
      "means a public network did not answer from the runner. A reason that names a devnet version runs in the " +
      "other devnet's pass.",
    "",
    "<details><summary>Every skipped run</summary>",
    "",
  );
  for (const [reason, rs] of groups) {
    lines.push(`- ${cell(reason)}`);
    for (const r of rs) lines.push(`  - ${where(r)} [${r.project}] ${cell(r.title)}`);
  }
  lines.push("", "</details>", "");
}
console.log(lines.join("\n"));
