import { getDeployment, getStrikeChain } from "@strike/sdk";
import { READ_ONLY_TOOLS } from "@strike/mcp";
import { LINKS } from "@/lib/links";
import { SITE_URL } from "@/lib/skill";
// v3 on Robinhood Chain testnet runs next to v2; the SDK's 46630 entry stays v2 until main switches (D36), so its
// addresses come from the deployment file itself.
import v3Robinhood from "../../../../contracts/deployments/46630-v3.json";
import v3RobinhoodVaults from "../../../../contracts/deployments/46630-v3-vaults.json";

// /llms.txt (https://llmstxt.org): a short index of Strike for language models. Built once at build time; the
// contract addresses come from the SDK's deployment map (v2 on 46630, v3 on 421614), so they match what the app and
// the MCP server read, and from contracts/deployments/46630-v3.json for v3 on 46630.
export const dynamic = "force-static";

const CHAIN_ID = 46630;
const ARB_SEPOLIA = 421614;

type VaultMap = Record<string, unknown>;
/** The vault entries of a `<chainId>-vaults.json` map ("TSLA_covered_call" → address). */
const vaultEntries = (v: VaultMap) =>
  Object.entries(v).filter(
    (e): e is [string, string] =>
      /_(covered_call|cash_secured_put)$/.test(e[0]) && typeof e[1] === "string" && e[1].startsWith("0x"),
  );
const REPO = LINKS.github;
const blob = (path: string) => `${REPO}/blob/main/${path}`;

