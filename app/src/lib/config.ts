import { loadStrikeConfig, type StrikeChainConfig } from "@strike/sdk";

// strike.config.json (docs/configuration.md): the app's chains, explorers, faucets, site and repository URLs. On the
// server and at build time the SDK reads the file; in the browser it has the copy bundled into the SDK, which a test
// keeps equal to the file.

export const STRIKE_CONFIG = loadStrikeConfig();

/** The config's entry for a chain the app relies on; throws at build time when it is missing. */
export function chainConfig(chainId: number): StrikeChainConfig {
  const c = STRIKE_CONFIG.chains[String(chainId)];
  if (!c) throw new Error(`strike.config.json has no chain ${chainId}`);
  return c;
}

/** The chain's block explorer base URL; throws at build time when the config gives none. */
export function chainExplorer(chainId: number): string {
  const url = chainConfig(chainId).explorer;
  if (!url) throw new Error(`strike.config.json gives chain ${chainId} no explorer`);
  return url;
}

/** The GitHub repository, e.g. https://github.com/Prashant-thakur77/Strike. */
export const REPO_URL = STRIKE_CONFIG.services.repository;

/** "owner/name" of the repository, for the GitHub API. */
export const REPO_SLUG = REPO_URL.replace(/^https:\/\/github\.com\//, "");

/** The public site. */
export const APP_URL = STRIKE_CONFIG.services.app;
