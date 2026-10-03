# @strike/indexer

An event indexer for Strike with a real database. It reads every log of every Strike deployment on Robinhood Chain
testnet (v2 and v3) and Arbitrum Sepolia (v3) from its deploy block into Postgres, keeps up with the chain head,
and serves the numbers over HTTP: the app's `/api/stats` answer, a paginated event feed, agents and epochs.

Why it exists ([D41](../../docs/decisions.md)): the app's `/api/stats` scans the whole log history of three
deployments on every cache miss and keeps the answer in memory for ten minutes. That works at testnet size, but
nothing is kept, two instances can disagree while their caches differ, and there is nowhere to ask "which events
made this number". The indexer stores each log once, under a key that makes re-reading harmless, handles reorgs,
and is one place the app, the bot and anyone else can read the same numbers from. `/api/stats` stays as it is, as
the fallback.

```
contracts/deployments/*.json ──► ChainIndexer (one per chain) ──► Postgres ──► GET /stats /events /agents /epochs
 or strike.config.json            getLogs in chunks, confirmations,   events, blocks,    /health /ready
                                  reorg check, single writer           cursors, views
```

## Run it with Docker Compose

From the repository root:

```bash
cp .env.example .env            # set POSTGRES_PASSWORD (URL-safe characters); everything else is optional
docker compose up -d --build    # postgres (named volume, healthcheck) and the indexer
curl -s localhost:8787/ready    # 503 while it catches up, 200 once every chain is within 1000 blocks of its head
curl -s localhost:8787/stats
```

The first sync of both testnets took 30 seconds from an empty volume on 2 October (263 events). The indexer image is
multi-stage and runs as the unprivileged `node` user; its `HEALTHCHECK` calls `/health`. The compose file passes each
container only the variables it uses, read from `.env` when you run `up`; no secret is in an image. The Telegram bot
has a Dockerfile too and is in the compose file behind the `bot` profile (`docker compose --profile bot up -d
telegram-bot`), because Telegram serves one process per token: start it only where no other copy runs.

`docker compose exec postgres psql -U strike` opens a SQL shell; the views below are the quickest way in.

## Run it without Docker

```bash
export DATABASE_URL=postgres://user:pass@127.0.0.1:5432/strike
corepack pnpm --filter @strike/indexer dev        # the service (tsx, from source)
corepack pnpm --filter @strike/indexer once --compare https://strike-options.vercel.app/api/stats
corepack pnpm --filter @strike/indexer compare http://127.0.0.1:8787/stats https://strike-options.vercel.app/api/stats
```

`once` applies the migrations, indexes every chain up to the head minus the confirmations, reads the vault values,
prints the stored events and the counts, and with `--compare` checks them against another `/stats` answer (exit
code 3 on a difference). `compare` checks two running answers. `pnpm build` bundles each command into one file in
`dist/` (`node dist/main.js`), with the SDK, viem, pg, pino and fastify inside.

## Environment

All optional except `DATABASE_URL`. The root [`.env.example`](../../.env.example) lists them too.

