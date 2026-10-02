-- Derived views over `events`. They are plain views, so a reorg rollback (a DELETE on events) updates them too.
-- Integer arguments are decimal strings in `args`; ids that can exceed 2^63 (series ids) stay text.

-- Vaults of a deployment, from VaultFactory.VaultCreated or EpochManager.VaultRegistered (whichever came first).
CREATE VIEW v_vaults AS
SELECT DISTINCT ON (e.deployment_id, e.args ->> 'vault')
  e.chain_id,
  e.deployment_id,
  e.args ->> 'vault' AS vault,
  e.args ->> 'curator' AS curator,
  e.args ->> 'underlying' AS underlying,
  (e.args ->> 'isCall')::boolean AS is_call,
  e.args ->> 'agentId' AS agent_id,
  e.block_number AS created_block,
  e.block_time AS created_at,
  e.tx_hash AS created_tx
FROM events e
WHERE (e.source = 'vaultFactory' AND e.event_name = 'VaultCreated')
   OR (e.source = 'epochManager' AND e.event_name = 'VaultRegistered')
ORDER BY e.deployment_id, e.args ->> 'vault', e.block_number, e.log_index;

-- Option series the EpochManager accepted, with what was bought of each.
CREATE VIEW v_series AS
SELECT
  e.chain_id,
  e.deployment_id,
  e.args ->> 'seriesId' AS series_id,
  e.args ->> 'vault' AS vault,
  (e.args ->> 'epoch')::bigint AS epoch,
  (e.args ->> 'strike')::numeric AS strike,
  to_timestamp((e.args ->> 'expiry')::bigint) AS expiry,
  (e.args ->> 'size')::numeric AS size,
  (e.args ->> 'premiumBps')::integer AS premium_bps,
  (e.args ->> 'fairValue')::numeric AS fair_value,
  (e.args ->> 'delta')::numeric AS delta,
  e.block_number AS proposed_block,
  e.block_time AS proposed_at,
  e.tx_hash AS proposed_tx,
  EXISTS (
    SELECT 1 FROM events c
    WHERE c.deployment_id = e.deployment_id AND c.source = 'epochManager' AND c.event_name = 'SeriesCancelled'
      AND c.args ->> 'seriesId' = e.args ->> 'seriesId'
  ) AS cancelled,
  b.buys,
  b.options_bought,
  b.premium_paid
FROM events e
CROSS JOIN LATERAL (
  SELECT
    count(*) AS buys,
    coalesce(sum((x.args ->> 'amount')::numeric), 0) AS options_bought,
    coalesce(sum((x.args ->> 'premium')::numeric), 0) AS premium_paid
  FROM events x
  WHERE x.deployment_id = e.deployment_id AND x.source = 'epochManager' AND x.event_name = 'OptionsBought'
    AND x.args ->> 'seriesId' = e.args ->> 'seriesId'
) b
WHERE e.source = 'epochManager' AND e.event_name = 'SeriesProposed';

-- Epochs: opened, the series proposed in them, and how they ended.
CREATE VIEW v_epochs AS
SELECT
  o.chain_id,
  o.deployment_id,
  o.args ->> 'vault' AS vault,
  (o.args ->> 'epoch')::bigint AS epoch,
  (o.args ->> 'spot')::numeric AS spot_at_open,
  o.block_number AS opened_block,
  o.block_time AS opened_at,
  o.tx_hash AS opened_tx,
  sp.series_id,
  sp.strike,
  sp.expiry,
  sp.size,
  st.settlement_price,
  st.payout,
  st.premium,
  st.fee,
  st.settled_at,
  st.settled_tx,
  ab.aborted_at,
  ab.aborted_tx,
  CASE
    WHEN st.settled_at IS NOT NULL THEN 'settled'
    WHEN ab.aborted_at IS NOT NULL THEN 'aborted'
    WHEN sp.series_id IS NOT NULL THEN 'running'
    ELSE 'open'
  END AS state
