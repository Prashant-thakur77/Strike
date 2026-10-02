#!/usr/bin/env node
// Numbers consistency gate: the figures the docs state (test counts, coverage, contract counts, threats) against one
// facts file, docs/evidence/facts.json, built from real outputs.
//
//   node scripts/check-numbers.mjs                    check every doc figure listed in CHECKS below against facts.json,
//                                                     and the facts read from the repository (deployments, counts of
//                                                     Halmos proofs, Rust tests, subgraph tests, threats)
//   node scripts/check-numbers.mjs --measure          run every counting command and compare with facts.json
//   node scripts/check-numbers.mjs --measure --write  ... and write facts.json and the chart data (scripts/charts/data)
//   node scripts/check-numbers.mjs --measure foundry  only the Foundry main suite (what CI runs with Foundry)
//
// Measuring runs, from the repository root: forge test --summary and --list --json (contracts), make coverage's
// forge coverage, vitest --reporter=json in each TypeScript package (Foundry on PATH so the SDK's and the MCP server's
// devnet suites run, as CI's devnet-ts job does), npx playwright test --list (app), and the v3-contracts worktree when
// there is one. Exit status: 0 when everything agrees, 1 on any mismatch, 2 when a measurement fails.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG, ROOT } from "./lib/evm.mjs";

const FACTS_PATH = join(ROOT, "docs/evidence/facts.json");
const args = process.argv.slice(2);
const MEASURE = args.includes("--measure");
const WRITE = args.includes("--write");
const ONLY =
  MEASURE && args[args.indexOf("--measure") + 1] && !args[args.indexOf("--measure") + 1].startsWith("--")
    ? args[args.indexOf("--measure") + 1].split(",")
    : null;

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ------------------------------------------------------------------------------------------------ the doc figures
//
// Each check: a file, what the figure is, a regular expression whose capture groups are the figures, and the fact each
// group must equal. Every expression must match at least once (a reworded sentence fails here until its check is
// updated, so nothing drops out of the gate silently); every match is checked. A figure written with decimals is
// compared after rounding the fact to that many decimals; thousands separators are ignored.

