-- Strike: current holders of each Robinhood Chain mainnet (4663) stock token, from every Transfer since block 1.
-- A holder is an address with a balance above dust (1e-9 tokens). Supply = minted - burned, which should equal
-- totalSupply() (TSLA: 12,699.61635 on 2026-10-03, read with cast). top10_share is the largest ten balances over supply.
-- Contracts (pools, vaults, bridges) count as holders; the count is addresses, not people.
-- Chart: a table, or bars of holders by symbol.

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

flows as (
  select symbol, to_addr as holder, amount from transfers
  union all
  select symbol, from_addr as holder, -amount from transfers
),

balances as (
  select symbol, holder, sum(amount) as balance
  from flows
  where holder <> 0x0000000000000000000000000000000000000000
  group by 1, 2
),

ranked as (
  select symbol, holder, balance, row_number() over (partition by symbol order by balance desc) as rnk
  from balances
  where balance > 1e-9
)

select
  symbol,
  count(*) as holders,
  sum(balance) as supply_tokens,
  sum(case when rnk <= 10 then balance else 0 end) / sum(balance) as top10_share
from ranked
group by 1
order by holders desc
