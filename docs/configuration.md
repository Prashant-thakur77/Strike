# Configuration: `strike.config.json`

One file at the repository root, [`strike.config.json`](../strike.config.json), names everything about Strike that is
not code and not a secret: the chains, their RPCs and explorers, the deployment files that hold each chain's
addresses, the mainnet Chainlink feeds the testnet keeper mirrors, the public services, and the names of the
environment variables that hold secrets. Every component reads it, so an endpoint or a deployment changes in one
place. Its JSON Schema is [`strike.config.schema.json`](../strike.config.schema.json) (editors that understand
`$schema` complete and check it as you type). Why one file and not an `.env` per package: [D42](decisions.md).

The file holds no secrets. The `secrets` block lists variable names; the values stay in `.env` files (gitignored),
GitHub Actions secrets, Vercel environment variables and AWS SSM. A test fails if anything in the file looks like a key
or token, and the SDK refuses to load such a file.

## The file

```json
{
  "$schema": "./strike.config.schema.json",
  "version": 1,
  "defaultChainId": 46630,
  "chains": {
    "46630": {
      "name": "Robinhood Chain testnet",
      "shortName": "RH testnet",
      "testnet": true,
      "explorer": "https://explorer.testnet.chain.robinhood.com",
      "verifierUrl": "https://explorer.testnet.chain.robinhood.com/api/",
      "faucet": "https://faucet.testnet.chain.robinhood.com/",
      "rpc": {
        "public": "https://rpc.testnet.chain.robinhood.com",
        "alchemy": "https://robinhood-testnet.g.alchemy.com/v2"
      },
      "deployments": ["contracts/deployments/46630.json", "contracts/deployments/46630-v3.json"],
      "mainnetFeedsChain": "4663",
      "confirmations": 5,
      "subgraphNetworks": ["robinhood-sepolia", "robinhood-testnet"]
    },
    "421614": { "...": "Arbitrum Sepolia, v3" },
    "4663": { "...": "Robinhood Chain mainnet: no deployment; its Chainlink stock feeds in `stocks`" },
    "42161": { "...": "Arbitrum One: no deployment; known to the SDK" },
    "31337": { "...": "the local anvil devnet of scripts/demo-local.sh (`local: true`)" }
  },
  "services": {
    "app": "https://strike-options.vercel.app",
    "mcp": "https://strike-options.vercel.app/api/mcp",
    "indexer": { "port": 8787 },
    "telegramBot": "https://t.me/strike_options_bot",
    "waitlistForm": "",
    "repository": "https://github.com/Prashant-thakur77/Strike"
  },
  "secrets": {
    "deployerKey": "PRIVATE_KEY",
    "agentSignerKey": "AGENT_SIGNER_KEY",
    "alchemyKey": "ALCHEMY_API_KEY",
    "telegramToken": "TELEGRAM_BOT_TOKEN",
    "databaseUrl": "DATABASE_URL",
    "...": "eleven more roles, below"
  }
}
```

## Fields

### Top level

| Field            | Meaning                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `version`        | Schema version, `1`. A breaking change to the shape bumps it.                                                   |
| `defaultChainId` | The chain a component uses when `STRIKE_CHAIN_ID` is unset, and the app's default network. Must be in `chains`. |
| `chains`         | Every chain Strike reads or deploys to, keyed by chain id (as a string).                                        |
| `services`       | The public endpoints and ports of the services.                                                                 |
| `secrets`        | Environment variable names by role. Names only.                                                                 |

### `chains.<chainId>`