const T = "tests.foundry.passing";
const CHECKS = [
  // README.md
  [
    "README.md",
    "coverage badge",
    /alt="Coverage ([\d.]+)% of lines" src="[^"]*coverage-([\d.]+)%25%20lines/g,
    ["coverage.lines", "coverage.lines"],
  ],
  [
    "README.md",
    "Playwright badge",
    /alt="Playwright: (\d+) tests" src="[^"]*Playwright-(\d+)%20tests/g,
    ["tests.playwright.tests", "tests.playwright.tests"],
  ],
  [
    "README.md",
    "Evidence in numbers row",
    /\| \[([\d,]+)\]\(#tests\)\s*\| \[([\d.]+)%\]\(#coverage\)/g,
    ["totals.testsAndProofs", "coverage.lines"],
  ],
  [
    "README.md",
    "tests chart alt text",
    /bar chart of ([\d,]+) tests and proofs by suite: Foundry main suite (\d+) passing \((\d+) skipped\)/g,
    ["totals.testsAndProofs", T, "tests.foundry.skipped"],
  ],
  [
    "README.md",
    "tests chart alt text, other suites",
    /fork (\d+), Halmos (\d+), differential (\d+); Rust (\d+); SDK (\d+), MCP (\d+), example agents (\d+), Telegram bot (\d+), indexer (\d+), subgraph (\d+); Playwright (\d+) per viewport/g,
    [
      "tests.fork.tests",
      "tests.halmos.proven",
      "tests.differential.tests",
      "tests.rust.tests",
      "tests.sdk.tests",
      "tests.mcp.tests",
      "tests.agents.tests",
      "tests.bot.tests",
      "tests.indexer.tests",
      "tests.subgraph.tests",
      "tests.playwright.tests",
    ],
  ],
  ["README.md", "Tests table: Foundry", /^\| Foundry main suite .*?\|\s*(\d+) \|/gm, [T]],
  [
    "README.md",
    "Tests table: Foundry skipped",
    /^\| Foundry main suite [^|]*passing; (\d+) more skipped/gm,
    ["tests.foundry.skipped"],
  ],
  [
    "README.md",
    "Tests table: fork",
    /^\| Fork tests on Robinhood Chain mainnet .*?\|\s*(\d+) \|/gm,
    ["tests.fork.tests"],
  ],
  [
    "README.md",
    "Tests table: differential",
    /^\| Differential, Rust vs Solidity pricer .*?\|\s*(\d+) \|/gm,
    ["tests.differential.tests"],
  ],
  [
    "README.md",
    "Tests table: Halmos",
    /^\| Halmos proofs .*?\|\s*(\d+) \| Proven for every input in range; (\d+) more are marked unproven/gm,
    ["tests.halmos.proven", "tests.halmos.unproven"],
  ],
  ["README.md", "Tests table: Rust", /^\| Rust, Stylus pricer .*?\|\s*(\d+) \|/gm, ["tests.rust.tests"]],
  [
    "README.md",
    "Tests table: TypeScript",
    /^\| TypeScript: SDK (\d+), MCP (\d+), example agents (\d+), indexer (\d+), Telegram bot (\d+); (\d+) more skipped[^|]*\|\s*(\d+) \|/gm,
    [
      "tests.sdk.tests",
      "tests.mcp.tests",
      "tests.agents.tests",
      "tests.indexer.tests",
      "tests.bot.tests",
      "tests.sdk.skipped",
      "totals.pnpm",
    ],
  ],
  ["README.md", "Tests table: subgraph", /^\| Subgraph .*?\|\s*(\d+) \|/gm, ["tests.subgraph.tests"]],
  [
    "README.md",
    "Tests table: Playwright",
    /^\| App, Playwright .*?\|\s*(\d+) \| `npx playwright test --list`: (\d+) runs, (\d+) tests × 2 viewports/gm,
    ["tests.playwright.tests", "tests.playwright.runs", "tests.playwright.tests"],
  ],
  [
    "README.md",
    "Tests notes: UI audit",
    /(\d+) of the (\d+) are the UI audit/g,
    ["tests.playwright.uiAudit", "tests.playwright.tests"],
  ],
  [
    "README.md",
    "Tests notes: v3-contracts",
    /branch has (\d+) Foundry tests passing \((\d+) skipped\) and (\d+) Rust tests/g,
    ["tests.v3Contracts.foundryPassing", "tests.v3Contracts.foundrySkipped", "tests.v3Contracts.rust"],
  ],
  [
    "README.md",
    "coverage chart alt text",
    /coverage for (\d+) files\..*?Total ([\d.]+)% of lines and ([\d.]+)% of branches/g,
    ["coverage.files", "coverage.lines", "coverage.branches"],
  ],
  [
    "README.md",
    "coverage table total",
    /\| \*\*Total\*\*\s*\| \*\*([\d.]+)% \((\d+)\/(\d+)\)\*\*\s*\| \*\*([\d.]+)% \((\d+)\/(\d+)\)\*\*/g,
    [
      "coverage.lines",
      "coverage.linesHit",
      "coverage.linesTotal",
      "coverage.branches",
      "coverage.branchesHit",
      "coverage.branchesTotal",
    ],
  ],
  ["README.md", "coverage table: other files", /\| The other (\d+) files \|/g, ["coverage.filesAt100"]],
  [
    "README.md",
    "verified v2 contracts",
    /(\d+) contracts verified on Blockscout, plus the Stylus pricer/g,
    ["contracts.v2VerifiedOnBlockscout"],
  ],
  [
    "README.md",
    "Evidence in numbers: contracts",
    /\[(\d+) on Blockscout \+ Stylus\]/g,
    ["contracts.v2VerifiedOnBlockscout"],
  ],
  ["README.md", "threat model", /\| Threat model\s*\| (\d+) threats/g, ["threats"]],
  // docs/JUDGES.md
  [
    "docs/JUDGES.md",
    "criteria table",
    /\| (\d+) Foundry tests at ([\d.]+)% line coverage/g,
    [T, "coverage.lines"],
  ],
  ["docs/JUDGES.md", "make test comment", /make test\s+# (\d+) Foundry tests/g, [T]],
  [
    "docs/JUDGES.md",
    "what each step shows",
    /`make test` \((\d+) tests, ([\d.]+)% lines\)/g,
    [T, "coverage.lines"],
  ],
  [
    "docs/JUDGES.md",
    "other numbers",
    /([\d.]+)% line and ([\d.]+)% branch coverage \(`make coverage`\), (\d+) differential tests \(Stylus against Solidity\), (\d+) Rust tests, (\d+) TypeScript tests \(SDK (\d+), MCP (\d+), example agents (\d+), indexer (\d+); (\d+) more SDK tests are opt-in live checks\), (\d+) Telegram bot tests, (\d+) subgraph tests, (\d+) Playwright tests per viewport \((\d+) run by default; (\d+) are the opt-in UI audit\)\. The \[threat model\]\(threat-model\.md\) lists (\d+) threats/g,
    [
      "coverage.lines",
      "coverage.branches",
      "tests.differential.tests",
      "tests.rust.tests",
      "totals.typescript",
      "tests.sdk.tests",
      "tests.mcp.tests",
      "tests.agents.tests",
      "tests.indexer.tests",
      "tests.sdk.skipped",
      "tests.bot.tests",
      "tests.subgraph.tests",
      "tests.playwright.tests",
      "tests.playwright.byDefault",
      "tests.playwright.uiAudit",
      "threats",
    ],
  ],
  [
    "docs/JUDGES.md",
    "Halmos",
    /(\d+) properties proven with Halmos, (\d+) more written down and marked unproven/g,
    ["tests.halmos.proven", "tests.halmos.unproven"],
  ],
  [
    "docs/JUDGES.md",
    "fork tests",
    /Fork tests: (\d+) tests against real Robinhood Chain mainnet/g,
    ["tests.fork.tests"],
  ],
  // docs/testing.md
  [
    "docs/testing.md",
    "Foundry",
    /The Foundry suite has (\d+) passing tests and (\d+) skipped/g,
    [T, "tests.foundry.skipped"],
  ],
  [
    "docs/testing.md",
    "separate jobs",
    /plus (\d+) fork tests, (\d+) differential fuzz tests and (\d+) Halmos proofs/g,
    ["tests.fork.tests", "tests.differential.tests", "tests.halmos.proven"],
  ],
  ["docs/testing.md", "Rust", /The Stylus crate has (\d+) Rust tests/g, ["tests.rust.tests"]],
  [
    "docs/testing.md",
    "TypeScript",
    /The SDK has (\d+) tests \((\d+) more are skipped:[^)]*\), the MCP server (\d+), the example agents (\d+), the indexer (\d+), the Telegram bot (\d+) and the subgraph (\d+); the app has (\d+) Playwright tests in (\d+) files, each run at desktop and mobile sizes \((\d+) runs\)/g,
    [
      "tests.sdk.tests",
      "tests.sdk.skipped",
      "tests.mcp.tests",
      "tests.agents.tests",
      "tests.indexer.tests",
      "tests.bot.tests",
      "tests.subgraph.tests",
      "tests.playwright.tests",
      "tests.playwright.files",
      "tests.playwright.runs",
    ],
  ],
  [
    "docs/testing.md",
    "UI audit",
    /(\d+) of the (\d+) are the UI audit.*?, so (\d+) run by default/g,
    ["tests.playwright.uiAudit", "tests.playwright.tests", "tests.playwright.byDefault"],
  ],
  ["docs/testing.md", "total", /In total that is ([\d,]+) tests and proofs/g, ["totals.testsAndProofs"]],
  [
    "docs/testing.md",
    "v3-contracts",
    /branch has (\d+) Foundry tests passing \((\d+) skipped\) and (\d+) Rust tests/g,
    ["tests.v3Contracts.foundryPassing", "tests.v3Contracts.foundrySkipped", "tests.v3Contracts.rust"],
  ],
  [
    "docs/testing.md",
    "coverage total",
    /\| \*\*Total\*\*\s*\| \*\*([\d.]+)%\*\*\s*\| \*\*([\d.]+)%\*\*/g,
    ["coverage.lines", "coverage.branches"],
  ],
  // docs/technical-note.md
  [
    "docs/technical-note.md",
    "counts",
    /tests has (\d+) passing and (\d+) skipped; the SDK (\d+) passing and (\d+) skipped; the MCP server (\d+); the example agents (\d+); the indexer (\d+); the Telegram bot (\d+); Playwright (\d+) per viewport\. Line coverage of the contracts is ([\d.]+)% \(([\d,]+) of ([\d,]+) lines/g,
    [
      T,
      "tests.foundry.skipped",
      "tests.sdk.tests",
      "tests.sdk.skipped",
      "tests.mcp.tests",
      "tests.agents.tests",
      "tests.indexer.tests",
      "tests.bot.tests",
      "tests.playwright.tests",
      "coverage.lines",
      "coverage.linesHit",
      "coverage.linesTotal",
    ],
  ],
  ["docs/technical-note.md", "threats", /\| (\d+) threats with mitigation and test/g, ["threats"]],
  // app/src/lib/proof.ts (the proof page)
  [
    "app/src/lib/proof.ts",
    "Foundry card",
    /label: "Foundry",\s*count: "(\d+)",\s*detail:\s*"[^"]*?; (\d+) more are skipped/g,
    [T, "tests.foundry.skipped"],
  ],
  ["app/src/lib/proof.ts", "Rust card", /label: "Rust",\s*count: "(\d+)"/g, ["tests.rust.tests"]],
  [
    "app/src/lib/proof.ts",
    "TypeScript card",
    /label: "TypeScript",\s*count: "(\d+)",\s*detail:\s*"SDK (\d+), MCP server (\d+), example agents (\d+), indexer (\d+); (\d+) more SDK tests/g,
    [
      "totals.typescript",
      "tests.sdk.tests",
      "tests.mcp.tests",
      "tests.agents.tests",
      "tests.indexer.tests",
      "tests.sdk.skipped",
    ],
  ],
  [
    "app/src/lib/proof.ts",
    "Telegram bot card",
    /label: "Telegram bot",\s*count: "(\d+)"/g,
    ["tests.bot.tests"],
  ],
  ["app/src/lib/proof.ts", "Subgraph card", /label: "Subgraph",\s*count: "(\d+)"/g, ["tests.subgraph.tests"]],
  [
    "app/src/lib/proof.ts",
    "Playwright card",
    /label: "Playwright",\s*count: "(\d+)",\s*detail:\s*"[^"]*?; (\d+) of them are the opt-in UI audit/g,
    ["tests.playwright.tests", "tests.playwright.uiAudit"],
  ],
  [
    "app/src/lib/proof.ts",
    "coverage",
    /lines: "([\d.]+)%",\s*branches: "([\d.]+)%",\s*statements: "([\d.]+)%",\s*functions: "([\d.]+)%"/g,
    ["coverage.lines", "coverage.branches", "coverage.statements", "coverage.functions"],
  ],
  ["app/src/lib/proof.ts", "threat model", /THREAT_MODEL = \{\s*threats: (\d+),/g, ["threats"]],
  // Submission texts and the other docs that state the totals
  [
    "docs/submission/hackquest-answers.md",
    "tests",
    /([\d,]+) tests and proofs \((\d+) Foundry tests, (\d+) Halmos-proven properties\), ([\d.]+)% line coverage/g,
    ["totals.testsAndProofs", T, "tests.halmos.proven", "coverage.lines"],
  ],
  [
    "docs/submission/social-posts.md",
    "evidence post",
    /Evidence: ([\d,]+) tests and proofs, (\d+) of them Halmos proofs, ([\d.]+)% line coverage/g,
    ["totals.testsAndProofs", "tests.halmos.proven", "coverage.lines"],
  ],
  [
    "docs/submission/pitch-script.md",
    "since the render",
    /the count of tests and proofs is ([\d,]+) \(the video says/g,
    ["totals.testsAndProofs"],
  ],
  [
    "docs/audit-readiness.md",
    "test suite",
    /`contracts\/test` \((\d+) tests on `main`, (\d+) of them audit regressions in `contracts\/test\/audit`; (\d+) on `v3-contracts`, (\d+) audit regressions\), ([\d.]+)% line and ([\d.]+)% branch coverage/g,
    [
      T,
      "tests.foundry.audit",
      "tests.v3Contracts.foundryPassing",
      "tests.v3Contracts.audit",
      "coverage.lines",
      "coverage.branches",
    ],
  ],
  ["docs/risk-model.md", "contract bugs", /\| (\d+) Foundry tests, invariants, fork tests/g, [T]],
  [
    "docs/litepaper.md",
    "threat model",
    /\[threat-model\.md\]\(threat-model\.md\) lists (\d+) threats/g,
    ["threats"],
  ],
  ["docs/README.md", "threat model", /\| (\d+) threats, each with its mitigation/g, ["threats"]],
];

// The README's address tables: each row's label names a field of a deployment file, each column a deployment.
const ADDRESS_TABLES = [
  {
    file: "README.md",
    header: /^\| Contract\s*\| v2 \(block [\d,]+\)\s*\| v3 \(block [\d,]+\)/m,
    columns: ["46630-v2", "46630-v3"],
  },
  { file: "README.md", header: /^\| Contract\s*\| Address\s*\| Verification/m, columns: ["421614-v3"] },
];
const ADDRESS_ROWS = {
  EpochManager: "epochManager",
  VaultFactory: "vaultFactory",
  AgentRegistry: "agentRegistry",
  "AgentRegistry (EIP-712)": "agentRegistry",
  "StockOracle (SafeStockFeed)": "stockOracle",
  "Stylus pricer (Rust/WASM)": "stylusPricer",
  "Stylus pricer and risk engine": "stylusPricer",
  "OptionToken (ERC-1155)": "optionToken",
  FeeManager: "feeManager",
  "FeeManager (high-water mark)": "feeManager",
  DecisionLog: "decisionLog",
  RiskLens: "riskLens",
  "TSLA covered-call vault": "vault_TSLA_covered_call",
  "TSLA cash-secured-put vault": "vault_TSLA_cash_secured_put",
  "sTSLA-CC vault (5 TSLA)": "vault_TSLA_covered_call",
  "sTSLA-CSP vault (30 USDG)": "vault_TSLA_cash_secured_put",
  "MarketCalendar, TSLA MirrorFeed": "marketCalendar",
  "USDG (Paxos), TSLA token": "usdg",
  "USDG (Paxos, Sepolia)": "usdg",
};
// Every Markdown file whose shortened addresses ([`0x5A3b…9C99`](…/address/0x5A3b…)) must match the link: the
// README and docs/**/*.md.
const markdown = (dir) =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdown(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : [],
  );
const SHORT_ADDRESS_FILES = ["README.md", ...markdown("docs")];

function checkAddresses(facts) {
  const failures = [];
  let checked = 0;
  for (const t of ADDRESS_TABLES) {
    const text = read(t.file);
    const at = text.search(t.header);
    if (at < 0) {
      failures.push(`${t.file}: address table ${t.columns.join(", ")}: header not found`);
      continue;
    }
    const rows = text.slice(at).split("\n");
    const end = rows.findIndex((l) => !l.startsWith("|"));
    let mapped = 0;
    for (const row of rows.slice(2, end)) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      const field = ADDRESS_ROWS[cells[0]];
      if (!field) continue;
      mapped++;
      t.columns.forEach((key, i) => {
        const shown = cells[i + 1]?.match(/\/address\/(0x[0-9a-fA-F]{40})/)?.[1];
        if (!shown) return;
        checked++;
        const want = facts.deployments?.[key]?.addresses?.[field];
        if (!want || want.toLowerCase() !== shown.toLowerCase())
          failures.push(
            `${t.file}: ${cells[0]} (${key}) links ${shown}, contracts/deployments has ${want ?? "nothing"} as ${field}`,
          );
      });
    }
    if (!mapped)
      failures.push(`${t.file}: address table ${t.columns.join(", ")}: no row label is in ADDRESS_ROWS`);
  }
  for (const file of SHORT_ADDRESS_FILES) {
    if (!existsSync(join(ROOT, file))) continue;
    const text = read(file);
    for (const m of text.matchAll(
      /\[`(0x[0-9a-fA-F]{2,})…([0-9a-fA-F]{2,})`\]\([^)]*\/address\/(0x[0-9a-fA-F]{40})/g,
    )) {
      checked++;
      const [, head, tail, full] = m;
      if (
        !full.toLowerCase().startsWith(head.toLowerCase()) ||
        !full.toLowerCase().endsWith(tail.toLowerCase())
      ) {
        const line = text.slice(0, m.index).split("\n").length;
        failures.push(`${file}:${line}: shows ${head}…${tail} but links ${full}`);
      }
    }
  }
  return { failures, checked };
}

