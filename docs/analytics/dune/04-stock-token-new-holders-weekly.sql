-- Strike: how many addresses received a Robinhood Chain mainnet (4663) stock token for the first time, by week.
-- This is the market Strike is built for: wallets that hold stock tokens. "Any token" counts an address once,
-- in the week it first received any of the eight.
-- Chart: bars of new_addresses by week; a line of cumulative_addresses.

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
),

firsts as (
  select to_addr as holder, min(block_time) as first_seen
  from transfers
  where to_addr <> 0x0000000000000000000000000000000000000000
  group by 1
)

select
  date_trunc('week', first_seen) as week,
  count(*) as new_addresses,
  sum(count(*)) over (order by date_trunc('week', first_seen)) as cumulative_addresses
from firsts
group by 1
order by 1