FROM events o
LEFT JOIN LATERAL (
  SELECT
    x.args ->> 'seriesId' AS series_id,
    (x.args ->> 'strike')::numeric AS strike,
    to_timestamp((x.args ->> 'expiry')::bigint) AS expiry,
    (x.args ->> 'size')::numeric AS size
  FROM events x
  WHERE x.deployment_id = o.deployment_id AND x.source = 'epochManager' AND x.event_name = 'SeriesProposed'
    AND x.args ->> 'vault' = o.args ->> 'vault' AND x.args ->> 'epoch' = o.args ->> 'epoch'
  ORDER BY x.block_number DESC, x.log_index DESC
  LIMIT 1
) sp ON true
LEFT JOIN LATERAL (
  SELECT
    (x.args ->> 'settlementPrice')::numeric AS settlement_price,
    (x.args ->> 'payout')::numeric AS payout,
    (x.args ->> 'premium')::numeric AS premium,
    (x.args ->> 'fee')::numeric AS fee,
    x.block_time AS settled_at,
    x.tx_hash AS settled_tx
  FROM events x
  WHERE x.deployment_id = o.deployment_id AND x.source = 'epochManager' AND x.event_name = 'EpochSettled'
    AND x.args ->> 'vault' = o.args ->> 'vault' AND x.args ->> 'epoch' = o.args ->> 'epoch'
  LIMIT 1
) st ON true
LEFT JOIN LATERAL (
  SELECT x.block_time AS aborted_at, x.tx_hash AS aborted_tx
  FROM events x
  WHERE x.deployment_id = o.deployment_id AND x.source = 'epochManager' AND x.event_name = 'EpochAborted'
    AND x.args ->> 'vault' = o.args ->> 'vault' AND x.args ->> 'epoch' = o.args ->> 'epoch'
  LIMIT 1
) ab ON true
WHERE o.source = 'epochManager' AND o.event_name = 'EpochOpened';

-- Option purchases, with the vault that wrote the series.
CREATE VIEW v_buys AS
SELECT
  e.chain_id,
  e.deployment_id,
  e.args ->> 'seriesId' AS series_id,
  s.vault,
  e.args ->> 'buyer' AS buyer,
  e.args ->> 'recipient' AS recipient,
  (e.args ->> 'amount')::numeric AS amount,
  (e.args ->> 'premium')::numeric AS premium,
  e.block_number,
  e.block_time,
  e.tx_hash,
  e.log_index
FROM events e
LEFT JOIN LATERAL (
  SELECT x.args ->> 'vault' AS vault
  FROM events x
  WHERE x.deployment_id = e.deployment_id AND x.source = 'epochManager' AND x.event_name = 'SeriesProposed'
    AND x.args ->> 'seriesId' = e.args ->> 'seriesId'
  LIMIT 1
) s ON true
WHERE e.source = 'epochManager' AND e.event_name = 'OptionsBought';

-- Proposals the EpochManager rejected (mandate or risk checks), with the bond slashed for each.
CREATE VIEW v_rejections AS
SELECT
  e.chain_id,
  e.deployment_id,
  e.args ->> 'vault' AS vault,
  (e.args ->> 'epoch')::bigint AS epoch,
  e.args ->> 'agentId' AS agent_id,
  (e.args ->> 'reason')::integer AS reason,
  (e.args ->> 'slashed')::numeric AS slashed,
  (e.args ->> 'strike')::numeric AS strike,
  to_timestamp((e.args ->> 'expiry')::bigint) AS expiry,
  (e.args ->> 'size')::numeric AS size,
  (e.args ->> 'premiumBps')::integer AS premium_bps,
  e.block_number,
  e.block_time,
  e.tx_hash
FROM events e
WHERE e.source = 'epochManager' AND e.event_name = 'ProposalRejected';

-- Bond slashes (AgentRegistry.Slashed), with the rejection in the same transaction when there is one.
CREATE VIEW v_slashes AS
SELECT
  e.chain_id,
  e.deployment_id,
  e.args ->> 'agentId' AS agent_id,
  e.args ->> 'recipient' AS recipient,
  (e.args ->> 'amount')::numeric AS amount,
  (e.args ->> 'strikes')::integer AS strikes,
  r.vault,
  r.epoch,
  r.reason,
  e.block_number,
  e.block_time,
  e.tx_hash
FROM events e
LEFT JOIN LATERAL (
  SELECT x.args ->> 'vault' AS vault, (x.args ->> 'epoch')::bigint AS epoch, (x.args ->> 'reason')::integer AS reason
  FROM events x
  WHERE x.chain_id = e.chain_id AND x.tx_hash = e.tx_hash AND x.source = 'epochManager'
    AND x.event_name = 'ProposalRejected'
  LIMIT 1
) r ON true
WHERE e.source = 'agentRegistry' AND e.event_name = 'Slashed';

