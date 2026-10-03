// Labels and lists the app also keeps, copied here so /stats has the app's exact shape without importing the app.
// test/parity.test.ts fails if either list drifts from app/src/lib/usage/team.ts or app/src/lib/chains.ts.

/** Chain names as the app's usage panel shows them (app/src/lib/chains.ts `CHAIN_META`). */
export const CHAIN_LABELS: Readonly<Record<number, { name: string; short: string }>> = {
  46630: { name: "Robinhood Chain testnet", short: "RH testnet" },
  421614: { name: "Arbitrum Sepolia", short: "Arb Sepolia" },
  4663: { name: "Robinhood Chain", short: "Robinhood" },
  31337: { name: "Local devnet", short: "Local" },
};

/**
 * Wallets the Strike team controls (app/src/lib/usage/team.ts `TEAM_WALLETS`), lowercase. Activity from any other
 * address counts as "outside the team".
 */
export const TEAM_WALLETS: readonly string[] = [
  "0x26b277b434b1670f207afd8946eda9af78a613ff",
  "0x4fd9565bf8c0bda9bbdf2add233d19c64e50ac6f",
  "0x4501c16dc4f29394560f9b2ab935667ca058b79b",
  "0x1a00badc191ffcb65d16d27c0d1f3599528f7364",
  "0x85f0a3a3cb02253e578ec3be2fede1f1a1dc33e1",
  // QA test wallets (3 Oct): docs/testnet-epochs/2026-10-03-end-to-end-qa.md
  "0x7767ca2d944a91e6ae896f85caca4dfde1810044",
  "0x2e89c1c42a76507db832e9b78403ab50bd8d9957",
  "0x84bebdf6736b3f438c9344fb653c80e89db05f5d",
  // QA wallet 4 and the gas-drip and x402 relayers (3 Oct)
  "0xc10d28df05ac093de8d1bc281d3b5d6f7322d86d",
  "0xa84936fa307909e01c3c9710d4cee179385d5e9c",
  "0x80eec5f968aebc078f2d58ff8b84775570c180c4",
];
