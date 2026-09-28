/** Mon 2026-10-05 15:00 UTC: the NYSE is open, the week's expiry is Fri 2026-10-09 20:00 UTC. */
export declare const DEVNET_TIMESTAMP: number;
/** Anvil's well-known dev keys (accounts 0-2). Account 0 deploys, curates and is the agent signer. */
export declare const ANVIL_KEYS: readonly [`0x${string}`, `0x${string}`, `0x${string}`];

/** `contracts/deployments/31337.json`. */
export interface DevnetDeployment {
  chainId: number;
  deployer: `0x${string}`;
  usdg: `0x${string}`;
  epochManager: `0x${string}`;
  vaultFactory: `0x${string}`;
  agentRegistry: `0x${string}`;
  optionToken: `0x${string}`;
  feeManager: `0x${string}`;
  stockOracle: `0x${string}`;
  marketCalendar: `0x${string}`;
  pricer: `0x${string}`;
  vaultImplementation: `0x${string}`;
  stocks: Record<string, { token: `0x${string}`; feed: `0x${string}` }>;
}

/** `contracts/deployments/31337-vaults.json`. */
export interface DevnetVaults {
  agentId: number;
  agentSigner: `0x${string}`;
  TSLA_covered_call: `0x${string}`;
  TSLA_cash_secured_put: `0x${string}`;
}

export interface Devnet {
  rpcUrl: string;
  port: number;
  deployment: DevnetDeployment;
  vaults: DevnetVaults;
  stop(): void;
}

/** Why the devnet cannot start here (null when it can). Set STRIKE_DEVNET=0 to skip on purpose. */
export declare function devnetUnavailableReason(): string | null;

/** Start anvil on a free port and deploy Strike with the Foundry Deploy and Seed scripts. */
export declare function startDevnet(): Promise<Devnet>;
