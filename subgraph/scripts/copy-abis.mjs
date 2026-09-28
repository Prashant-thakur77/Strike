#!/usr/bin/env node
// Copies the ABIs the subgraph indexes from the Foundry build output (contracts/out) into subgraph/abis/.
// Run `forge build` in contracts/ first. Usage: node scripts/copy-abis.mjs [--check]
//   --check  exit 1 if any ABI in abis/ differs from contracts/out (for CI).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const subgraphDir = join(here, "..");
const outDir = join(subgraphDir, "..", "contracts", "out");
const abiDir = join(subgraphDir, "abis");

// [file in abis/, Foundry artifact under contracts/out/]
const ABIS = [
  ["EpochManager", "EpochManager.sol/EpochManager.json"],
  ["StrikeVault", "StrikeVault.sol/StrikeVault.json"],
  ["VaultFactory", "VaultFactory.sol/VaultFactory.json"],
  ["AgentRegistry", "AgentRegistry.sol/AgentRegistry.json"],
  ["FeeManager", "FeeManager.sol/FeeManager.json"],
  ["StockOracle", "StockOracle.sol/StockOracle.json"],
  // symbol() / decimals() of stock tokens and USDG
  ["ERC20", "IERC20Metadata.sol/IERC20Metadata.json"],
];

const check = process.argv.includes("--check");

// Format like the repo's prettier config so `pnpm format:check` stays green. Prettier is a root devDependency.
let format = async (text) => text;
try {
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(join(abiDir, "x.json"))) ?? {};
  format = (text) => prettier.format(text, { ...options, parser: "json" });
} catch {
  console.warn("prettier not found; writing unformatted JSON");
}

if (!existsSync(outDir)) {
  console.error(`No Foundry output at ${outDir}. Run \`forge build\` in contracts/ first.`);
  process.exit(1);
}
mkdirSync(abiDir, { recursive: true });

let stale = 0;
for (const [name, artifact] of ABIS) {
  const src = join(outDir, artifact);
  if (!existsSync(src)) {
    console.error(`Missing ${src}. Run \`forge build\` in contracts/.`);
    process.exit(1);
  }
  const { abi } = JSON.parse(readFileSync(src, "utf8"));
  if (!Array.isArray(abi)) {
    console.error(`${src} has no "abi" array`);
    process.exit(1);
  }
  const text = await format(JSON.stringify(abi, null, 2) + "\n");
  const dest = join(abiDir, `${name}.json`);
  const current = existsSync(dest) ? readFileSync(dest, "utf8") : "";
  if (current === text) {
    console.log(`= abis/${name}.json`);
    continue;
  }
  if (check) {
    console.error(`✗ abis/${name}.json is out of date`);
    stale++;
    continue;
  }
  writeFileSync(dest, text);
  console.log(`✓ abis/${name}.json`);
}
if (stale) {
  console.error(`${stale} ABI(s) out of date: run \`pnpm --filter @strike/subgraph abis\``);
  process.exit(1);
}
