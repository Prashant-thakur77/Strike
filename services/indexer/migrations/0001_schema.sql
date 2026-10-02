-- Strike indexer schema. Applied once, in a transaction, by src/db.ts (tracked in schema_migrations).
-- Addresses and hashes are stored lowercase. Block numbers are bigint; token amounts stay exact as numeric in `args`.

CREATE TABLE chains (
  chain_id integer PRIMARY KEY,
  name text NOT NULL,
  short_name text NOT NULL,
  explorer text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One Strike deployment (a set of contracts at one version on one chain), from contracts/deployments/*.json.
CREATE TABLE deployments (
  id text PRIMARY KEY, -- "<chainId>-<version>", e.g. "46630-v3" (the app's /api/stats key)
  chain_id integer NOT NULL REFERENCES chains (chain_id),
  version text NOT NULL,
  ordinal integer NOT NULL, -- order in the config, used for listing
  deploy_block bigint NOT NULL CHECK (deploy_block >= 0),
  usdg text NOT NULL,
  usdg_decimals smallint, -- read from the chain once; null until then
  stock_oracle text NOT NULL,
  epoch_manager text NOT NULL,
  vault_factory text NOT NULL,
  agent_registry text NOT NULL,
  decision_log text,
  source_file text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every address whose logs are read. Vaults found from VaultCreated or VaultRegistered are `discovered` and are
-- removed with the event that found them when a reorg rolls it back.
CREATE TABLE contracts (
  chain_id integer NOT NULL REFERENCES chains (chain_id),
  address text NOT NULL CHECK (address = lower(address)),
  deployment_id text NOT NULL REFERENCES deployments (id),
  kind text NOT NULL CHECK (
    kind IN ('epochManager', 'vaultFactory', 'agentRegistry', 'decisionLog', 'vault', 'mirrorFeed')
  ),
  label text,
  first_block bigint NOT NULL,
  discovered boolean NOT NULL DEFAULT false,
  PRIMARY KEY (chain_id, address)
);

-- How far each deployment is indexed. Logs of blocks up to last_indexed_block are in `events`;
-- last_indexed_hash is that block's hash, checked against the chain on every tick to detect a reorg.
-- Blocks up to last_finalized_block are final on the chain and are never re-checked.
CREATE TABLE cursors (
  deployment_id text PRIMARY KEY REFERENCES deployments (id),
  chain_id integer NOT NULL REFERENCES chains (chain_id),
  last_indexed_block bigint NOT NULL,
  last_indexed_hash text,
  last_finalized_block bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The chain head as last seen by the writer, for /ready.
CREATE TABLE chain_heads (
  chain_id integer PRIMARY KEY REFERENCES chains (chain_id),
  head_block bigint NOT NULL,
  finalized_block bigint,
  seen_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  last_error_at timestamptz
);

-- Hashes of the blocks that hold stored events and of each indexed range's last block, while they can still
-- reorg (rows below the finalized block are pruned). Used to find the fork point.
CREATE TABLE blocks (
  chain_id integer NOT NULL,
  number bigint NOT NULL,
  hash text NOT NULL,
  parent_hash text NOT NULL,
  block_time timestamptz NOT NULL,
  PRIMARY KEY (chain_id, number)
);

-- Every log of every indexed contract. (chain_id, tx_hash, log_index) identifies a log, so inserting the same log
-- twice (a re-run, an overlapping range) is a no-op.
CREATE TABLE events (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL REFERENCES chains (chain_id),
  deployment_id text NOT NULL REFERENCES deployments (id),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  block_time timestamptz NOT NULL,
  tx_hash text NOT NULL,
  tx_index integer NOT NULL,
  log_index integer NOT NULL,
  address text NOT NULL,
  source text NOT NULL, -- the contract kind (contracts.kind)
  event_name text, -- null when the log does not decode with the contract's ABI (kept raw in topics and data)
  args jsonb, -- decoded arguments: integers as decimal strings, addresses lowercase
  topics text[] NOT NULL,
  data text NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX events_chain_block ON events (chain_id, block_number);
CREATE INDEX events_deployment_event ON events (deployment_id, source, event_name);
CREATE INDEX events_address ON events (chain_id, address);
CREATE INDEX events_newest ON events (block_time DESC, chain_id DESC, block_number DESC, log_index DESC);
CREATE INDEX events_vault_arg ON events ((args ->> 'vault')) WHERE args ? 'vault';

-- Value locked per vault, read from the chain every few minutes (a time series; /stats uses the latest row).
CREATE TABLE vault_tvl (
  chain_id integer NOT NULL,
  vault text NOT NULL,
  deployment_id text NOT NULL REFERENCES deployments (id),
  read_at timestamptz NOT NULL DEFAULT now(),
  block_number bigint,
  is_call boolean,
  total_assets numeric,
  asset_decimals smallint,
  spot_price numeric, -- WAD per raw stock token, calls only
  tvl_usd double precision, -- null when it could not be valued (as the app)
  error text,
  PRIMARY KEY (chain_id, vault, read_at),
  FOREIGN KEY (chain_id, vault) REFERENCES contracts (chain_id, address) ON DELETE CASCADE
);

-- Reorgs the writer handled: where the chain forked and how many stored events were rolled back.
CREATE TABLE reorgs (
  id bigserial PRIMARY KEY,
  chain_id integer NOT NULL REFERENCES chains (chain_id),
  detected_at timestamptz NOT NULL DEFAULT now(),
  stale_block bigint NOT NULL,
  stale_hash text NOT NULL,
  fork_block bigint NOT NULL,
  events_removed integer NOT NULL
);