| Field               | Meaning                                                                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `shortName` | Display names (the app's network menu and badges). The SDK's viem chain objects keep viem's own `name` ("Robinhood Chain Testnet"), which decision records already carry.                                                                           |
| `testnet`           | Whether the chain is a testnet (the app labels it).                                                                                                                                                                                                 |
| `local`             | `true` for the local devnet (31337): its deployment files are written by `scripts/demo-local.sh`, are gitignored, and may be missing.                                                                                                               |
| `explorer`          | Block explorer base URL: links are `<explorer>/tx/<hash>` and `<explorer>/address/<address>`. `null` where there is none.                                                                                                                           |
| `verifierUrl`       | The Blockscout API contracts are verified against (`forge --verifier blockscout --verifier-url`, `scripts/deploy-testnet.sh`). On Arbitrum Sepolia it is Blockscout while `explorer` is Arbiscan.                                                   |
| `faucet`            | Where testers get the chain's gas token (the app's faucet page).                                                                                                                                                                                    |
| `rpc.public`        | The keyless public RPC. Every component's default and the fallback behind Alchemy.                                                                                                                                                                  |
| `rpc.alchemy`       | Alchemy's URL for the chain without the key (`https://<network>.g.alchemy.com/v2`), or `null`. With `ALCHEMY_API_KEY` set, Node components send the key in an `Authorization` header and `cast` gets it appended to this URL ([D39](decisions.md)). |
| `deployments`       | The chain's deployment files, the primary first. The primary is the SDK's default deployment of the chain (`getDeployment`); the rest are its secondary deployments (`deploymentsFor`), in this order. Each has a `<file>-vaults.json` beside it.   |
| `mainnetFeedsChain` | The chain whose Chainlink rounds this chain's `MirrorFeed`s copy (`"4663"` for the testnets and the devnet). Absent: the keeper mirrors nothing.                                                                                                    |
| `confirmations`     | Blocks after which an event counts as final: the indexer's reorg-safe cursor. 5 on live chains, 0 on the devnet.                                                                                                                                    |
| `subgraphNetworks`  | The Graph's network names for the chain (`subgraph/scripts/set-network.mjs`).                                                                                                                                                                       |
| `stocks`            | Stock tokens and their Chainlink feeds by symbol, on chains that have them (4663): what the keeper mirrors to the testnets and what the app's mainnet monitor reads. Addresses are EIP-55 checksummed.                                              |

Contract addresses are not in this file. They stay in the deployment files `contracts/script/Deploy.s.sol` writes
(`contracts/deployments/<chainId>.json` and `-vaults.json`); the config lists which files count, and in what order.

### `services`

| Field          | Meaning                                                                                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`          | The public web app (absolute links in `/llms.txt` and `/skill.md`, the demo video).                                                                                                                                                                                                                                 |
| `mcp`          | The remote, read-only MCP endpoint (`mcp/scripts/remote-check.mjs`'s default).                                                                                                                                                                                                                                      |
| `indexer.port` | The indexer's HTTP port.                                                                                                                                                                                                                                                                                            |
| `telegramBot`  | The bot's `t.me` link.                                                                                                                                                                                                                                                                                              |
| `waitlistForm` | Unused since 3 October: sign-up is the form on [`/waitlist`](https://strike-options.vercel.app/waitlist), which stores encrypted entries in a private Vercel Blob store ([D46](decisions.md)). Kept, empty, as a fallback: a team-run Google Forms or Tally link the schema still checks. The app does not read it. |
| `repository`   | The GitHub repository: the app's links, and the URL decision records are anchored with on-chain.                                                                                                                                                                                                                    |

### `x402`

The paid route ([ENDPOINTS.md](ENDPOINTS.md#paid-route-x402), [D48](decisions.md)). Prices and addresses are public; the relayer key is a secret (`secrets.x402RelayerKey`). Absent: the app sells nothing and `paid_risk_report` is not registered.

| Field               | Meaning                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`           | `2`: x402 version 2 (headers `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`).                                                        |
| `scheme`            | `"exact"`: an EIP-3009 `transferWithAuthorization` for exactly the price.                                                                         |
| `facilitator`       | `"self"`: the app verifies and settles with its relayer key; or an `https://` facilitator URL.                                                    |
| `payTo`             | Who receives the payments.                                                                                                                        |
| `maxTimeoutSeconds` | How long a signed payment stays valid (default 120).                                                                                              |
| `agentRunCap`       | The most an agent's MCP server pays in one run, in token units (`STRIKE_X402_MAX_SPEND` overrides it).                                            |
| `routes.<name>`     | `path`, `price` per call in token units ("0.01") and `description` (sent in the 402). `riskReport` is `/api/agent/risk-report`.                   |
| `assets[]`          | Accepted tokens, the preferred first: `chainId`, `address`, `symbol`, `decimals`, and the EIP-712 `eip712Name` and `eip712Version` it signs with. |

### `secrets`