| Variable                                         | Default                                         | What                                                                                          |
| ------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                   | required                                        | Postgres connection string                                                                    |
| `PORT`, `HOST`                                   | `8787` (or `services.indexer.port`), `0.0.0.0`  | API address                                                                                   |
| `ALCHEMY_API_KEY`                                | unset                                           | Alchemy first for every chain, the key in a header ([`sdk/src/rpc.ts`](../../sdk/src/rpc.ts)) |
| `RPC_URL_46630`, `RPC_URL_421614`                | the chains' public RPCs                         | Per-chain RPC (passed to the SDK as `STRIKE_RPC_URL` for that chain only)                     |
| `INDEXER_CHAINS`                                 | every configured chain                          | Comma-separated chain ids                                                                     |
| `CONFIRMATIONS`                                  | `5`                                             | Blocks behind the head that are indexed                                                       |
| `POLL_INTERVAL_SECONDS`                          | `10`                                            | Time between passes                                                                           |
| `LOG_MAX_RANGE`                                  | `500000`                                        | Largest `eth_getLogs` range; halved on a range or size refusal, grown back after successes    |
| `READY_MAX_LAG_BLOCKS`                           | `1000`                                          | `/ready` fails when a chain is further behind its head                                        |
| `READY_MAX_HEAD_AGE_SECONDS`                     | `300`                                           | `/ready` fails when the head was last read longer ago (the RPC is down)                       |
| `RATE_LIMIT_MAX`                                 | `120`                                           | Requests per client IP per window on every route except `/health`; `0` turns the limit off    |
| `RATE_LIMIT_WINDOW_SECONDS`                      | `60`                                            | The window; over the limit a request gets 429 with `Retry-After` and no database query        |
| `TRUST_PROXY`                                    | `false`                                         | `true` behind a reverse proxy: the client IP comes from `X-Forwarded-For`, not the socket     |
| `TVL_INTERVAL_SECONDS`                           | `300`                                           | How often vault values are read; `0` turns it off                                             |
| `SHUTDOWN_TIMEOUT_SECONDS`                       | `25`                                            | How long SIGTERM waits for the chunk in flight                                                |
| `PGPOOL_MAX`                                     | `10`                                            | Read connections for the API                                                                  |
| `LOG_LEVEL`                                      | `info`                                          | pino level                                                                                    |
| `STRIKE_ROOT`, `STRIKE_CONFIG`, `MIGRATIONS_DIR` | found from the working directory, set in Docker | Where `strike.config.json`, `contracts/deployments` and `migrations/` are                     |

What to index comes from `strike.config.json` at the repository root when it exists (the shared config every
component reads, [D42](../../docs/decisions.md): each chain's `deployments` files, `name`, `explorer`, and
`services.indexer.port`), else from `contracts/deployments/{46630,46630-v3,421614}.json` and their `-vaults.json`
files, the three deployments `/api/stats` counts. A chain without deployments (4663, the mainnet feeds chain) is
skipped. The five MirrorFeeds that v2 and v3 share on 46630 are read once, by v2.

## Endpoints

| Endpoint                                                     | Answer                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                                                | Liveness, no database call: `{status, uptimeSeconds, writer}`                                                                                                                                                                                                                  |
| `GET /ready`                                                 | 200 when the database answers and every chain is within `READY_MAX_LAG_BLOCKS` of its head (read within `READY_MAX_HEAD_AGE_SECONDS`), else 503; per chain: head, finalized block, lag, head age, last error, each deployment's cursor and lag, and the reasons when not ready |
| `GET /stats[?chain=]`                                        | The app's `/api/stats` shape (same keys, same counting rules) plus an `indexer` block with each deployment's indexed block and lag                                                                                                                                             |
| `GET /events?chain=&type=&vault=&deployment=&limit=&cursor=` | Events, newest first; `type` takes event names, comma-separated; `vault` matches events the vault emitted or that name it; `limit` 1 to 500 (50); `nextCursor` until the last page                                                                                             |
| `GET /agents[?chain=]`                                       | Every agent per deployment: owner, current signer, ERC-8004 id, status, bonded, slashed, unbonded (base units), proposals accepted and rejected, decision records                                                                                                              |
| `GET /epochs?chain=&vault=&state=&limit=`                    | Epochs, newest first: spot at open, the accepted series, settlement or abort; `state` is `open`, `running`, `settled` or `aborted`                                                                                                                                             |

Every response has an `x-request-id` (the caller's when it sends a sane one). Integers that can exceed 2^53 (amounts,
series ids) are decimal strings. Logs are JSON on stdout (pino): requests with their id, status and time; each
indexed range with chain, deployment, block range, log count, rows inserted and duration; each pass with head,
finalized block and target; reorgs; vault values. SIGTERM or SIGINT stops it cleanly: the API stops taking requests,
the chunk in flight commits or rolls back, the writer lock is released, exit code 0.

## Schema

Plain SQL migrations in [`migrations/`](migrations), applied in order at start (and by `pnpm migrate`), each in a
transaction and recorded in `schema_migrations` with a checksum; an applied migration whose file changed stops the
start. Instances starting together wait on an advisory lock, so each migration runs once.

