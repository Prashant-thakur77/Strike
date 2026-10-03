import { deployments, deploymentsFor } from "@strike/sdk";
import type { Address } from "viem";
import { REPO_URL, chainConfig, chainExplorer } from "./config";

// Every claim on /app/proof, with the file that backs it. Update the numbers here when the source changes; the
// comment above each block names the file (and section) to re-check. The e2e test `proof.spec.ts` fails if any
// GitHub link below points to a path that does not exist in the repository.

export const REPO = REPO_URL;

/** A file in the repository on GitHub (optionally a line or a heading anchor). */
export const gh = (path: string, anchor?: number | string) =>
  `${REPO}/blob/main/${path}${anchor === undefined ? "" : typeof anchor === "number" ? `#L${anchor}` : `#${anchor}`}`;

/** A folder in the repository on GitHub. */
export const ghTree = (path: string) => `${REPO}/tree/main/${path}`;

export const PROOF_CHAIN_ID = 46630;
export const EXPLORER = chainExplorer(PROOF_CHAIN_ID);
/** The public RPC the `cargo stylus verify` commands below were run against. */
const PROOF_RPC = chainConfig(PROOF_CHAIN_ID).rpc.public;
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;

/** A link to evidence: a file, a folder, a transaction or an external page. */
export interface Evidence {
  label: string;
  href: string;
}

/* ================================================================ live deployment */

// Source: contracts/deployments/46630.json and 46630-vaults.json, mirrored into the SDK by scripts/export-abis.mjs
// (sdk/src/deployments.generated.ts). Read through the SDK so the page and the app always agree.
interface V2Deployment {
  block: number;
  epochManager: Address;
  vaultFactory: Address;
  vaultImplementation: Address;
  agentRegistry: Address;
  optionToken: Address;
  feeManager: Address;
  stockOracle: Address;
  marketCalendar: Address;
  pricer: Address;
  stylusPricer: Address;
  activePricer: Address;
  usdg: Address;
  version: string;
  sourceCommit: string;
  deployCommit: string;
  stocks: Record<string, { token: Address; feed: Address }>;
  vaults: { TSLA_covered_call: Address; TSLA_cash_secured_put: Address };
}

const v2 = deployments[String(PROOF_CHAIN_ID)] as unknown as V2Deployment;

/** The v2 deployment's TSLA MirrorFeed (contracts/deployments/46630.json). */
function tslaFeed(): Address {
  const feed = v2.stocks.TSLA?.feed;
  if (!feed) throw new Error(`no TSLA feed in the ${PROOF_CHAIN_ID} deployment`);
  return feed;
}

/** v3 next to v2 on 46630: contracts/deployments/46630-v3.json, the chain's secondary deployment in the SDK. */
const v3 = (() => {
  const d = deploymentsFor(PROOF_CHAIN_ID).find((x) => x.version === "v3");
  if (!d?.riskLens || !d.stylusPricer)
    throw new Error(`no v3 deployment with RiskLens and Stylus on ${PROOF_CHAIN_ID}`);
  return { ...d, riskLens: d.riskLens, stylusPricer: d.stylusPricer };
})();

export const DEPLOYMENT = {
  version: v2.version,
  block: v2.block,
  sourceCommit: v2.sourceCommit,
  deployCommit: v2.deployCommit,
  epochManager: v2.epochManager,
  /** The Stylus pricer the deployment file names as active (`activePricer`); the page checks it on-chain. */
  activePricer: v2.activePricer,
  stylusPricer: v2.stylusPricer,
  solidityPricer: v2.pricer,
  file: "contracts/deployments/46630.json",
  vaultsFile: "contracts/deployments/46630-vaults.json",
} as const;

/**
 * How each contract's code is checked:
 * - `blockscout`: Solidity source verified on Blockscout (exact match).
 * - `clone`: an EIP-1167 clone; Blockscout resolves it to the verified StrikeVault implementation.
 * - `stylus`: WASM, which Blockscout does not verify; reproducibly verified with `cargo stylus verify` instead.
 * - `external`: not a Strike contract (Paxos USDG); its source is verified on Blockscout by its issuer.
 */
export type Verification = "blockscout" | "clone" | "stylus" | "external";

export interface ContractFact {
  name: string;
  role: string;
  address: Address;
  verification: Verification;
  /** Solidity or Rust source in the repository. */
  source?: string;
}