// ------------------------------------------------------------------------------------------------ facts from the repo

/** The facts read straight from committed files: no build, no network. */
function repoFacts() {
  const formal = readdirSync(join(ROOT, "contracts/test/formal"))
    .map((f) => read(`contracts/test/formal/${f}`))
    .join("\n");
  const rust = readdirSync(join(ROOT, "stylus/pricer/src"))
    .filter((f) => f.endsWith(".rs"))
    .reduce((n, f) => n + (read(`stylus/pricer/src/${f}`).match(/#\[test\]/g) ?? []).length, 0);
  const subgraph = readdirSync(join(ROOT, "subgraph/tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .reduce((n, f) => n + (read(`subgraph/tests/${f}`).match(/^\s*test\(/gm) ?? []).length, 0);
  const threats = (read("docs/threat-model.md").match(/^\| T\d+\s/gm) ?? []).length;

  // Deployed addresses: every deployment file strike.config.json lists, keyed <chainId>-<version>.
  const deployments = {};
  for (const c of Object.values(CONFIG.chains)) {
    if (c.local) continue;
    for (const file of c.deployments) {
      const d = JSON.parse(read(file));
      const vaultsFile = file.replace(/\.json$/, "-vaults.json");
      const vaults = existsSync(join(ROOT, vaultsFile)) ? JSON.parse(read(vaultsFile)) : {};
      const addresses = {};
      // Contracts only: the deployer and the agent's signer are wallets.
      const isContract = (k, v) =>
        typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/deployer|signer/i.test(k);
      for (const [k, v] of Object.entries(d)) if (isContract(k, v)) addresses[k] = v;
      for (const [k, v] of Object.entries(vaults)) if (isContract(k, v)) addresses[`vault_${k}`] = v;
      deployments[`${d.chainId}-${d.version}`] = { block: d.block, file, addresses: sortKeys(addresses) };
    }
  }
  // v2's own contracts verified on Blockscout: the nine protocol contracts and one MirrorFeed per stock.
  const v2 = JSON.parse(read("contracts/deployments/46630.json"));
  const protocol = [
    "agentRegistry",
    "epochManager",
    "feeManager",
    "marketCalendar",
    "optionToken",
    "pricer",
    "stockOracle",
    "vaultFactory",
    "vaultImplementation",
  ];
  const feeds = Object.values(v2.stocks).filter((s) => s.feed).length;
  return {
    "tests.halmos.proven": (formal.match(/function check_\w+/g) ?? []).length,
    "tests.halmos.unproven": (formal.match(/function unproven_\w+/g) ?? []).length,
    "tests.rust.tests": rust,
    "tests.subgraph.tests": subgraph,
    threats,
    "contracts.v2Protocol": protocol.filter((k) => v2[k]).length,
    "contracts.v2MirrorFeeds": feeds,
    "contracts.v2VerifiedOnBlockscout": protocol.filter((k) => v2[k]).length + feeds,
    deployments,
  };
}

function sortKeys(o) {
  return Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
}

// ------------------------------------------------------------------------------------------------ measuring

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd} ${argv.join(" ")}: ${r.error.message}`);
  return r;
}

/** The Foundry main suite (no fork, differential or formal tests) of a contracts directory, from --summary. */
function measureFoundry(dir, suffix = "") {
  // FOUNDRY_OUT / FOUNDRY_CACHE_PATH, when set, keep this build apart from a checkout's own; each tree gets its own.
  const env = { ...process.env };
  for (const k of ["FOUNDRY_OUT", "FOUNDRY_CACHE_PATH"]) if (env[k]) env[k] += suffix;
  const r = run("forge", ["test", "--no-match-path", "test/{fork,differential,formal}/*", "--summary"], {
    cwd: dir,
    env,
  });
  const lines = r.stdout.split("\n").filter((l) => /^(Ran \d+ tests? for |Suite result:)/.test(l));
  const byFolder = {};
  let passing = 0;
  let skipped = 0;
  let failed = 0;
  let folder = null;
  for (const l of lines) {
    const ran = l.match(/^Ran \d+ tests? for test\/(?:([a-z]+)\/)?/);
    if (ran) folder = ran[1] ?? "root";
    const res = l.match(/Suite result: \w+\. (\d+) passed; (\d+) failed; (\d+) skipped/);
    if (res && folder) {
      byFolder[folder] = (byFolder[folder] ?? 0) + Number(res[1]);
      passing += Number(res[1]);
      failed += Number(res[2]);
      skipped += Number(res[3]);
      folder = null;
    }
  }
  if (!lines.length || failed || r.status !== 0)
    throw new Error(`forge test in ${dir}: ${failed} failed, exit ${r.status}\n${r.stderr.slice(-2000)}`);
  const list = JSON.parse(
    run("forge", ["test", "--list", "--json"], { cwd: dir, env }).stdout.trim().split("\n").at(-1),
  );
  const listed = (prefix) =>
    Object.entries(list)
      .filter(([f]) => f.startsWith(prefix))
      .reduce((n, [, cs]) => n + Object.values(cs).reduce((m, t) => m + t.length, 0), 0);
  return {
    passing,
    skipped,
    byFolder: sortKeys(byFolder),
    audit: listed("test/audit/"),
    fork: listed("test/fork/"),
    differential: listed("test/differential/"),
    summaryLines: lines.map((l) => l.replace(/; finished in.*/, "")),
  };
}

/** One TypeScript package's vitest run, from its JSON report. */
function measureVitest(dir) {
  const out = join(mkdtempSync(join(tmpdir(), "strike-vitest-")), "report.json");
  // The devnet suites run forge script themselves, against their own build output: no FOUNDRY_OUT override.
  const env = { ...process.env };
  delete env.FOUNDRY_OUT;
  delete env.FOUNDRY_CACHE_PATH;
  const r = run(
    join(ROOT, dir, "node_modules/.bin/vitest"),
    ["run", "--reporter=json", `--outputFile=${out}`],
    {
      cwd: join(ROOT, dir),
      env,
    },
  );
  if (!existsSync(out))
    throw new Error(`vitest in ${dir}: no report (exit ${r.status})\n${r.stderr.slice(-2000)}`);
  const j = JSON.parse(readFileSync(out, "utf8"));
  // The suite's size is what the docs state: tests that ran, passed or failed. A failure is reported and recorded
  // (CI's js job is what fails on it); skipped tests are counted apart.
  const failed = j.testResults.flatMap((f) =>
    f.assertionResults.filter((a) => a.status === "failed").map((a) => `${dir}: ${a.fullName}`),
  );
  for (const f of failed) console.error(`warning: failing test ${f}`);
  return {
    tests: j.numPassedTests + j.numFailedTests,
    skipped: j.numPendingTests + j.numTodoTests,
    failingWhenMeasured: failed.length,
  };
}

/** The app's Playwright suite, from --list: tests per viewport, runs, files and the opt-in UI audit. */
function measurePlaywright() {
  const r = run(join(ROOT, "app/node_modules/.bin/playwright"), ["test", "--list", "--reporter=json"], {
    cwd: join(ROOT, "app"),
  });
  const j = JSON.parse(r.stdout);
  const perProject = {};
  let audit = 0;
  const walk = (suite, file) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests) {
        perProject[t.projectName] = (perProject[t.projectName] ?? 0) + 1;
        if (file === "ui-audit.spec.ts" && t.projectName === "desktop") audit++;
      }
    for (const s of suite.suites ?? []) walk(s, file);
  };
  for (const s of j.suites) walk(s, s.file ?? s.title);
  const counts = Object.values(perProject);
  if (new Set(counts).size !== 1)
    throw new Error(`playwright: projects list different counts ${JSON.stringify(perProject)}`);
  return {
    tests: counts[0],
    runs: counts.reduce((a, b) => a + b, 0),
    files: j.suites.length,
    uiAudit: audit,
    byDefault: counts[0] - audit,
  };
}

/** make coverage's forge coverage: the summary table's rows and total. */
function measureCoverage() {
  const r = run(
    "forge",
    ["coverage", "--ir-minimum", "--report", "summary", "--no-match-coverage", "(test|script|lib)/"],
    {
      cwd: join(ROOT, "contracts"),
    },
  );
  const table = r.stdout.slice(r.stdout.indexOf("| File")).trim();
  const pct = (cell) => cell.match(/([\d.]+)% \((\d+)\/(\d+)\)/);
  const rows = table
    .split("\n")
    .map((l) => l.split("|").map((c) => c.trim()))
    .filter((c) => c.length > 5 && pct(c[2] ?? ""));
  const total = rows.find((c) => c[1] === "Total");
  if (!total) throw new Error(`forge coverage: no Total row (exit ${r.status})`);
  const files = rows.filter((c) => c[1] !== "Total");
  const [, lines, linesHit, linesTotal] = pct(total[2]);
  const [, statements] = pct(total[3]);
  const [, branches, branchesHit, branchesTotal] = pct(total[4]);
  const [, functions] = pct(total[5]);
  return {
    coverage: {
      lines: Number(lines),
      linesHit: Number(linesHit),
      linesTotal: Number(linesTotal),
      branches: Number(branches),
      branchesHit: Number(branchesHit),
      branchesTotal: Number(branchesTotal),
      statements: Number(statements),
      functions: Number(functions),
      files: files.length,
      filesAt100: files.filter((c) => pct(c[2])[1] === "100.00" && pct(c[4])[1] === "100.00").length,
      command:
        'make coverage (forge coverage --ir-minimum --report summary --no-match-coverage "(test|script|lib)/")',
    },
    table,
  };
}

/** The v3-contracts worktree's contracts directory (as sdk/test/devnet.mjs finds it), or null. */
function v3ContractsDir() {
  if (process.env.STRIKE_V3_CONTRACTS) return process.env.STRIKE_V3_CONTRACTS;
  const list = run("git", ["worktree", "list", "--porcelain"]).stdout;
  for (const block of list.split("\n\n")) {
    const dir = block.match(/^worktree (.+)$/m)?.[1];
    if (
      dir &&
      /^branch refs\/heads\/v3-contracts$/m.test(block) &&
      existsSync(join(dir, "contracts/script/Deploy.s.sol"))
    )
      return join(dir, "contracts");
  }
  return null;
}

const PACKAGES = {
  sdk: "sdk",
  mcp: "mcp",
  agents: "agents/example",
  bot: "bots/telegram",
  indexer: "services/indexer",
};

function measure(previous) {
  const want = (k) => !ONLY || ONLY.includes(k);
  const facts = structuredClone(previous ?? {});
  facts.tests ??= {};
  const extra = {};
  if (want("foundry")) {
    console.error("measuring: forge test (main suite) and forge test --list");
    const f = measureFoundry(join(ROOT, "contracts"));
    facts.tests.foundry = {
      passing: f.passing,
      skipped: f.skipped,
      audit: f.audit,
      byFolder: f.byFolder,
      command: 'forge test --no-match-path "test/{fork,differential,formal}/*" --summary (in contracts)',
    };
    facts.tests.fork = { tests: f.fork, command: "forge test --list --json: test/fork" };
    facts.tests.differential = {
      tests: f.differential,
      command: "forge test --list --json: test/differential",
    };
    extra.forgeLines = f.summaryLines;
  }
  if (want("v3")) {
    const dir = v3ContractsDir();
    if (dir) {
      console.error(`measuring: forge test in the v3-contracts worktree (${dir})`);
      const f = measureFoundry(dir, "-v3");
      const rust = readdirSync(join(dir, "../stylus/pricer/src"))
        .filter((x) => x.endsWith(".rs"))
        .reduce(
          (n, x) =>
            n + (readFileSync(join(dir, "../stylus/pricer/src", x), "utf8").match(/#\[test\]/g) ?? []).length,
          0,
        );
      facts.tests.v3Contracts = {
        foundryPassing: f.passing,
        foundrySkipped: f.skipped,
        audit: f.audit,
        rust,
        command: "the same forge test and #[test] count on a worktree of the v3-contracts branch",
      };
    } else
      console.error(
        "v3-contracts: no worktree (STRIKE_V3_CONTRACTS or git worktree add <dir> v3-contracts); kept",
      );
  }
  for (const [key, dir] of Object.entries(PACKAGES)) {
    if (!want(key) && !want("ts")) continue;
    console.error(`measuring: vitest in ${dir}`);
    facts.tests[key] = {
      ...measureVitest(dir),
      command: `vitest run --reporter=json (in ${dir}, Foundry on PATH so devnet suites run)`,
    };
  }
  if (want("playwright")) {
    console.error("measuring: playwright test --list");
    facts.tests.playwright = {
      ...measurePlaywright(),
      command: "npx playwright test --list --reporter=json (in app)",
    };
  }
  if (want("coverage")) {
    console.error("measuring: forge coverage");
    const c = measureCoverage();
    facts.coverage = c.coverage;
    extra.coverageTable = c.table;
  }
  return { facts, extra };
}

/** The facts derived from the counts, and the ones read from the repository. */
function complete(facts) {
  const repo = repoFacts();
  const t = facts.tests;
  t.halmos = {
    proven: repo["tests.halmos.proven"],
    unproven: repo["tests.halmos.unproven"],
    command: "check_* and unproven_* functions in contracts/test/formal",
  };
  t.rust = {
    tests: repo["tests.rust.tests"],
    command: "#[test] in stylus/pricer/src (cargo test runs them)",
  };
  t.subgraph = {
    tests: repo["tests.subgraph.tests"],
    command: "test( cases in subgraph/tests (matchstick runs them)",
  };
  facts.threats = repo.threats;
  facts.contracts = {
    v2MirrorFeeds: repo["contracts.v2MirrorFeeds"],
    v2Protocol: repo["contracts.v2Protocol"],
    v2VerifiedOnBlockscout: repo["contracts.v2VerifiedOnBlockscout"],
  };
  facts.deployments = repo.deployments;
  const ts = ["sdk", "mcp", "agents", "indexer"].reduce((n, k) => n + t[k].tests, 0);
  facts.totals = {
    typescript: ts,
    pnpm: ts + t.bot.tests,
    testsAndProofs:
      t.foundry.passing +
      t.fork.tests +
      t.differential.tests +
      t.halmos.proven +
      t.rust.tests +
      ts +
      t.bot.tests +
      t.subgraph.tests +
      t.playwright.tests,
    about:
      "typescript = SDK + MCP + example agents + indexer (the proof page's TypeScript card); pnpm = typescript + the Telegram bot (corepack pnpm -r test); testsAndProofs = Foundry main suite + fork + differential + Halmos proofs + Rust + pnpm + subgraph + Playwright per viewport",
  };
  return facts;
}

// ------------------------------------------------------------------------------------------------ checking

function sameFigure(text, fact) {
  if (fact === undefined) return false;
  const clean = text.replace(/,/g, "");
  const decimals = (clean.split(".")[1] ?? "").length;
  return decimals ? Number(fact).toFixed(decimals) === clean : Number(clean) === Number(fact);
}

function checkDocs(facts) {
  const failures = [];
  let figures = 0;
  let wrong = 0;
  for (const [file, what, re, paths] of CHECKS) {
    const text = read(file);
    const matches = [...text.matchAll(re)];
    if (!matches.length) {
      failures.push(`${file}: ${what}: the pattern no longer matches (${re.source.slice(0, 80)}…)`);
      continue;
    }
    for (const m of matches) {
      const line = text.slice(0, m.index).split("\n").length;
      paths.forEach((path, i) => {
        figures++;
        const fact = get(facts, path);
        if (!sameFigure(m[i + 1], fact)) {
          wrong++;
          failures.push(`${file}:${line}: ${what} states ${m[i + 1]}, facts.json ${path} is ${fact}`);
        }
      });
    }
  }
  return { failures, figures, wrong };
}

function diffFacts(a, b, prefix = "") {
  const out = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    if (k === "command" || k === "measured" || k === "about") continue;
    const [x, y] = [a?.[k], b?.[k]];
    if (x && y && typeof x === "object" && typeof y === "object")
      out.push(...diffFacts(x, y, `${prefix}${k}.`));
    else if (JSON.stringify(x) !== JSON.stringify(y))
      out.push(`${prefix}${k}: facts.json ${JSON.stringify(x)}, measured ${JSON.stringify(y)}`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ chart data

function writeChartData(facts, extra) {
  const data = join(ROOT, "scripts/charts/data");
  if (extra.forgeLines) {
    // "Ran ..." and its "Suite result" line, as pairs sorted by suite, so a rerun writes the same file.
    const pairs = [];
    for (let i = 0; i < extra.forgeLines.length; i += 2)
      pairs.push(extra.forgeLines.slice(i, i + 2).join("\n"));
    writeFileSync(join(data, "forge-tests.txt"), `${pairs.sort().join("\n")}\n`);
  }
  if (extra.coverageTable) writeFileSync(join(data, "coverage.txt"), `${extra.coverageTable}\n`);
  const tj = JSON.parse(readFileSync(join(data, "tests.json"), "utf8"));
  const t = facts.tests;
  const counts = {
    "Fork (Robinhood Chain mainnet)": t.fork.tests,
    "Differential (Rust vs Solidity)": t.differential.tests,
    "Halmos proofs": t.halmos.proven,
    "Stylus pricer": t.rust.tests,
    SDK: t.sdk.tests,
    "Telegram bot": t.bot.tests,
    "MCP server": t.mcp.tests,
    "Example agents": t.agents.tests,
    Indexer: t.indexer.tests,
    "Subgraph (matchstick)": t.subgraph.tests,
    "End-to-end, per viewport": t.playwright.tests,
  };
  const sources = {
    SDK: `sdk: vitest run --reporter=json, ${t.sdk.tests} tests (${t.sdk.skipped} more skipped: the opt-in STRIKE_LIVE=1 simulation of v3 register on the two deployed registries, live.consent.test.ts; not counted)`,
    "Telegram bot": `bots/telegram: vitest run --reporter=json, ${t.bot.tests} tests`,
    "MCP server": `mcp: vitest run --reporter=json, ${t.mcp.tests} tests (the devnet suites need Foundry on PATH)`,
    "Example agents": `agents/example: vitest run --reporter=json, ${t.agents.tests} tests`,
    Indexer: `services/indexer: vitest run --reporter=json, ${t.indexer.tests} tests (embedded Postgres)`,
    "End-to-end, per viewport": `app: npx playwright test --list reports ${t.playwright.runs} runs in ${t.playwright.files} files = ${t.playwright.tests} tests x 2 viewports (desktop 1440x900, mobile 390x844), ${t.playwright.uiAudit} of them the opt-in UI audit (ui-audit.spec.ts, UI_AUDIT=1, desktop only); pure-function and HTTP-only tests (mcp.spec.ts among them) skip the mobile run; the register spec runs its v2 or its 3 v3 tests depending on the devnet's AgentRegistry`,
  };
  const ts = tj.groups.find((g) => g.group === "TypeScript and subgraph");
  if (ts && !ts.items.some((i) => i.label === "Indexer"))
    ts.items.splice(ts.items.length - 1, 0, { label: "Indexer", count: 0, source: "" });
  for (const g of tj.groups)
    for (const i of g.items) {
      if (counts[i.label] !== undefined) i.count = counts[i.label];
      if (sources[i.label]) i.source = sources[i.label];
    }
  tj.measured = facts.measured.date;
  writeFileSync(join(data, "tests.json"), `${JSON.stringify(tj, null, 2)}\n`);
}

// ------------------------------------------------------------------------------------------------ main

function stable(v) {
  const sort = (x) =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, sort(x[k])]),
          )
        : x;
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