| Table         | What                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chains`      | Chain id, name, short name, explorer                                                                                                                                                                        |
| `deployments` | One per deployment record (`46630-v2`, `46630-v3`, `421614-v3`): deploy block, core addresses, USDG decimals                                                                                                |
| `contracts`   | Every address whose logs are read: the core contracts, the MirrorFeeds, the vaults (from `-vaults.json`, or found from `VaultCreated`)                                                                      |
| `cursors`     | Per deployment: `last_indexed_block`, its hash, `last_finalized_block`                                                                                                                                      |
| `chain_heads` | The head and finalized block last read, and the last error, for `/ready`                                                                                                                                    |
| `blocks`      | Hashes of blocks that still can reorg (event blocks and each range's last block); pruned below the finalized block                                                                                          |
| `events`      | Every log: chain, deployment, block number, hash and time, transaction, log index, address, contract kind, event name, decoded `args` (jsonb), raw topics and data. `UNIQUE (chain_id, tx_hash, log_index)` |
| `vault_tvl`   | Vault values over time (the latest one feeds `/stats`)                                                                                                                                                      |
| `reorgs`      | Every rollback: stale block, fork block, events removed                                                                                                                                                     |

Views: `v_vaults`, `v_epochs`, `v_series`, `v_buys`, `v_rejections`, `v_slashes`, `v_agents`, `v_decision_records`,
`v_vault_flows` (deposits, withdrawals, queued requests and claims), `v_mirror_pushes` (keeper rounds into the
MirrorFeeds) and `v_wallet_roles` (the app's wallet rules). They are plain views over `events`, so a rollback
updates them too. A log that no ABI decodes is kept raw (`event_name` null) and never counted.

## Idempotency, reorgs and the single writer

- **Idempotent.** A log is identified by `(chain_id, tx_hash, log_index)` and inserted with `ON CONFLICT DO
NOTHING`, in the same transaction as the cursor update. Re-running a range, overlapping ranges or a crash between
  a read and a commit never duplicates a row; the cursor only moves when a range continues the indexed one, never
  past a gap.
- **Confirmations.** Each pass indexes up to `head - CONFIRMATIONS`. Logs come from `eth_getLogs` in chunks; a
  chunk the RPC refuses as too large is retried in halves (the public Arbitrum Sepolia RPC refused 500k, 250k and
  125k blocks and took 62.5k on 2 October); other failures are retried with backoff, then the pass fails and the next
  one starts from the cursor.
- **Reorgs.** The hash of each range's last block is stored with the cursor and compared with the chain at the
  start of every pass. A block hash commits to its parents, so a match means everything below is still on the
  chain. On a mismatch, the stored block hashes are walked down to the highest one that still matches (the fork
  point; never below the finalized block); events, discovered vaults and hashes above it are deleted, the cursor
  moves back to it, the rollback is logged in `reorgs`, and the blocks are read again. Each chunk also checks every
  log's block hash against the block header it fetches for the timestamp, and that the block before the chunk
  still has its stored hash, so a reorg during a pass is caught before the cursor moves.
- **Single writer.** The writer holds a Postgres advisory lock on its own connection and runs every write
  transaction on that connection: if the connection drops, Postgres releases the lock and the writes fail with it.
  A second instance cannot get the lock, serves the API read-only from the same database, and takes over when the
  lock frees up.

## Tests

```bash
corepack pnpm --filter @strike/indexer test
```

53 tests, all against a real Postgres: `TEST_DATABASE_URL` when set (a server you run, or a CI service container),
otherwise an embedded Postgres 17 that the `embedded-postgres` package starts in `~/.cache` and removes afterwards.
Each test file gets its own database. The chain is an in-memory fake (`test/helpers.ts`) whose logs are encoded with
the SDK's ABIs, with hashes that change when a test replaces blocks.

CI runs the suite twice: on the embedded Postgres in the `js` job, and on a `postgres:17-alpine` service container
with `TEST_DATABASE_URL` in the `indexer-postgres` job. The `docker` job lints both Dockerfiles with hadolint, builds
the images, runs `docker compose config -q`, starts `postgres` and `indexer` with compose and waits for the image's
healthcheck, then checks `/health` (200), that every migration is applied and that SIGTERM stops the indexer with exit
code 0. `/ready` is polled for two minutes and only warns, because it depends on the public testnet RPCs.

```bash
# The same suite on a server you run (any Postgres 17; the user must be able to create databases)
docker run -d --rm --name strike-test-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres corepack pnpm --filter @strike/indexer test
```

| File                 | What it proves                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations.test.ts` | Migrations apply from an empty database, in order; the second run is a no-op; two instances starting together apply each once; an edited migration stops the start                                                                                                                                                                                                                       |
| `ingest.test.ts`     | Fixture logs stored and decoded, vaults found from events; the same range twice leaves identical rows; overlapping ranges equal one range; no cursor past a gap; range halving; retries; confirmations; backfill of a contract added later; reorgs: rollback to the fork point and re-index, a vault found in a replaced block, a reorg during a pass, nothing below the finalized block |
| `lock.test.ts`       | A second writer is refused and cannot write; hand-over on release; a killed writer connection stops the writer and frees the lock; queued transactions never interleave                                                                                                                                                                                                                  |
| `stats.test.ts`      | `/stats` equals the app's own `aggregateUsage` on the same logs (three deployments on two chains, team and outside wallets, a wallet on both chains, an unvalued vault), field by field; the copied team list and chain labels match the app's                                                                                                                                           |
| `api.test.ts`        | `/health` and request ids; `/ready` before the first head, within the threshold and behind it (with the numbers and reasons); `/events` pages through every event newest first without repeats, filters, 400s; `/agents`, `/epochs`, `/stats`; the service serves HTTP, stays the only writer and stops cleanly                                                                          |
| `rate-limit.test.ts` | The per-client limit: 429 with `Retry-After` before any database query, `/health` exempt, one client does not use up another's window, `X-Forwarded-For` counted only with `TRUST_PROXY`, bounded memory, the environment settings                                                                                                                                                       |
| `config.test.ts`     | The deployment records, and the same deployments from a `strike.config.json` in the current schema; `INDEXER_CHAINS`; environment validation                                                                                                                                                                                                                                             |
| `net.test.ts`        | The RPC DNS cache: one lookup for a burst, family filter, expiry, failures not cached; fetch through the pooled agent                                                                                                                                                                                                                                                                    |

