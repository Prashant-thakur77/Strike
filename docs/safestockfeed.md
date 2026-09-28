# SafeStockFeed: safe stock-token prices for any Robinhood Chain protocol

Lending markets, perps, index products and payments on Robinhood Chain all read stock-token prices, and they all hit the same traps. `SafeStockFeed` is a small MIT-licensed Solidity library that handles them in one call, and `StockOracle` is a deployed contract built on it that other protocols can call directly.

## What it checks

| Check                                                | Error                                            | Why it matters                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Positive answer, not from the future                 | `InvalidPrice(answer)`                           | Broken or manipulated rounds                                                                                      |
| Age under `maxPriceAge`                              | `StalePrice(updatedAt, maxAge)`                  | Feeds freeze on weekends and holidays; the mainnet stock feeds have a 24 h heartbeat and 0.5% deviation threshold |
| Token not paused (`paused()`)                        | `TokenPaused(token)`                             | The issuer can pause transfers                                                                                    |
| Oracle side not paused (`oraclePaused()`)            | `FeedPaused(token)`                              | The second pause layer. Read defensively: testnet tokens do not implement it                                      |
| No ERC-8056 multiplier change in progress            | `CorporateActionPending(token, effectiveAt)`     | Around a split or dividend, the feed and the multiplier can briefly disagree                                      |
| L2 sequencer up and past its grace period (optional) | `SequencerDown()`, `SequencerGracePeriod(since)` | Standard Chainlink L2 guard                                                                                       |
| Decimals normalised to 18                            | none                                             | One unit everywhere                                                                                               |

It never multiplies the feed price by `uiMultiplier`. The Chainlink stock feeds already price one raw token including the multiplier; applying it again overprices the token (NVDA's live multiplier is 1.000775). The fork test `test_fork_multiplierIsNotAppliedTwice` proves this against chain 4663.

## Use the library

```solidity
import {SafeStockFeed} from "strike/contracts/src/libraries/SafeStockFeed.sol";
import {IAggregatorV3} from "strike/contracts/src/interfaces/IAggregatorV3.sol";

contract MyLendingMarket {
    using SafeStockFeed for SafeStockFeed.Config;

    SafeStockFeed.Config internal tslaFeed = SafeStockFeed.Config({
        feed: IAggregatorV3(0x4A1166a659A55625345e9515b32adECea5547C38), // Chainlink TSLA / USD on chain 4663
        maxPriceAge: 25 hours,
        corporateActionGrace: 1 days,
        feedDecimals: 8
    });

    function collateralValue(uint256 rawTslaAmount) external view returns (uint256 usdWad) {
        (uint256 priceWad,) = tslaFeed.latest(0x322F0929c4625eD5bAd873c95208D54E1c003b2d); // TSLA token
        return rawTslaAmount * priceWad / 1e18; // raw balance × feed price; no multiplier
    }
}
```

`status(config, token)` is the non-reverting version for front ends and agents: it returns `Ok`, `InvalidPrice`, `StalePrice`, `TokenPaused`, `FeedPaused` or `CorporateActionPending` together with the price.

`settlementPrice(config, token, roundId, target)` returns the first round published at or after `target`, verifying that the round before it predates the target. Use it for anything that settles "at time T" (options, futures, auctions) so nobody can choose a convenient later print.

## Or call the deployed StockOracle

`StockOracle` holds a registry of stock tokens and their feeds, the NYSE calendar, and a record of settlement prices shared by every consumer:

| Function                                        | Returns                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `latestPrice(token)`                            | `(priceWad, updatedAt)` or a `SafeStockFeed` error                               |
| `status(token)`                                 | non-reverting status and price                                                   |
| `recordSettlementPrice(token, expiry, roundId)` | the price of the first round at or after `expiry`, stored once and never changed |
| `settlementPrice(token, expiry)`                | the recorded price (0 if none yet)                                               |
| `isMarketOpen()`                                | whether a regular NYSE session is open now                                       |
| `isValidExpiry(ts)`                             | whether `ts` is an NYSE session close                                            |

`MarketCalendar` computes NYSE sessions on-chain (DST-aware, matched against Python `zoneinfo` for every day from 2026 to 2030) with holidays and 13:00 early closes kept as an admin list. It also answers `weeklyExpiry(ts)` (Friday close, or Thursday when Friday is a holiday) and `nextSessionClose(ts)`.

Addresses are listed in the README once deployed.

## Tests

- Unit and fuzz: `contracts/test/oracle/StockOracle.t.sol` (19 tests), `contracts/test/oracle/MarketCalendar.t.sol` (13 tests)
- Fork against chain 4663: `contracts/test/fork/RobinhoodFork.t.sol` (real TSLA, NVDA and SPY feeds, real pause flags and multipliers)
- Coverage: 100% of lines for `SafeStockFeed` and `StockOracle`
