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
  feedback: `${REPO_URL}/issues/new?template=testnet-feedback.yml`,
  robinhoodFaucet: faucet(46630),
  /** Paxos's USDG faucet (every testnet Paxos serves; not a chain's gas faucet). */
  paxosFaucet: "https://faucet.paxos.com/",
  arbSepoliaFaucet: faucet(421614),
} as const;
