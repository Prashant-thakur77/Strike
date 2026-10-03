-- Strike: daily activity of the Robinhood Chain mainnet (4663) stock tokens Strike's monitor reads.
-- Transfers, unique senders and receivers, and volume in raw token units, per token per day.
-- Mints (from the zero address) and burns (to it) are excluded here; 03 counts them.
-- Amounts are raw ERC-8056 units, the unit Chainlink's stock feeds price. UI shares = raw x uiMultiplier / 1e18
-- (1.0 for TSLA on 2026-10-03, 1.000775 for NVDA), so the two differ by well under 1%.
-- Chart: stacked bars of transfers by day and symbol; a line of volume.

with stocks (symbol, token) as (
  -- the 8 stock tokens in strike.config.json chains.4663.stocks (ERC-8056, 18 decimals)
  values
    ('TSLA', 0x322F0929c4625eD5bAd873c95208D54E1c003b2d),
    ('NVDA', 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC),
    ('AMZN', 0x12f190a9F9d7D37a250758b26824B97CE941bF54),
    ('PLTR', 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A),
    ('AMD', 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC),
    ('SPY', 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C),
    ('AAPL', 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9),
    ('QQQ', 0xD5f3879160bc7c32ebb4dC785F8a4F505888de68)
),

transfers as (
  -- raw Transfer logs, decoded by hand so the query needs no decoded tables
  select
    s.symbol,
    l.block_time,
    l.tx_hash,
    varbinary_substring(l.topic1, 13, 20) as from_addr,
    varbinary_substring(l.topic2, 13, 20) as to_addr,
    cast(varbinary_to_uint256(varbinary_substring(l.data, 1, 32)) as double) / 1e18 as amount
  from robinhood.logs as l
  join stocks as s on l.contract_address = s.token
  where l.topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
    and l.block_date >= date '2026-04-30' -- Robinhood Chain mainnet block 1
)

select
  date_trunc('day', block_time) as day,
  symbol,
  count(*) as transfers,
  count(distinct tx_hash) as transactions,
  count(distinct from_addr) as senders,
  count(distinct to_addr) as receivers,
  sum(amount) as volume_tokens
from transfers
where from_addr <> 0x0000000000000000000000000000000000000000
  and to_addr <> 0x0000000000000000000000000000000000000000
group by 1, 2
order by 1 desc, 2