const previous = existsSync(FACTS_PATH) ? JSON.parse(readFileSync(FACTS_PATH, "utf8")) : null;

if (MEASURE) {
  let measured;
  try {
    measured = measure(previous);
  } catch (e) {
    console.error(`measurement failed: ${e.message}`);
    process.exit(2);
  }
  const { facts, extra } = measured;
  facts.measured = {
    commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    date: new Date().toISOString().slice(0, 10),
  };
  facts.about =
    "The canonical figures the docs state, measured by `node scripts/check-numbers.mjs --measure --write` at the commit in `measured`; `node scripts/check-numbers.mjs` (CI: claims.yml) fails when a doc states a different figure. Each count names the command that produced it.";
  complete(facts);
  const diffs = diffFacts(previous, facts);
  if (WRITE) {
    writeFileSync(FACTS_PATH, stable(facts));
    if (!ONLY) writeChartData(facts, extra);
    console.log(
      `wrote docs/evidence/facts.json${ONLY ? "" : " and scripts/charts/data"}${diffs.length ? `; changed: ${diffs.join("; ")}` : "; no figure changed"}`,
    );
  } else {
    for (const d of diffs) console.log(`differs: ${d}`);
    console.log(
      diffs.length
        ? `${diffs.length} measured figure(s) differ from facts.json`
        : "measured figures match facts.json",
    );
    process.exit(diffs.length ? 1 : 0);
  }
  process.exit(0);
}