-- Decision records anchored in a DecisionLog.
CREATE VIEW v_decision_records AS
SELECT
  e.chain_id,
  e.deployment_id,
  e.args ->> 'agentId' AS agent_id,
  e.args ->> 'vault' AS vault,
  (e.args ->> 'epoch')::bigint AS epoch,
  e.args ->> 'recordHash' AS record_hash,
  e.args ->> 'uri' AS uri,
  to_timestamp((e.args ->> 'timestamp')::bigint) AS recorded_at,
  e.block_number,
  e.block_time,
  e.tx_hash
FROM events e
WHERE e.source = 'decisionLog' AND e.event_name = 'DecisionRecorded';

-- Agents per deployment: registration, current signer and identity, bond flows, proposals and records.
CREATE VIEW v_agents AS
WITH reg AS (
  SELECT DISTINCT ON (e.deployment_id, e.args ->> 'agentId')
    e.chain_id,
    e.deployment_id,
    e.args ->> 'agentId' AS agent_id,
    e.args ->> 'owner' AS owner,
    e.block_number AS registered_block,
    e.block_time AS registered_at,
    e.tx_hash AS registered_tx
  FROM events e
  WHERE e.source = 'agentRegistry' AND e.event_name = 'AgentRegistered'
  ORDER BY e.deployment_id, e.args ->> 'agentId', e.block_number, e.log_index
),
ev AS (
  SELECT e.deployment_id, e.args ->> 'agentId' AS agent_id, e.event_name, e.args, e.block_number, e.log_index
  FROM events e
  WHERE e.source = 'agentRegistry' AND e.args ? 'agentId'
)
SELECT
  reg.*,
  (
    SELECT ev.args ->> 'signer' FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id
      AND ev.event_name IN ('AgentRegistered', 'SignerSet')
    ORDER BY ev.block_number DESC, ev.log_index DESC LIMIT 1
  ) AS signer,
  (
    SELECT ev.args ->> 'erc8004Id' FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id
      AND ev.event_name = 'AgentRegistered' AND ev.args ->> 'erc8004Id' <> '0'
    ORDER BY ev.block_number DESC, ev.log_index DESC LIMIT 1
  ) AS erc8004_id,
  (
    SELECT (ev.args ->> 'status')::integer FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id AND ev.event_name = 'StatusSet'
    ORDER BY ev.block_number DESC, ev.log_index DESC LIMIT 1
  ) AS status,
  (
    SELECT coalesce(sum((ev.args ->> 'amount')::numeric), 0) FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id AND ev.event_name = 'BondPosted'
  ) AS bonded,
  (
    SELECT coalesce(sum((ev.args ->> 'amount')::numeric), 0) FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id AND ev.event_name = 'Slashed'
  ) AS slashed,
  (
    SELECT coalesce(sum((ev.args ->> 'amount')::numeric), 0) FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id AND ev.event_name = 'Unbonded'
  ) AS unbonded,
  (
    SELECT count(*) FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id
      AND ev.event_name = 'ProposalRecorded' AND (ev.args ->> 'accepted')::boolean
  ) AS proposals_accepted,
  (
    SELECT count(*) FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id
      AND ev.event_name = 'ProposalRecorded' AND NOT (ev.args ->> 'accepted')::boolean
  ) AS proposals_rejected,
  (
    SELECT (ev.args ->> 'cumulativePnl')::numeric FROM ev
    WHERE ev.deployment_id = reg.deployment_id AND ev.agent_id = reg.agent_id
      AND ev.event_name = 'EpochResultRecorded'
    ORDER BY ev.block_number DESC, ev.log_index DESC LIMIT 1
  ) AS cumulative_pnl,
  (
    SELECT count(*) FROM events d
    WHERE d.deployment_id = reg.deployment_id AND d.source = 'decisionLog' AND d.event_name = 'DecisionRecorded'
      AND d.args ->> 'agentId' = reg.agent_id
  ) AS decision_records
FROM reg;

