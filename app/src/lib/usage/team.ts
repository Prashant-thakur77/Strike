// Wallets the Strike team controls, so the usage panel can say how much of the testnet activity came from someone
// else. Every address here signed something during the team's own runs; each line says which run and where it is
// written down. Anything not on this list counts as "outside the team", which is the number that only grows when
// someone we do not control uses the protocol. Keep this list complete: a forgotten team wallet would be reported as
// an outside user. A wallet we hand to a tester stays off the list (their activity is theirs).

export interface TeamWallet {
  address: `0x${string}`;
  /** Who it is, in a few words (shown on /app/proof). */
  short: string;
  /** Who it is, in full. */
  label: string;
  /** Where the wallet's role is recorded in the repository. */
  source: string;
}

export const TEAM_WALLETS: readonly TeamWallet[] = [
  {
    address: "0x26b277b434B1670f207Afd8946edA9AF78A613Ff",
    short: "deployer",
    label: "Deployer: keeper, curator, agent #1 owner (and v2 signer), the 29 September buyer agent",
    source:
      "contracts/deployments/*.json (deployer); docs/testnet-epochs/2026-09-29.md (buyer mode ran as it)",
  },
  {
    address: "0x4fd9565bf8C0Bda9bBdF2Add233d19c64e50AC6f",
    short: "agent #1's v3 signer",
    label: "Agent #1 signer on v3 (Robinhood Chain testnet and Arbitrum Sepolia)",
    source: "contracts/deployments/46630-v3.json and 421614.json (agent.signer)",
  },
  {
    address: "0x4501c16dc4f29394560F9B2aB935667cA058B79b",
    short: "agent #2 (demo video wallet)",
    label: "Agent #2 and its vault's curator and depositor: the demo video's throwaway wallet",
    source: "docs/testnet-epochs/2026-10-01-agent2.md",
  },
  {
    address: "0x1a00BaDC191FFcB65d16D27C0d1F3599528F7364",
    short: "buyer agent, Robinhood Chain v3",
    label: "Buyer agent, Robinhood Chain testnet v3 epoch of 1 October",
    source: "docs/testnet-epochs/2026-09-30-v3.md (section 7)",
  },
  {
    address: "0x85f0A3A3cb02253e578ec3BE2feDE1F1a1dC33E1",
    short: "buyer agent, Arbitrum Sepolia",
    label: "Buyer agent, Arbitrum Sepolia v3 epoch of 30 September",
    source: "docs/testnet-epochs/2026-09-30-arbitrum-sepolia.md",
  },
  {
    address: "0x7767ca2d944A91e6ae896f85cACA4DfDE1810044",
    short: "QA test wallet 1 (3 Oct)",
    label: "QA test wallets (3 Oct): team wallet 1 of 3 for the end-to-end test of the live app",
    source: "docs/testnet-epochs/2026-10-03-end-to-end-qa.md",
  },
  {
    address: "0x2E89c1C42A76507dB832E9b78403AB50bd8D9957",
    short: "QA test wallet 2 (3 Oct)",
    label: "QA test wallets (3 Oct): team wallet 2 of 3 for the end-to-end test of the live app",
    source: "docs/testnet-epochs/2026-10-03-end-to-end-qa.md",
  },
  {
    address: "0x84bEBDF6736b3f438c9344fb653C80e89Db05F5D",
    short: "QA test wallet 3 (3 Oct)",
    label: "QA test wallets (3 Oct): team wallet 3 of 3 for the end-to-end test of the live app",
    source: "docs/testnet-epochs/2026-10-03-end-to-end-qa.md",
  },
  {
    address: "0xc10D28DF05aC093dE8d1bc281D3B5d6f7322d86d",
    short: "QA test wallet 4 (3 Oct)",
    label: "QA test wallets (3 Oct): team wallet 4, the fresh wallet used to test the gas drip end to end",
    source: "docs/DEPLOYMENTS.md",
  },
  {
    address: "0xA84936fA307909e01C3C9710D4cEE179385d5e9c",
    short: "Gas drip relayer",
    label: "Team relayer that submits GasDrip.drip for new users (D49)",
    source: "docs/DEPLOYMENTS.md",
  },
  {
    address: "0x80Eec5F968aeBc078f2d58fF8b84775570c180C4",
    short: "x402 relayer",
    label: "Team relayer that settles x402 payments for the paid agent API (D48)",
    source: "docs/testnet-epochs/2026-10-03-x402.md",
  },
];

const TEAM = new Set(TEAM_WALLETS.map((w) => w.address.toLowerCase()));

/** True when `address` is one of {@link TEAM_WALLETS} (case-insensitive). */
export function isTeamWallet(address: string): boolean {
  return TEAM.has(address.toLowerCase());
}