| Role               | Variable                   | Read by                                                                                                                                                                          | Where the value lives                                                                                                    |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `deployerKey`      | `PRIVATE_KEY`              | Deploy scripts, `scripts/keeper-role.sh`, `scripts/weekly-agent.sh` (agent #1's v2 signer); `scripts/keeper.sh` signs with whatever key it holds                                 | `contracts/.env` (laptop); optional GitHub secret (`agent.yml`, v2 only); `keeper.yml` passes `KEEPER_PRIVATE_KEY` in it |
| `keeperKey`        | `KEEPER_PRIVATE_KEY`       | `keeper.yml`: the CI keeper key, `KEEPER_ROLE` on the mirrored MirrorFeeds only; `scripts/weekly-agent.sh` also reads it for laptop runs                                         | GitHub Actions secret                                                                                                    |
| `agentSignerKey`   | `AGENT_SIGNER_KEY`         | `scripts/weekly-agent.sh` (agent #1's v3 signer)                                                                                                                                 | GitHub Actions secret, `contracts/.env`                                                                                  |
| `agentKey`         | `STRIKE_AGENT_PRIVATE_KEY` | The MCP server and the example agent                                                                                                                                             | The agent operator's environment; set per run by the scripts                                                             |
| `agent2Key`        | `AGENT2_PRIVATE_KEY`       | `agent.yml` (agent #2's job, passed on as `STRIKE_AGENT_PRIVATE_KEY`)                                                                                                            | GitHub Actions secret                                                                                                    |
| `alchemyKey`       | `ALCHEMY_API_KEY`          | The SDK (every Node component), `scripts/rpc.sh`, the app's `/api/rpc`                                                                                                           | Vercel (server only), GitHub secret, `.env` files, SSM for the bot                                                       |
| `anthropicKey`     | `ANTHROPIC_API_KEY`        | The example agent's Claude planner (API)                                                                                                                                         | GitHub Actions secret, the operator's environment                                                                        |
| `claudeCodeToken`  | `CLAUDE_CODE_OAUTH_TOKEN`  | The example agent's Claude planner (Claude Code CLI)                                                                                                                             | GitHub Actions secret                                                                                                    |
| `telegramToken`    | `TELEGRAM_BOT_TOKEN`       | The Telegram bot                                                                                                                                                                 | `bots/telegram/.env` (laptop), SSM SecureString (AWS)                                                                    |
| `databaseUrl`      | `DATABASE_URL`             | The indexer                                                                                                                                                                      | The indexer's environment (Docker Compose `.env`, the host's secret store)                                               |
| `testDatabaseUrl`  | `TEST_DATABASE_URL`        | The indexer's tests (a Postgres they may drop tables in)                                                                                                                         | CI's service container, your shell                                                                                       |
| `postgresPassword` | `POSTGRES_PASSWORD`        | Docker Compose's Postgres                                                                                                                                                        | The Compose `.env` (gitignored)                                                                                          |
| `arbiscanKey`      | `ARBISCAN_API_KEY`         | Contract verification on Arbiscan                                                                                                                                                | `contracts/.env`                                                                                                         |
| `githubToken`      | `GITHUB_TOKEN`             | Optional, read-only: the app's status card reads workflow runs from the GitHub API with it (60 requests an hour without)                                                         | Vercel env (server only); Actions provide their own                                                                      |
| `blobToken`        | `BLOB_READ_WRITE_TOKEN`    | The app's `/api/waitlist` and `/api/waitlist/count` (write and list the waitlist store); `scripts/waitlist-export.mjs`                                                           | Vercel env (server only), added by linking the `strike-waitlist` Blob store; the team's machine for an export            |
| `waitlistSalt`     | `WAITLIST_SALT`            | The app's `/api/waitlist` (the HMAC that names each entry and keys the rate limit; without it sign-up answers 503); `scripts/waitlist-export.mjs --delete`                       | Vercel env (server only), production and preview                                                                         |
| `x402RelayerKey`   | `X402_RELAYER_KEY`         | The app's `/api/agent/risk-report`: the testnet-only wallet that sends each x402 settlement and pays its gas (never holds a payment); without it a payment gets 503              | Vercel env (server only), production and preview                                                                         |
| `x402PayerKey`     | `STRIKE_PAYER_KEY`         | The MCP server's `paid_risk_report` and the example agent's `--paid-report` (optional; default the agent key): the wallet that signs x402 payments                               | The agent's environment                                                                                                  |
| `gasRelayerKey`    | `GAS_RELAYER_KEY`          | The app's `/api/gas-drip`: the testnet-only relayer that sends `GasDrip.drip(to)` for a new wallet (D48); without it the route answers 503 and the page links the chain's faucet | Vercel env (server only), production; the owner's copy is `.internal/gas-relayer.key`                                    |
| `gasDripSalt`      | `GAS_DRIP_SALT`            | Optional: the HMAC key for `/api/gas-drip`'s anti-bot challenges and IP keys; the relayer key is used when unset                                                                 | Vercel env (server only)                                                                                                 |

TypeScript components look the name up (`strikeSecretName("alchemyKey")` in the SDK); shell scripts use the same
names literally. The SDK's test `names every secret variable the code reads` scans the sources, scripts and
workflows and fails when a variable that looks like a secret (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`,
`DATABASE_URL`) is missing from this block. [operations.md, Keys](operations.md#keys) has the mainnet requirements.

## Who reads it

| Component                                              | How                                                                                                                                  | Fields                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK (`@strike/sdk`)                                    | `loadStrikeConfig()` (below)                                                                                                         | Chains, public RPCs and explorers (`strikeChains`, `getStrikeChain`), `rpc.alchemy` (`ALCHEMY_NETWORKS`, `rpcEndpointsFor`), `secrets.alchemyKey`                    |
| `scripts/export-abis.mjs`                              | Reads the file                                                                                                                       | `chains.*.deployments` → `sdk/src/deployments.generated.ts`; the whole file → `sdk/src/config.generated.ts`                                                          |
| `scripts/keeper.sh`                                    | `scripts/config.sh` (jq, or node)                                                                                                    | `deployments`, `mainnetFeedsChain` and that chain's `stocks`, `rpc.public`, `rpc.alchemy`, `defaultChainId`                                                          |
| `scripts/weekly-agent.sh`                              | `scripts/config.sh`                                                                                                                  | `deployments`, `rpc`, `services.repository`                                                                                                                          |
| `scripts/rpc.sh`, `deploy-testnet.sh`, `live-epoch.sh` | `scripts/config.sh`                                                                                                                  | `rpc.public`, `rpc.alchemy`, `verifierUrl`                                                                                                                           |
| MCP server                                             | The SDK                                                                                                                              | `defaultChainId`, `secrets.agentKey`, `services.mcp` (remote check)                                                                                                  |
| Telegram bot                                           | The SDK                                                                                                                              | `defaultChainId`, `explorer`, `secrets.telegramToken`                                                                                                                |
| Example agent                                          | The SDK                                                                                                                              | `defaultChainId`, `explorer`, `services.repository` (decision-record URLs)                                                                                           |
| App                                                    | The SDK (`app/src/lib/config.ts`); `monitor.ts` and `agentLog.ts` import the JSON (their Playwright specs load them without the SDK) | `name`, `shortName`, `testnet`, `defaultChainId`, `explorer`, `faucet`, `rpc.public`, `stocks` (4663), `services.app`, `services.repository`, `services.telegramBot` |
| Subgraph (`set-network.mjs`)                           | Reads the file                                                                                                                       | `subgraphNetworks`, the primary of `deployments`                                                                                                                     |
| Demo video (`video/`)                                  | `video/lib/config.mjs`                                                                                                               | `services.app`, `explorer`, `rpc.public`                                                                                                                             |
| GitHub Actions (`keeper.yml`, `agent.yml`, `ci.yml`)   | The scripts' defaults, or `jq` into `GITHUB_ENV`                                                                                     | `rpc.public`, `rpc.alchemy` (4663, fork tests)                                                                                                                       |
| Indexer (`services/indexer`)                           | The file, when present                                                                                                               | `rpc`, `deployments`, `confirmations`, `services.indexer.port`, `secrets.databaseUrl`                                                                                |

### How the file is found

- **Node** (the SDK's `loadStrikeConfig()`, so the MCP server, the bot, the agent, the app's server and build):
  the path in `STRIKE_CONFIG`, else the nearest `strike.config.json` above the working directory. The file is checked
  when it is read (shape, chain references, nothing that looks like a secret) and a bad file stops the process with
  every problem listed.
- **Browsers, the npm packages, edge runtimes:** the copy `scripts/export-abis.mjs` bundles into the SDK
  (`sdk/src/config.generated.ts`). A test fails when it differs from the file.
- **Shell:** `scripts/config.sh` reads `$STRIKE_CONFIG` or the root file with `jq`, or with `node` when `jq` is not
  installed (`STRIKE_CONFIG_READER=jq|node` forces one). `strike_config_get chains 46630 rpc public` prints one value
  (a list prints one element per line); `strike_config_keys` prints an object's keys.

Environment variables still override per run, as before: `STRIKE_CHAIN_ID`, `STRIKE_RPC_URL`, the `STRIKE_*`
address overrides (`sdk/src/deployments.ts`), `RPC_URL` and `MAINNET_RPC` for the keeper, `NEXT_PUBLIC_RPC_<chainId>`
and `NEXT_PUBLIC_DEFAULT_CHAIN_ID` for the app.

## Changing it

1. Edit `strike.config.json`.
2. `node scripts/export-abis.mjs --skip-abis` regenerates the SDK's bundled copy and deployments map (no
   `forge build` needed; without `--skip-abis` it also exports the ABIs).
3. `pnpm --filter @strike/sdk test` checks the file against the schema, that every deployment file exists and is for
   its chain, that addresses are checksummed, that nothing looks like a secret, that every secret variable in the code
   is listed, and that the bundled copy, the deployments map and the shell readers agree with the file.

Adding a deployment (a new protocol version next to an old one) is a line in the chain's `deployments`; the keeper,
the weekly agent, the SDK, the app and the bot pick it up from there.