// Verification states checked against the Blockscout API (/api/v2/smart-contracts/<address>) on 2026-09-30:
// every Solidity contract reports is_verified and is_fully_verified; the vaults are eip1167 proxies of the
// verified StrikeVault; the Stylus pricer has no Blockscout source (see STYLUS below).
export const CONTRACTS: readonly ContractFact[] = [
  {
    name: "EpochManager",
    role: "Epochs, proposals, mandate checks, sales and settlement",
    address: v2.epochManager,
    verification: "blockscout",
    source: "contracts/src/core/EpochManager.sol",
  },
  {
    name: "Stylus pricer",
    role: "Black-Scholes and strike solver in Rust/WASM: the active pricer",
    address: v2.stylusPricer,
    verification: "stylus",
    source: "stylus/pricer/src/math.rs",
  },
  {
    name: "BlackScholesRef",
    role: "Solidity reference pricer, kept for the on-chain equality check",
    address: v2.pricer,
    verification: "blockscout",
    source: "contracts/src/pricing/BlackScholesRef.sol",
  },
  {
    name: "TSLA covered-call vault",
    role: "ERC-4626 vault holding testnet TSLA",
    address: v2.vaults.TSLA_covered_call,
    verification: "clone",
    source: "contracts/src/vaults/StrikeVault.sol",
  },
  {
    name: "TSLA cash-secured-put vault",
    role: "ERC-4626 vault holding USDG",
    address: v2.vaults.TSLA_cash_secured_put,
    verification: "clone",
    source: "contracts/src/vaults/StrikeVault.sol",
  },
  {
    name: "StrikeVault implementation",
    role: "Code behind every vault clone",
    address: v2.vaultImplementation,
    verification: "blockscout",
    source: "contracts/src/vaults/StrikeVault.sol",
  },
  {
    name: "VaultFactory",
    role: "Creates vaults with an immutable mandate",
    address: v2.vaultFactory,
    verification: "blockscout",
    source: "contracts/src/vaults/VaultFactory.sol",
  },
  {
    name: "AgentRegistry",
    role: "Agent bonds, slashing and ERC-8004 identity",
    address: v2.agentRegistry,
    verification: "blockscout",
    source: "contracts/src/agents/AgentRegistry.sol",
  },
  {
    name: "StockOracle",
    role: "SafeStockFeed checks and settlement prices",
    address: v2.stockOracle,
    verification: "blockscout",
    source: "contracts/src/oracle/StockOracle.sol",
  },
  {
    name: "MarketCalendar",
    role: "NYSE sessions and weekly expiries",
    address: v2.marketCalendar,
    verification: "blockscout",
    source: "contracts/src/oracle/MarketCalendar.sol",
  },
  {
    name: "FeeManager",
    role: "Performance fee and the agent's share",
    address: v2.feeManager,
    verification: "blockscout",
    source: "contracts/src/core/FeeManager.sol",
  },
  {
    name: "OptionToken",
    role: "ERC-1155 option positions",
    address: v2.optionToken,
    verification: "blockscout",
    source: "contracts/src/tokens/OptionToken.sol",
  },
  {
    name: "TSLA MirrorFeed",
    role: "Testnet only: copies mainnet Chainlink TSLA rounds",
    address: tslaFeed(),
    verification: "blockscout",
    source: "contracts/src/testnet/MirrorFeed.sol",
  },
  {
    name: "USDG",
    role: "Paxos stablecoin: premium, put collateral, bonds",
    address: v2.usdg,
    verification: "external",
  },
];

export const VERIFICATION_NOTE: Record<Verification, string> = {
  blockscout: "Verified on Blockscout",
  clone: "EIP-1167 clone of the verified implementation",
  stylus: "Verified with cargo stylus verify",
  external: "Paxos contract, verified by its issuer",
};

/* ================================================================ v3, deployed next to v2 */

/** A file on the `v3-contracts` branch (v3's source, tests and deployment file live there until v3 is merged). */
export const ghV3 = (path: string) => `${REPO}/blob/v3-contracts/${path}`;

