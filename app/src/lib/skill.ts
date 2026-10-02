// docs/STRIKE_SKILL.md, embedded at build time (see the .md rule in next.config.ts): one source for /skill.md, the
// remote MCP endpoint's strike://skill resource and /llms.txt.
import skill from "../../../docs/STRIKE_SKILL.md";
import { APP_URL } from "./config";

export const SKILL_MD: string = skill;

/** The public site, for absolute links in machine-readable files (strike.config.json's services.app). */
export const SITE_URL = APP_URL;
