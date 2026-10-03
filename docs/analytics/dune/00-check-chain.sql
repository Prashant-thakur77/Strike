-- Strike: which Robinhood Chain does Dune's `robinhood` schema index?
-- Run this first. Dune's docs name the schema but not the chain ID.
-- Mainnet (4663) block 1 is at 2026-04-30 16:52:11 UTC; testnet (46630) block 1 is at 2026-02-06 16:01:00 UTC
-- (both read from the public RPCs on 2026-10-03). The TSLA stock token below exists on mainnet only.
-- Expected on mainnet: block1_time = 2026-04-30 16:52:11 and tsla_transfer_logs > 0.

select
  (select time from robinhood.blocks where number = 1) as block1_time,
  (select max(number) from robinhood.blocks) as latest_block,
  (
    select count(*)
    from robinhood.logs
    where contract_address = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d -- TSLA, strike.config.json chains.4663.stocks
      and topic0 = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef -- Transfer(address,address,uint256)
  ) as tsla_transfer_logs