// Source: contracts/deployments/46630-v3.json (copied from v3-contracts; deployCommit 64fcb93) and
// docs/testnet-epochs/2026-09-30-v3.md ("1. Contracts": all 9 new contracts verified on Blockscout, is_fully_verified;
// "2. Stylus pricer and risk engine": cargo stylus verify "Verification successful"); vector counts from
// contracts/test/vectors/risk.json (200 greeks + 150 impliedVol + 60 scenarioLoss = 410).
export const V3 = {
  block: v3.block ?? 0,
  sourceCommit: "448d83b",
  deployCommit: "64fcb93",
  file: gh("contracts/deployments/46630-v3.json"),
  log: gh("docs/testnet-epochs/2026-09-30-v3.md"),
  design: ghV3("docs/design.md"),
  stylus: {
    address: v3.stylusPricer,
    deployTx: "0xc71be99442c8bbc9b9be9d419795ac2709b95b8b70214a465a71aeef9b89d49a",
    activationTx: "0x19277b827e7b979963e71118f69874b83c3d6c69acac58a494c49881efed417a",
    command: `cargo stylus verify --deployment-tx 0xc71b…d49a --endpoint ${PROOF_RPC}`,
    metadataHash: "ef5f968b0429b7b240d59acda917a4c8c7232ed1f53215e162e7afda5fbde267",
    wasmBytes: 23_562,
    source: ghV3("stylus/pricer/src/risk.rs"),
  },
  contracts: [
    { name: "EpochManager", address: v3.epochManager },
    { name: "RiskLens", address: v3.riskLens },
    { name: "BlackScholesRef + RiskLib", address: v3.pricer },
    { name: "FeeManager (high-water mark)", address: v3.feeManager },
    { name: "AgentRegistry (EIP-712 consent)", address: v3.agentRegistry },
    { name: "VaultFactory", address: v3.vaultFactory },
    { name: "StrikeVault implementation", address: v3.vaultImplementation },
    { name: "OptionToken", address: v3.optionToken },
    { name: "StockOracle", address: v3.stockOracle },
  ] as readonly { name: string; address: Address }[],
  vectors: {
    count: 410,
    detail: "200 greeks, 150 implied volatilities and 60 scenario losses generated by the Rust engine",
    evidence: [
      { label: "RiskVectors.t.sol", href: ghV3("contracts/test/pricing/RiskVectors.t.sol") },
      { label: "test/vectors/risk.json", href: ghV3("contracts/test/vectors/risk.json") },
      { label: "RiskDifferential.t.sol", href: ghV3("contracts/test/differential/RiskDifferential.t.sol") },
      { label: "stylus/pricer/src/risk.rs", href: ghV3("stylus/pricer/src/risk.rs") },
    ] as readonly Evidence[],
  },
} as const;

/* ================================================================ Stylus */

// Source: docs/gas.md, "The live Stylus pricer is verifiably this source" and the two gas tables.
export const STYLUS = {
  deployTx: "0x93fccce03198d72320afc7f613b097450ea4fafad3701bae732b81180ba237fe",
  command: `cargo stylus verify --deployment-tx 0x93fc…37fe --endpoint ${PROOF_RPC}`,
  toolchain: "cargo-stylus 0.10.9, Rust 1.91.0, reproducible Docker build",
  metadataHash: "5773190b3eed71771269cdaa28bfd562adc3bc8888ddb49e2b901cf4ceca7045",
  wasmBytes: 15_574,
  doc: gh("docs/gas.md", "the-live-stylus-pricer-is-verifiably-this-source"),
  // scripts/deploy-testnet.sh: the Stylus pricer becomes EpochManager.pricer only if its quote equals the
  // Solidity reference's on-chain.
  equalityCheck: gh("scripts/deploy-testnet.sh", 54),
} as const;

export interface GasRow {
  call: string;
  inputs: string;
  solidity: number;
  stylus: number;
  /** As docs/gas.md states it. */
  verdict: string;
  /** True when Solidity is cheaper. */
  solidityWins?: boolean;
}

