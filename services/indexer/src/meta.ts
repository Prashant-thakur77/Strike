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
];