## The live check (2 October 2026)

`pnpm once --compare https://strike-options.vercel.app/api/stats` against a local Postgres, from the deploy blocks,
over the public RPCs: 263 events (46630-v2 142, 46630-v3 52, 421614-v3 69, including 94 MirrorFeed rounds) in
38 seconds, and all 19 counted figures equal the live `/api/stats` for each deployment and the total: 7 vaults,
6 epochs opened, 1 aborted, 3 proposals accepted and 3 rejected, 3 buys of 12 options for 26.295249 USDG, 30 USDG
slashed, 7 deposits, 1 withdrawal, 4 agents, 6 bonds of 280 USDG, 5 decision records, 5 wallets, 0 outside the
team. Value locked agreed too ($5,590.20), though it is not compared: it moves with the spot price. The indexer
reads a few blocks less far than the app (its confirmations, and the app's answer is cached); an event inside that
gap would show up in the app first and in the indexer one pass later. A second run inserted 0 rows. The same check
against the Docker Compose stack (`pnpm compare`) agreed as well.

## Notes

- On one Docker host here, the embedded DNS took 4 seconds per lookup (it falls back to resolvers the network
  blocks). Node's fetch looks up the host for every new connection, so bursts of parallel reads failed with "fetch
  failed". The RPC clients now share one keep-alive pool with a DNS cache ([`src/net.ts`](src/net.ts)), and the
  first sync took 30 seconds instead of minutes of retries. If lookups are slow on your host anyway, set `dns:` for
  the indexer in a `docker-compose.override.yml`.
- Not deployed anywhere yet; the plan is the same AWS account as the Telegram bot. The app does not read from it
  yet.