// Source: docs/gas.md. The first two rows are the "Inside the protocol" table (L2 execution gas of the
// EpochManager transaction, 2026-09-29, v2 contracts on a Nitro dev node); the last two are single calls through
// PricerGasProbe.
export const GAS: readonly GasRow[] = [
  {
    call: "proposeByDelta",
    inputs: "Whole transaction, 0.20 delta, strike solved on-chain",
    solidity: 1_878_918,
    stylus: 577_041,
    verdict: "3.3× less",
  },
  {
    call: "buy",
    inputs: "Whole transaction, 5 options, live Black-Scholes quote",
    solidity: 329_872,
    stylus: 301_404,
    verdict: "9% less",
  },
  {
    call: "strikeForDelta",
    inputs: "0.20-delta call, 7 days (48 Black-Scholes evaluations)",
    solidity: 1_546_443,
    stylus: 235_880,
    verdict: "6.6× less",
  },
  {
    call: "quote",
    inputs: "TSLA 250, K 275 call, 7 days, 60% vol",
    solidity: 33_969,
    stylus: 40_624,
    verdict: "1.20× more",
    solidityWins: true,
  },
];

export const GAS_SOURCE = {
  doc: gh("docs/gas.md"),
  script: gh("scripts/stylus-gas.sh"),
  e2e: gh("scripts/stylus-e2e.sh"),
  node: "offchainlabs/nitro-node:v3.7.1, Stylus program not cached",
} as const;

/* ================================================================ tests */

export interface TestFact {
  label: string;
  count: string;
  detail: string;
  evidence: Evidence[];
}

// Source: docs/evidence/facts.json (527 Foundry passing and 7 skipped, 15 Rust, 548 TypeScript = SDK 253 + MCP 84 +
// agents 158 + indexer 53, 62 Telegram bot, 10 subgraph, 315 Playwright); scripts/check-numbers.mjs fails CI when a
// count here differs from it. Re-count with `node scripts/check-numbers.mjs --measure --write`, which runs
// `forge test --no-match-path "test/{fork,differential,formal}/*" --summary` (the fork, differential and Halmos suites
// are counted under CHECKS), vitest in each TypeScript package and `npx playwright test --list` in app (tests per
// viewport), and counts the `#[test]` functions in stylus/pricer and the `test(` calls in subgraph/tests.
export const TESTS: readonly TestFact[] = [
  {
    label: "Foundry",
    count: "527",
    detail:
      "Unit, integration, fuzz, invariant, conformance and audit-regression suites (fork, differential and formal below); 7 more are skipped: settlement rules the StockCollateral example has no use for",
    evidence: [
      { label: "contracts/test", href: ghTree("contracts/test") },
      { label: "docs/testing.md", href: gh("docs/testing.md") },
    ],
  },
  {
    label: "Rust",
    count: "15",
    detail: "Stylus pricer: accuracy against closed-form Black-Scholes, parity, bounds",
    evidence: [
      { label: "stylus/pricer/src/math.rs", href: gh("stylus/pricer/src/math.rs") },
      { label: "lib.rs", href: gh("stylus/pricer/src/lib.rs") },
    ],
  },
  {
    label: "TypeScript",
    count: "548",
    detail:
      "SDK 253, MCP server 84, example agents 158, indexer 53; 2 more SDK tests are opt-in live checks against the deployed v3 registries",
    evidence: [
      { label: "sdk/test", href: ghTree("sdk/test") },
      { label: "mcp/test", href: ghTree("mcp/test") },
      { label: "agents/example/test", href: ghTree("agents/example/test") },
      { label: "services/indexer/test", href: ghTree("services/indexer/test") },
    ],
  },
  {
    label: "Telegram bot",
    count: "62",
    detail: "Log scanning with range back-off, message formatting, commands, store",
    evidence: [{ label: "bots/telegram/test", href: ghTree("bots/telegram/test") }],
  },
  {
    label: "Subgraph",
    count: "10",
    detail: "Matchstick: vault factory, lifecycle, rejection, agent registry",
    evidence: [{ label: "subgraph/tests", href: ghTree("subgraph/tests") }],
  },
  {
    label: "Playwright",
    count: "315",
    detail:
      "The app at 1440 px desktop and 390 px mobile, including this page and its links; 32 of them are the opt-in UI audit at five widths",
    evidence: [
      { label: "app/e2e", href: ghTree("app/e2e") },
      { label: "playwright.config.ts", href: gh("app/playwright.config.ts") },
    ],
  },
];