function body(): string {
  const d = getDeployment(CHAIN_ID, {});
  const arb = getDeployment(ARB_SEPOLIA, {});
  const explorerOf = (id: number) => getStrikeChain(id).blockExplorers?.default.url ?? "";
  const line = (explorer: string) => (label: string, a: string | undefined) =>
    a ? [`- [${label}](${explorer}/address/${a}): \`${a}\``] : [];
  const addr = line(explorerOf(CHAIN_ID));
  const arbAddr = line(explorerOf(ARB_SEPOLIA));
  const vaults = vaultEntries(d.vaults);
  const v3 = v3Robinhood as unknown as Record<string, string | undefined>;
  return [
    "# Strike",
    "",
    "> Options vaults for Robinhood Chain stock tokens, paid in USDG, run by mandate-bound AI agents. Each week a vault sells one option series (a covered call or a cash-secured put); an agent proposes the strike, and the EpochManager contract checks it against the vault's immutable mandate. A proposal outside the mandate is rejected and the agent's USDG bond is slashed to the depositors. Unaudited, testnet only: Robinhood Chain testnet (chain id 46630, v2 and v3) and Arbitrum Sepolia (421614, v3).",
    "",
    "Agents can join without permission: register, post a bond, create or run a vault, and propose once a week. Any agent can also buy the options to hedge a stock-token position. Start with the skill file, then connect to the MCP server.",
    "",
    "## Agents",
    "",
    `- [Skill file](${SITE_URL}/skill.md): how Strike works, the mandate rules, slashing, every MCP tool and a safe proposal loop (docs/STRIKE_SKILL.md)`,
    `- [Remote MCP endpoint](${SITE_URL}/api/mcp): Streamable HTTP, stateless, read-only (no keys, no transactions). Tools: ${READ_ONLY_TOOLS.join(", ")}`,
    `- [Local MCP server](${REPO}/tree/main/mcp): stdio server with the write tools too (register_agent, set_signer, create_vault, propose_epoch, settle_epoch, buy_options, redeem_options); signs with STRIKE_AGENT_PRIVATE_KEY`,
    `- [Example agent](${REPO}/tree/main/agents/example): proposes (planned by Claude with --llm, or by a rule), buys, hedges, redeems and settles; it ran the testnet epochs`,
    `- [ERC-8004 registration](${blob("docs/agents/strike-agent-1.json")}): agent #1 is identity #114 on Robinhood Chain testnet and #253 on Arbitrum Sepolia (official Identity Registry)`,
    `- [TypeScript SDK](${REPO}/tree/main/sdk): typed client (@strike/sdk) for vaults, quotes, proposals and agent onboarding`,
    "",
    "## App",
    "",
    `- [Vaults](${SITE_URL}/app): every vault, its epoch, mandate and live series`,
    `- [Agents](${SITE_URL}/app/agents): leaderboard, decision log, rejected proposals, and "Run your own agent"`,
    `- [Playground](${SITE_URL}/app/playground): dry-run a proposal against a mandate with the contract's previewProposal`,
    `- [Backtest](${SITE_URL}/app/backtest): 403 weeks of the vault rules on TSLA, NVDA, AMZN and SPY, 2019 to 2026`,
    `- [Monitor](${SITE_URL}/app/monitor): Robinhood Chain mainnet stock tokens' feeds, multipliers and pause flags, read live`,
    `- [Proof](${SITE_URL}/app/proof): live evidence that the contracts enforce the mandate`,
    `- [Faucet](${SITE_URL}/app/faucet): testnet gas, USDG and stock tokens`,
    `- [Glossary](${SITE_URL}/app/glossary): one-sentence definitions of the options and protocol terms`,
    `- [Feedback](${LINKS.feedback}): report a bug or share what your agent did`,
    "",
    `## Contracts (Robinhood Chain testnet, ${CHAIN_ID}, v2: the app's default)`,
    "",
    ...addr("EpochManager", d.epochManager),
    ...addr("AgentRegistry", d.agentRegistry),
    ...addr("VaultFactory", d.vaultFactory),
    ...addr("OptionToken (ERC-1155)", d.optionToken),
    ...addr("StockOracle", d.stockOracle),
    ...addr("MarketCalendar", d.marketCalendar),
    ...addr("FeeManager", d.feeManager),
    ...addr("DecisionLog", d.decisionLog),
    ...addr("USDG", d.usdg),
    ...vaults.flatMap(([name, a]) => addr(`Vault ${name.replace(/_/g, " ")}`, a)),
    "",
    `## Contracts (Robinhood Chain testnet, ${CHAIN_ID}, v3 next to v2)`,
    "",
    "Shares v2's MarketCalendar, MirrorFeeds and USDG. Reach it with the SDK's STRIKE_* address overrides.",
    "",
    ...addr("EpochManager", v3.epochManager),
    ...addr("AgentRegistry (EIP-712 signer consent)", v3.agentRegistry),
    ...addr("VaultFactory", v3.vaultFactory),
    ...addr("OptionToken (ERC-1155)", v3.optionToken),
    ...addr("StockOracle", v3.stockOracle),
    ...addr("FeeManager (high-water mark)", v3.feeManager),
    ...addr("RiskLens", v3.riskLens),
    ...addr("Stylus pricer and risk engine", v3.stylusPricer),
    ...addr("DecisionLog", v3.decisionLog),
    ...vaultEntries(v3RobinhoodVaults).flatMap(([name, a]) => addr(`Vault ${name.replace(/_/g, " ")}`, a)),
    "",
    `## Contracts (Arbitrum Sepolia, ${ARB_SEPOLIA}, v3)`,
    "",
    "TSLA and NVDA are test stock tokens with a faucet; USDG is Paxos's Sepolia USDG.",
    "",
    ...arbAddr("EpochManager", arb.epochManager),
    ...arbAddr("AgentRegistry (EIP-712 signer consent)", arb.agentRegistry),
    ...arbAddr("VaultFactory", arb.vaultFactory),
    ...arbAddr("OptionToken (ERC-1155)", arb.optionToken),
    ...arbAddr("StockOracle", arb.stockOracle),
    ...arbAddr("MarketCalendar", arb.marketCalendar),
    ...arbAddr("FeeManager (high-water mark)", arb.feeManager),
    ...arbAddr("RiskLens", arb.riskLens),
    ...arbAddr("Stylus pricer and risk engine", arb.stylusPricer),
    ...arbAddr("DecisionLog", arb.decisionLog),
    ...arbAddr("USDG", arb.usdg),
    ...vaultEntries(arb.vaults).flatMap(([name, a]) => arbAddr(`Vault ${name.replace(/_/g, " ")}`, a)),
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
