# @strike/telegram-bot

Live: [@strike_options_bot](https://t.me/strike_options_bot). Send `/subscribe` for alerts, or `/vaults`, `/quote sTSLA-CC`, `/agent 1`, `/status`.

A small, read-only Telegram bot for Strike. It watches the EpochManager's logs and posts a short alert to every
subscribed chat when an epoch opens, a series is proposed, a proposal is rejected (with the slash), options are
bought, or an epoch settles, aborts or is cancelled. It also answers a few lookup commands.

The bot holds no keys and sends no transactions. It only needs a Telegram bot token and an RPC endpoint.

## What it sends

Alerts are plain text: vault symbol, strike in USD, expiry in UTC, sizes and premiums in human units, the
mandate reason name for rejections, and an explorer link (Blockscout on Robinhood Chain testnet, Arbiscan on
Arbitrum Sepolia). These are real alerts from Robinhood Chain testnet
(46630):

```
sTSLA-CC: new call series on sale (epoch 1)
Strike $369.86, expiry 2026-10-02 20:00 UTC
Size 4 TSLA calls at 100% of fair value ($2.1266 per option), |delta| 0.20
Tx: https://explorer.testnet.chain.robinhood.com/tx/0x92169eac7bd2491d1f22f394e15643d5d54309c1e980683cf82a13088021a9d4

sTSLA-CSP: agent 1 proposal rejected, DeltaOutOfBand (epoch 1)
Slashed 10 USDG from the agent's bond; it goes to the vault's depositors at epoch close.
Proposed 0.045397 TSLA puts, strike $352.44, expiry 2026-10-02 20:00 UTC, 100% of fair value
Why: The option's |delta| is outside the mandate's delta band.
Tx: https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0
```

Events: `EpochOpened`, `SeriesProposed`, `ProposalRejected`, `OptionsBought`, `EpochSettled`, `EpochAborted`,
`SeriesCancelled`.

## Commands

| Command                   | Answer                                                                        |
| ------------------------- | ----------------------------------------------------------------------------- |
| `/start`, `/help`         | The command list                                                              |
| `/subscribe`              | Send alerts to this chat                                                      |
| `/unsubscribe`            | Stop alerts for this chat                                                     |
| `/vaults`                 | Each vault's epoch state, TVL and live series                                 |
| `/quote <vault> [amount]` | USDG premium for N options (default 1) of the vault's live series (SDK quote) |
| `/agent <id>`             | Bond, strikes, accepted and rejected proposals, status                        |
| `/status`                 | Chain head, NYSE session, and the price feed status of each underlying        |

`<vault>` is the share symbol (`sTSLA-CC`, case does not matter) or the vault address. In groups, commands
addressed to another bot (`/status@OtherBot`) are ignored.

## Create the bot (BotFather)

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a display name (for example "Strike Alerts") and a username ending in `bot`.
3. BotFather replies with a token like `123456789:AA...`. Treat it as a password: put it in `.env`, never in
   git, a chat or a screenshot. `/revoke` in BotFather replaces a leaked token.
4. Optional: send `/setcommands` to BotFather, choose the bot, and paste:

   ```
   subscribe - get Strike alerts in this chat
   unsubscribe - stop alerts
   vaults - vault state, TVL and live series
   quote - premium for N options: /quote sTSLA-CC 2
   agent - agent bond, strikes and record: /agent 1
   status - chain head and price feed status
   help - command list
   ```

5. To use it in a group, add the bot to the group and send `/subscribe` there. The bot only reads commands, so
   privacy mode can stay on.

## Configuration

Copy `.env.example` to `.env` in this directory (the bot loads it on start; real environment variables win).

| Variable                | Default                    | Meaning                                                            |
| ----------------------- | -------------------------- | ------------------------------------------------------------------ |
| `TELEGRAM_BOT_TOKEN`    | none                       | BotFather token. Required to run the bot, not for the dry run.     |
| `STRIKE_CHAIN_ID`       | `46630`                    | A chain in the SDK's deployment map (see [Chains](#chains))        |
| `STRIKE_RPC_URL`        | the chain's public RPC     | Your own RPC endpoint                                              |
| `ALCHEMY_API_KEY`       | unset                      | Read through Alchemy first, with the public RPC as fallback        |
| `DATA_DIR`              | `./data`                   | Where `state-<chainId>.json` (subscribers, log cursor) is kept     |
| `POLL_INTERVAL_SECONDS` | `15`                       | How often to check for new logs                                    |
| `LOG_BLOCK_RANGE`       | `50000`                    | Largest `getLogs` range; halved automatically when the RPC refuses |
| `TELEGRAM_API_URL`      | `https://api.telegram.org` | A self-hosted Bot API server (or a mock in tests)                  |

## Chains

The bot reads whichever deployment the SDK resolves for `STRIKE_CHAIN_ID`:

| Chain                       | `STRIKE_CHAIN_ID` | Deployment                                                                                                                                                                                                                             |
| --------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Robinhood Chain testnet     | `46630` (default) | v2, the SDK's `46630` entry                                                                                                                                                                                                            |
| Robinhood Chain testnet, v3 | `46630`           | v3, through the SDK's address overrides (`STRIKE_EPOCH_MANAGER`, `STRIKE_AGENT_REGISTRY`, … and `STRIKE_DEPLOY_BLOCK=126713718`; the list is in [the v3 epoch log](../../docs/testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october)) |
| Arbitrum Sepolia            | `421614`          | v3, the SDK's `421614` entry                                                                                                                                                                                                           |
| Local devnet                | `31337`           | `scripts/demo-local.sh`                                                                                                                                                                                                                |
| Robinhood Chain mainnet     | `4663`            | Once Strike is deployed there                                                                                                                                                                                                          |

v3 emits the same seven events as v2. The state file is named by chain id only, so run v2 and v3 on Robinhood Chain
testnet with separate `DATA_DIR`s. The tests and the sample alerts above use Robinhood Chain testnet v2.

## Run it locally

From the repository root (Node 22, pnpm):

```sh
pnpm install
cp bots/telegram/.env.example bots/telegram/.env   # then set TELEGRAM_BOT_TOKEN

# Preview: print the alerts it would send for the whole on-chain history. No token needed, nothing is sent,
# no state is written. Extra arguments run commands and print the replies.
pnpm --filter @strike/telegram-bot dry-run
pnpm --filter @strike/telegram-bot dry-run "/vaults" "/quote sTSLA-CC 1" "/agent 1" "/status"

# Run the bot (long polling; Ctrl-C to stop).
pnpm --filter @strike/telegram-bot start
```

Then message the bot `/subscribe`.

On the first start (no state file) the bot scans from the Strike deploy block (from
`contracts/deployments/<chainId>.json`, via the SDK), so it catches up on history before new blocks. Chats that
subscribe during that first catch-up may receive a few older alerts.

## How it works

- **Alerts.** Every `POLL_INTERVAL_SECONDS`, the bot reads the chain head and fetches the seven EpochManager
  events with viem `getLogs` from the stored cursor, in chunks of up to `LOG_BLOCK_RANGE` blocks. A chunk the
  RPC refuses (range or result limits) is retried at half the size; other errors back off exponentially (1 s,
  2 s, 4 s, ... up to 30 s). Each chunk's logs are joined with vault and series data before any message goes
  out; the cursor is saved after the chunk is delivered. A crash can repeat at most one chunk of alerts, and
  never skips one.
- **Delivery.** Each alert goes to every subscribed chat in turn. A 429 waits out Telegram's `retry_after`; 5xx
  and network errors back off and retry. A chat that blocked the bot or no longer exists (403) is
  unsubscribed. One failing chat never holds up the others.
- **Commands.** Long polling with `getUpdates` over plain `fetch` (no framework). The update offset is stored,
  so a restart does not answer the same command twice.
- **State.** One JSON file per chain in `DATA_DIR`, written atomically (temporary file, then rename).

## Deploy

The bot is a single long-running process with outbound HTTPS only (no inbound port, no webhook). Keep
`DATA_DIR` on persistent storage and run one instance per token (two instances polling one token make Telegram
return 409 Conflict).

### AWS (EC2, CloudFormation)

[`infra/aws`](../../infra/aws/README.md) runs the bot on one `t4g.nano` instance: no SSH key and no inbound port
(Session Manager for access), the token and the optional `ALCHEMY_API_KEY` in SSM Parameter Store SecureStrings, logs
in CloudWatch Logs, `DATA_DIR` on the instance's disk, about $8.29 a month in ap-southeast-1. Template ready;
deployment pending. Stop the local bot first (it saves its state on SIGTERM), then from the repository root:

```sh
infra/aws/deploy-bot.sh --i-stopped-the-local-bot   # token from .env into SSM, state file carried over, waits for the bot
infra/aws/update-bot.sh                             # later: git pull on the instance and restart
aws logs tail /strike/telegram-bot --region ap-southeast-1 --follow
```

### Docker

[`Dockerfile`](Dockerfile) builds from the repository root and runs the bot the way the AWS unit does (node with
`tsx` on the sources), as the unprivileged `node` user, with `DATA_DIR=/data` on a volume. The token is never in
the image; it comes from the environment. The root `docker-compose.yml` has it behind the `bot` profile, reading
`TELEGRAM_BOT_TOKEN` (and the optional `ALCHEMY_API_KEY`, `STRIKE_CHAIN_ID`) from the root `.env`:

```sh
docker compose --profile bot up -d --build telegram-bot   # only where no other copy of the bot runs
docker compose logs -f telegram-bot
```

### Small VPS (systemd)

```sh
# as a normal user on the server
git clone https://github.com/Prashant-thakur77/Strike.git strike && cd strike
corepack enable && pnpm install --frozen-lockfile
cp bots/telegram/.env.example bots/telegram/.env && chmod 600 bots/telegram/.env   # set the token
```

`/etc/systemd/system/strike-bot.service`:

```ini
[Unit]
Description=Strike Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
User=strike
WorkingDirectory=/home/strike/strike/bots/telegram
Environment=DATA_DIR=/home/strike/strike-bot-data
ExecStart=/usr/bin/env pnpm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now strike-bot
journalctl -u strike-bot -f
```

`pnpm start` runs the TypeScript directly with `tsx`, against the SDK's source. To run the compiled output
instead, build the SDK first (`pnpm --filter @strike/sdk build && pnpm --filter @strike/telegram-bot build`)
and use `node dist/index.js`. An SDK build older than the current `contracts/deployments` scans the old
addresses.

### Fly.io or Render

Run it as a background worker (no HTTP service) with a persistent volume for `DATA_DIR`:

- **Fly.io:** a machine with a volume (`fly volumes create strike_bot_data --size 1`, mounted at `/data`), no
  `[http_service]` section, `DATA_DIR=/data`, and the token set with `fly secrets set TELEGRAM_BOT_TOKEN=...`.
- **Render:** a Background Worker with build command `corepack enable && pnpm install --frozen-lockfile`, start
  command `pnpm --filter @strike/telegram-bot start`, a persistent disk mounted at, say, `/var/data`, and
  `DATA_DIR=/var/data`. Set the token as a secret environment variable.

Without a persistent volume the bot still works, but it forgets its subscribers on every redeploy and re-scans
from the deploy block.

## Development

```sh
pnpm --filter @strike/telegram-bot test   # vitest: formatting, commands, store, log scanning, send loop
pnpm --filter @strike/telegram-bot lint   # tsc --noEmit
```

The tests use real Robinhood Chain testnet values (the sTSLA-CC covered call at $369.86, the rejected put with
10 USDG slashed, 4 calls bought for 10.005944 USDG) and a fake `fetch` in place of the Telegram API.
