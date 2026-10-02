// strike.config.json for the video scripts: the app URL, the chains' explorers and RPCs (docs/configuration.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./engine.mjs";

export const STRIKE_CONFIG = JSON.parse(readFileSync(join(ROOT, "strike.config.json"), "utf8"));

/** A chain's entry in the config; throws when it is missing. */
export function chainConfig(chainId) {
  const c = STRIKE_CONFIG.chains[String(chainId)];
  if (!c) throw new Error(`strike.config.json has no chain ${chainId}`);
  return c;
}