// Source: docs/testing.md "Coverage" (make coverage, Foundry --ir-minimum, production code only) and README.md
// "Safety evidence". Re-run 2026-10-02 (docs/evidence/facts.json): 99.32% lines, 99.43% statements, 98.77% branches,
// 100% functions.
// CI fails below 95% lines (.github/workflows/ci.yml).
export const COVERAGE = {
  lines: "99.3%",
  branches: "98.8%",
  statements: "99.4%",
  functions: "100%",
  evidence: [
    { label: "docs/testing.md#coverage", href: gh("docs/testing.md", "coverage") },
    { label: "CI coverage gate", href: gh(".github/workflows/ci.yml", 178) },
  ] as Evidence[],
} as const;

/* ================================================================ deeper checks */

export interface CheckFact {
  title: string;
  claim: string;
  detail: string[];
  evidence: Evidence[];
}

// Sources: docs/testing.md "Invariants" and "Mutation checks"; README.md "Safety evidence" (32,768 calls:
// contracts/foundry.toml [profile.ci.invariant] runs 256 × depth 128); contracts/test/fork (RobinhoodFork 6 +
// StockCollateralFork 3);
// contracts/test/differential/PricerDifferential.t.sol and docs/gas.md; docs/security/formal-verification.md
// (9 proven Halmos properties, 16 marked unproven) and the `formal` job in .github/workflows/ci.yml.
export const CHECKS: readonly CheckFact[] = [
  {
    title: "Invariants",
    claim: "9 properties, on a call vault and a put vault",
    detail: [
      "256 runs × 128 calls (32,768 random calls) per invariant in the CI profile",
      "Locked collateral covers the worst-case payout; the vault holds every asset it accounts for; option holders can always redeem",
    ],
    evidence: [
      { label: "StrikeInvariants.t.sol", href: gh("contracts/test/invariant/StrikeInvariants.t.sol") },
      { label: "StrikeHandler.sol", href: gh("contracts/test/invariant/StrikeHandler.sol") },
      { label: "docs/testing.md#invariants", href: gh("docs/testing.md", "invariants") },
    ],
  },
  {
    title: "Mutation checks",
    claim: "3 injected bugs, all caught by the invariants",
    detail: [
      "Settlement payout not subtracted: caught by invariant_assetBacking",
      "Premium accumulator over-credits 1%: caught by invariant_premiumSolvency",
      "Payouts rounded up: caught by invariant_optionHoldersCanAlwaysRedeem",
    ],
    evidence: [{ label: "docs/testing.md#mutation-checks", href: gh("docs/testing.md", "mutation-checks") }],
  },
  {
    title: "Fork tests",
    claim: "9 tests against Robinhood Chain mainnet (4663)",
    detail: [
      "Real TSLA, NVDA and SPY tokens and Chainlink feeds, real USDG, real ERC-8004 registries",
      "The ERC-8056 multiplier is never applied twice; a full epoch runs with real tokens",
    ],
    evidence: [
      { label: "RobinhoodFork.t.sol", href: gh("contracts/test/fork/RobinhoodFork.t.sol") },
      { label: "StockCollateralFork.t.sol", href: gh("contracts/test/fork/StockCollateralFork.t.sol") },
      { label: "CI fork job", href: gh(".github/workflows/ci.yml", 105) },
    ],
  },
  {
    title: "Rust = Solidity",
    claim: "The Stylus and Solidity pricers return identical results",
    detail: [
      "Differential fuzzing of quote, rejections and strikeForDelta (10,000+ runs)",
      "300 pricer vectors generated from Rust, and the same calls on a Nitro dev node",
      "On deploy, the Stylus pricer is only activated if its on-chain quote equals the reference",
    ],
    evidence: [
      { label: "PricerDifferential.t.sol", href: gh("contracts/test/differential/PricerDifferential.t.sol") },
      { label: "test/vectors/pricer.json", href: gh("contracts/test/vectors/pricer.json") },
      { label: "deploy-testnet.sh", href: gh("scripts/deploy-testnet.sh", 54) },
      { label: "CI differential job", href: gh(".github/workflows/ci.yml", 80) },
    ],
  },
  {
    title: "Formal properties",
    claim: "9 properties proven with Halmos for every input in range, in CI",
    detail: [
      "MandateGuard: an accepted proposal always meets the basic rules, the size cap and the yield floor; validate accepts exactly the consistent mandates",
      "FeeManager: no fee without profit; rate caps. NyseTime: sessions open before they close. Settlement: call payout within the tokens sold",
      "16 more properties time out and are marked unproven, not claimed",
    ],
    evidence: [
      { label: "formal-verification.md", href: gh("docs/security/formal-verification.md") },
      { label: "contracts/test/formal", href: ghTree("contracts/test/formal") },
    ],
  },
];

