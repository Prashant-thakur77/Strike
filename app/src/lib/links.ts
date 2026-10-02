import { REPO_URL, chainConfig } from "./config";

// The repository and the chains' faucets come from strike.config.json (services.repository, chains.<id>.faucet).
const faucet = (chainId: number) => {
  const url = chainConfig(chainId).faucet;
  if (!url) throw new Error(`strike.config.json gives chain ${chainId} no faucet`);
  return url;
};

export const LINKS = {
  github: REPO_URL,
  docs: `${REPO_URL}/tree/main/docs`,
  judges: `${REPO_URL}/blob/main/docs/JUDGES.md`,
  skill: `${REPO_URL}/blob/main/docs/STRIKE_SKILL.md`,
  company: `${REPO_URL}#building-strike-as-a-company`,
  design: `${REPO_URL}/blob/main/docs/design.md`,
  /** Who and what is trusted, including the settlement rule (the price rows of the table). */
  trustModel: `${REPO_URL}/blob/main/docs/trust-model.md#the-table`,
  /** The runbook's step on waiting for the first mainnet print after expiry. */
  settlementWait: `${REPO_URL}/blob/main/docs/operations.md#2-after-2000-utc-wait-for-the-first-mainnet-print-after-the-close`,
  feedback: `${REPO_URL}/issues/new?template=testnet-feedback.yml`,
  robinhoodFaucet: faucet(46630),
  /** Paxos's USDG faucet (every testnet Paxos serves; not a chain's gas faucet). */
  paxosFaucet: "https://faucet.paxos.com/",
  arbSepoliaFaucet: faucet(421614),
} as const;