if (!previous) {
  console.error("docs/evidence/facts.json is missing: run node scripts/check-numbers.mjs --measure --write");
  process.exit(1);
}
const failures = [];
// The facts read from committed files must still hold (a new deployment, proof or threat updates facts.json).
const repo = repoFacts();
for (const [path, value] of Object.entries(repo)) {
  const fact = get(previous, path);
  if (stable(fact) !== stable(value))
    failures.push(
      `facts.json ${path} is ${JSON.stringify(fact)?.slice(0, 120)}, the repository says ${JSON.stringify(value).slice(0, 120)} (run --measure --write)`,
    );
}
const { failures: docFailures, figures, wrong } = checkDocs(previous);
failures.push(...docFailures);
const addresses = checkAddresses(previous);
failures.push(...addresses.failures);
const GH = Boolean(process.env.GITHUB_ACTIONS);
for (const f of failures) {
  console.log(`FAIL ${f}`);
  if (GH) console.log(`::error::Numbers: ${f}`);
}
console.log(
  `${figures - wrong} of ${figures} doc figures match docs/evidence/facts.json (measured ${previous.measured.date} at ${previous.measured.commit}, ${CHECKS.length} patterns in ${new Set(CHECKS.map((c) => c[0])).size} files); ${addresses.checked - addresses.failures.length} of ${addresses.checked} addresses match contracts/deployments and their links` +
    (failures.length ? `; ${failures.length} mismatch(es)` : ""),
);
process.exit(failures.length ? 1 : 0);
