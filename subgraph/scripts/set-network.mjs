#!/usr/bin/env node
// Fills subgraph/networks.json from a deployment file written by contracts/script/Deploy.s.sol.
//
//   node scripts/set-network.mjs <chainId> [--deployments <file>] [--network <name>]... [--start-block <n>]
//
// Examples:
//   pnpm --filter @strike/subgraph set-network 421614      # Arbitrum Sepolia
//   pnpm --filter @strike/subgraph set-network 46630       # Robinhood Chain testnet
//   pnpm --filter @strike/subgraph set-network 4663        # Robinhood Chain mainnet
//   pnpm --filter @strike/subgraph set-network 31337 --network localhost
//
// Then build or deploy with `graph build --network <name>` (graph-cli copies the entry into subgraph.yaml).
//
// Network names differ per indexer, so one chain can fill several entries:
//   421614 arbitrum-sepolia                        (The Graph Studio, Goldsky, Ormi)
//   46630  robinhood-sepolia (The Graph registry id), robinhood-testnet (Goldsky)
//   4663   robinhood (The Graph registry id, Ormi, Sentio), robinhood-mainnet (Goldsky)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const subgraphDir = join(here, "..");
const contractsDir = join(subgraphDir, "..", "contracts");
const networksFile = join(subgraphDir, "networks.json");

const NETWORKS_BY_CHAIN = {
  421614: ["arbitrum-sepolia"],
  46630: ["robinhood-sepolia", "robinhood-testnet"],
  4663: ["robinhood", "robinhood-mainnet"],
};

// subgraph.yaml data source name -> field in deployments/<chainId>.json
const SOURCES = {
  EpochManager: "epochManager",
  VaultFactory: "vaultFactory",
  AgentRegistry: "agentRegistry",
  StockOracle: "stockOracle",
  FeeManager: "feeManager",
};

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    "usage: set-network.mjs <chainId> [--deployments <file>] [--network <name>]... [--start-block <n>]",
  );
  process.exit(1);
}

// ------------------------------------------------------------------ arguments

const args = process.argv.slice(2);
let chainId;
let deploymentsPath;
let startBlockOverride;
const networkOverrides = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--deployments") deploymentsPath = args[++i];
  else if (arg === "--network") networkOverrides.push(args[++i]);
  else if (arg === "--start-block") startBlockOverride = Number(args[++i]);
  else if (arg === "-h" || arg === "--help") usage();
  else if (chainId === undefined) chainId = arg;
  else usage(`unexpected argument ${arg}`);
}
if (!chainId || !/^\d+$/.test(chainId)) usage("chainId is required (e.g. 46630)");
if (networkOverrides.some((n) => !n)) usage("--network needs a name");
if (startBlockOverride !== undefined && !(Number.isInteger(startBlockOverride) && startBlockOverride >= 0)) {
  usage("--start-block must be a non-negative integer");
}

const networks = networkOverrides.length ? networkOverrides : NETWORKS_BY_CHAIN[chainId];
if (!networks) usage(`no graph network known for chain ${chainId}; pass --network <name>`);

// ------------------------------------------------------------------ deployment

const file = resolve(deploymentsPath ?? join(contractsDir, "deployments", `${chainId}.json`));
if (!existsSync(file)) usage(`deployment file not found: ${file} (run contracts/script/Deploy.s.sol first)`);
const deployment = JSON.parse(readFileSync(file, "utf8"));
if (deployment.chainId !== undefined && String(deployment.chainId) !== chainId) {
  usage(`${file} is for chain ${deployment.chainId}, not ${chainId}`);
}

const addresses = {};
for (const [source, field] of Object.entries(SOURCES)) {
  const address = deployment[field];
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    usage(`${file}: "${field}" is missing or not an address`);
  }
  if (/^0x0{40}$/.test(address)) usage(`${file}: "${field}" is the zero address`);
  addresses[source] = address;
}

/// First block to index. The deploy script records `block.number` before broadcasting, so every constructor
/// event (FeesSet, ParamsSet, ...) is at or after it. Falls back to the earliest broadcast receipt.
function startBlock() {
  if (startBlockOverride !== undefined) return { block: startBlockOverride, from: "--start-block" };
  const recorded = Number(deployment.block ?? 0);
  if (Number.isInteger(recorded) && recorded > 0) return { block: recorded, from: `${file} "block"` };
  const run = join(contractsDir, "broadcast", "Deploy.s.sol", chainId, "run-latest.json");
  if (existsSync(run)) {
    const blocks = (JSON.parse(readFileSync(run, "utf8")).receipts ?? [])
      .map((r) => Number(BigInt(r.blockNumber)))
      .filter((b) => b > 0);
    if (blocks.length) return { block: Math.min(...blocks), from: `${run} (earliest receipt)` };
  }
  return { block: 0, from: "default (no block recorded)" };
}
const start = startBlock();

// ------------------------------------------------------------------ write networks.json

const config = existsSync(networksFile) ? JSON.parse(readFileSync(networksFile, "utf8")) : {};
for (const network of networks) {
  config[network] = Object.fromEntries(
    Object.entries(addresses).map(([source, address]) => [source, { address, startBlock: start.block }]),
  );
}

let text = JSON.stringify(config, null, 2) + "\n";
try {
  // Match the repo's prettier config so `pnpm format:check` stays green.
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(networksFile)) ?? {};
  text = await prettier.format(text, { ...options, parser: "json" });
} catch {
  // prettier is optional here
}
writeFileSync(networksFile, text);

console.log(`networks.json <- ${file}`);
console.log(`  startBlock ${start.block} (${start.from})`);
for (const [source, address] of Object.entries(addresses)) console.log(`  ${source.padEnd(14)} ${address}`);
console.log(`  networks: ${networks.join(", ")}`);
if (start.block === 0) console.warn("warning: startBlock is 0; indexing will scan the whole chain");
console.log(`\nNext: pnpm --filter @strike/subgraph exec graph build --network ${networks[0]}`);
