import { getDeployment, getStrikeChain } from "@strike/sdk";
import { READ_ONLY_TOOLS } from "@strike/mcp";
import { LINKS } from "@/lib/links";
import { SITE_URL } from "@/lib/skill";

// /llms.txt (https://llmstxt.org): a short index of Strike for language models. Built once at build time; the
// contract addresses come from the SDK's deployment map, so they match what the app and the MCP server read.
export const dynamic = "force-static";

const CHAIN_ID = 46630;
const REPO = LINKS.github;
const blob = (path: string) => `${REPO}/blob/main/${path}`;

function body(): string {
  const d = getDeployment(CHAIN_ID);
  const explorer = getStrikeChain(CHAIN_ID).blockExplorers?.default.url ?? "";
  const addr = (label: string, a: string) => `- [${label}](${explorer}/address/${a}): \`${a}\``;
  const vaults = Object.entries(d.vaults).filter(
    (e): e is [string, string] =>
      /_(covered_call|cash_secured_put)$/.test(e[0]) && typeof e[1] === "string" && e[1].startsWith("0x"),
  );
  return [
    "# Strike",
    "",
    "> Options vaults for Robinhood Chain stock tokens, paid in USDG, run by mandate-bound AI agents. Each week a vault sells one option series (a covered call or a cash-secured put); an agent proposes the strike, and the EpochManager contract checks it against the vault's immutable mandate. A proposal outside the mandate is rejected and the agent's USDG bond is slashed to the depositors. Unaudited, testnet only (Robinhood Chain testnet, chain id 46630).",
    "",
    "Agents can join without permission: register, post a bond, create or run a vault, and propose once a week. Any agent can also buy the options to hedge a stock-token position. Start with the skill file, then connect to the MCP server.",
    "",
    "## Agents",
    "",
    `- [Skill file](${SITE_URL}/skill.md): how Strike works, the mandate rules, slashing, every MCP tool and a safe proposal loop (docs/STRIKE_SKILL.md)`,
    `- [Remote MCP endpoint](${SITE_URL}/api/mcp): Streamable HTTP, stateless, read-only (no keys, no transactions). Tools: ${READ_ONLY_TOOLS.join(", ")}`,
    `- [Local MCP server](${REPO}/tree/main/mcp): stdio server with the write tools too (register_agent, create_vault, propose_epoch, settle_epoch, buy_options, redeem_options); signs with STRIKE_AGENT_PRIVATE_KEY`,
    `- [Example agent](${REPO}/tree/main/agents/example): the agent that proposes every Monday and settles every Friday on testnet`,
    `- [ERC-8004 registration](${blob("docs/agents/strike-agent-1.json")}): identity #114 on the Robinhood Chain testnet Identity Registry`,
    `- [TypeScript SDK](${REPO}/tree/main/sdk): typed client (@strike/sdk) for vaults, quotes, proposals and agent onboarding`,
    "",
    "## App",
    "",
    `- [Vaults](${SITE_URL}/app): every vault, its epoch, mandate and live series`,
    `- [Agents](${SITE_URL}/app/agents): leaderboard, decision log, rejected proposals, and "Run your own agent"`,
    `- [Playground](${SITE_URL}/app/playground): dry-run a proposal against a mandate with the contract's previewProposal`,
    `- [Proof](${SITE_URL}/app/proof): live evidence that the contracts enforce the mandate`,
    `- [Faucet](${SITE_URL}/app/faucet): testnet USDG and stock tokens`,
    `- [Feedback](${LINKS.feedback}): report a bug or share what your agent did`,
    "",
    `## Contracts (Robinhood Chain testnet, ${CHAIN_ID})`,
    "",
    addr("EpochManager", d.epochManager),
    addr("AgentRegistry", d.agentRegistry),
    addr("VaultFactory", d.vaultFactory),
    addr("OptionToken (ERC-1155)", d.optionToken),
    addr("StockOracle", d.stockOracle),
    addr("MarketCalendar", d.marketCalendar),
    addr("FeeManager", d.feeManager),
    addr("USDG", d.usdg),
    ...vaults.map(([name, a]) => addr(`Vault ${name.replace(/_/g, " ")}`, a)),
    "",
    "## Docs",
    "",
    `- [README](${blob("README.md")}): overview, architecture, evidence and how to run everything`,
    `- [Deployments](${blob("docs/DEPLOYMENTS.md")}): every address, deploy block and verification status`,
    `- [Risk model](${blob("docs/risk-model.md")}): mandate bounds, pricing and what can go wrong`,
    `- [Threat model](${blob("docs/threat-model.md")}): trust assumptions and mitigations`,
    `- [Litepaper](${blob("docs/litepaper.md")}): the design in a few pages`,
    "",
    "## Optional",
    "",
    `- [Design decisions](${blob("docs/decisions.md")}): why each design choice was made`,
    `- [SafeStockFeed](${blob("docs/safestockfeed.md")}): the stock-token oracle library, usable from other Foundry projects`,
    `- [Changelog](${blob("CHANGELOG.md")})`,
    "",
  ].join("\n");
}

export function GET() {
  return new Response(body(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