/* ================================================================ security */

export type Severity = "High" | "Medium" | "Low" | "Info";

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
}

// Source: docs/security/review-2026-09-29.md, "Findings" table (titles verbatim) and "Status: all findings fixed".
// Regression tests: contracts/test/audit (19 passing).
export const REVIEW = {
  date: "2026-09-29",
  doc: gh("docs/security/review-2026-09-29.md"),
  tests: ghTree("contracts/test/audit"),
  regressionTests: 19,
  counts: { High: 1, Medium: 3, Low: 4, Info: 3 } satisfies Record<Severity, number>,
  findings: [
    {
      id: "H-01",
      severity: "High",
      title: "A corporate action near expiry makes settlement permanently impossible",
    },
    {
      id: "M-01",
      severity: "Medium",
      title: "First-round-of-phase fallback: a caller can choose the price, or settlement bricks",
    },
    { id: "M-02", severity: "Medium", title: "Sales continue in the money, below intrinsic value" },
    { id: "M-03", severity: "Medium", title: "Oracle-latency arbitrage inside the 0.5% deviation band" },
    { id: "L-01", severity: "Low", title: "`proposeByDelta` rounding gets honest agents slashed" },
    { id: "L-02", severity: "Low", title: "Market-data races slash honest proposals" },
    { id: "L-03", severity: "Low", title: "`emergencyCancel` ignores an existing settlement price" },
    {
      id: "L-04",
      severity: "Low",
      title: "Mandate validation has no protocol floor, so agent = curator = buyer can drain a vault",
    },
    { id: "I-01", severity: "Info", title: "Share price ignores the open option liability during an epoch" },
    { id: "I-02", severity: "Info", title: "ERC-8004 link goes stale after the identity NFT is transferred" },
    { id: "I-03", severity: "Info", title: "Keeper sigma reprices live series by orders of magnitude" },
  ] as readonly Finding[],
} as const;

// Source: docs/security/slither.md ("Result (Slither 0.11, 2026-09-28): 0 High"); CI runs slither-action with
// fail-on: high (.github/workflows/ci.yml, `slither` job).
export const SLITHER = {
  result: "0 High",
  version: "Slither 0.11, 2026-09-28",
  detail: "Every remaining Medium and Low finding is listed with the reason it stays",
  doc: gh("docs/security/slither.md"),
  ci: gh(".github/workflows/ci.yml", 121),
} as const;

// Source: docs/threat-model.md, "Threats" table (T1–T25), each with its mitigation and covering test.
export const THREAT_MODEL = {
  threats: 25,
  doc: gh("docs/threat-model.md"),
} as const;

/* ================================================================ live history and research */

// Source: docs/testnet-epochs/2026-09-29.md (the live epoch's log) and README.md "v2 addresses".
export const LIVE_EPOCH_LOG = gh("docs/testnet-epochs/2026-09-29.md");

export interface ResearchItem {
  title: string;
  summary: string;
  evidence: Evidence[];
}

// Sources: docs/backtest.md ("The main result"), docs/litepaper.md (abstract).
export const RESEARCH: readonly ResearchItem[] = [
  {
    title: "Backtest, 2019–2026",
    summary:
      "403 weeks of weekly vaults on TSLA, NVDA, AMZN and SPY. At 0.20 delta the covered call lagged buy-and-hold on every ticker, with 25–46% less volatility and smaller drawdowns; the put vault earned −3.8% to +3.7% a year depending on the volatility assumption.",
    evidence: [
      { label: "docs/backtest.md", href: gh("docs/backtest.md") },
      { label: "research/backtest.py", href: gh("research/backtest.py") },
      { label: "research/data", href: ghTree("research/data") },
    ],
  },
  {
    title: "Litepaper",
    summary:
      "Mechanism and solvency argument, the mandate as a constraint system, when a reckless proposal is unprofitable, the fixed-point pricer, safety and limitations.",
    evidence: [{ label: "docs/litepaper.md", href: gh("docs/litepaper.md") }],
  },
];