-- Vault deposits and withdrawals: instant (ERC-4626 Deposit and Withdraw) and queued (requests and claims).
CREATE VIEW v_vault_flows AS
SELECT
  e.chain_id,
  e.deployment_id,
  e.address AS vault,
  e.event_name AS kind,
  CASE WHEN e.event_name IN ('Deposit', 'Withdraw') THEN e.args ->> 'owner' ELSE e.args ->> 'account' END AS account,
  (e.args ->> 'assets')::numeric AS assets,
  (e.args ->> 'shares')::numeric AS shares,
  (e.args ->> 'epoch')::bigint AS epoch,
  e.block_number,
  e.block_time,
  e.tx_hash,
  e.log_index
FROM events e
WHERE e.source = 'vault'
  AND e.event_name IN (
    'Deposit', 'Withdraw', 'DepositRequested', 'DepositRequestCancelled', 'DepositClaimed', 'RedeemRequested',
    'RedeemClaimed'
  );

-- Rounds the keeper pushed into the testnet MirrorFeeds (copies of the Robinhood Chain mainnet Chainlink rounds).
CREATE VIEW v_mirror_pushes AS
SELECT
  e.chain_id,
  e.deployment_id,
  e.address AS feed,
  c.label AS symbol,
  (e.args ->> 'current')::numeric AS answer,
  (e.args ->> 'roundId')::numeric AS round_id,
  to_timestamp((e.args ->> 'updatedAt')::bigint) AS round_updated_at,
  e.block_number,
  e.block_time,
  e.tx_hash,
  e.log_index
FROM events e
LEFT JOIN contracts c ON c.chain_id = e.chain_id AND c.address = e.address
WHERE e.source = 'mirrorFeed' AND e.event_name = 'AnswerUpdated';

-- Wallets and what they did, by the app's rules (app/src/lib/usage/aggregate.ts `walletsOf`): the zero address,
-- the deployment's core contracts and its vaults are never wallets.
CREATE VIEW v_wallet_roles AS
SELECT
  e.chain_id,
  e.deployment_id,
  r.address,
  r.role,
  e.block_number,
  e.log_index,
  r.ord
FROM events e
CROSS JOIN LATERAL (
  VALUES
    (CASE WHEN e.source = 'agentRegistry' AND e.event_name = 'AgentRegistered' THEN e.args ->> 'owner' END, 'agent', 1),
    (CASE WHEN e.source = 'agentRegistry' AND e.event_name IN ('AgentRegistered', 'SignerSet') THEN e.args ->> 'signer' END, 'agent', 2),
    (CASE WHEN e.source = 'agentRegistry' AND e.event_name = 'BondPosted' THEN e.args ->> 'from' END, 'bond', 1),
    (CASE WHEN e.source = 'epochManager' AND e.event_name = 'OptionsBought' THEN e.args ->> 'buyer' END, 'buyer', 1),
    (CASE WHEN e.source = 'epochManager' AND e.event_name = 'OptionsBought' THEN e.args ->> 'recipient' END, 'buyer', 2),
    (CASE WHEN e.source = 'epochManager' AND e.event_name = 'OptionsRedeemed' THEN e.args ->> 'holder' END, 'buyer', 1),
    (CASE WHEN e.source = 'vaultFactory' AND e.event_name = 'VaultCreated' THEN e.args ->> 'curator' END, 'curator', 1),
    (CASE WHEN e.source = 'vault' AND e.event_name = 'Deposit' THEN e.args ->> 'sender' END, 'depositor', 1),
    (CASE WHEN e.source = 'vault' AND e.event_name IN ('Deposit', 'Withdraw') THEN e.args ->> 'owner' END, 'depositor', 2),
    (CASE WHEN e.source = 'vault' AND e.event_name IN ('DepositRequested', 'RedeemRequested') THEN e.args ->> 'account' END, 'depositor', 1)
) AS r(address, role, ord)
JOIN deployments d ON d.id = e.deployment_id
WHERE r.address ~ '^0x[0-9a-f]{40}$'
  AND r.address <> '0x0000000000000000000000000000000000000000'
  AND r.address NOT IN (d.epoch_manager, d.vault_factory, d.agent_registry, coalesce(d.decision_log, ''))
  AND NOT EXISTS (SELECT 1 FROM v_vaults v WHERE v.deployment_id = e.deployment_id AND v.vault = r.address);
