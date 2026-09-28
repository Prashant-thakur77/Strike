# Risk model for depositors

What a Strike depositor gives up, what they get, and what can go wrong. Strike is unaudited; read this before depositing anything.

## What you are doing

A covered-call vault sells, each week, the right to buy your stock tokens at a strike above today's price. You are paid for that right in USDG, up front (it is escrowed until Friday and then paid to you). If the stock finishes above the strike, the buyer takes the part of the upside above the strike, paid out of the vault's tokens. If it finishes below, you keep everything.

A cash-secured-put vault sells, each week, the right to sell stock to the vault at a strike below today's price. You are paid premium in USDG. If the stock finishes below the strike, the vault pays the buyer the difference `K − S` in USDG.

## Example weekly numbers

Black-Scholes premium for a 7-day, 0.20-delta option (the default target of the example agent), zero rates, using the same pricer the contracts run:

| Underlying   | Vol | Vault            | Strike vs spot | Premium / collateral per week | Simple annual rate |
| ------------ | --- | ---------------- | -------------- | ----------------------------- | ------------------ |
| TSLA at $250 | 60% | Covered call     | +7.6%          | 0.89%                         | 46%                |
| TSLA at $250 | 60% | Cash-secured put | −6.4%          | 1.03%                         | 54%                |
| NVDA at $180 | 50% | Covered call     | +6.3%          | 0.75%                         | 39%                |
| SPY at $650  | 18% | Covered call     | +2.2%          | 0.28%                         | 14%                |

These are premiums, not profits. Under the pricing model, the average payout to buyers equals the premium. Covered-call strategies have historically earned money because implied volatility tends to exceed realised volatility (the CBOE BXM index, which sells monthly S&P 500 calls, has tracked the index's return with lower volatility since 1986). That edge is small and not guaranteed.

## Risks

| Risk                               | What it means for you                                                                                                   | What limits it                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capped upside (calls)              | A big rally above the strike is paid to buyers. In a +20% week you keep only the move up to the strike plus the premium | The mandate's delta band keeps strikes out of the money (0.10–0.35 delta in the demo vaults)                                                                                                                                                                                                 |
| Assignment below the strike (puts) | A crash below the strike costs you `K − S` per option, in USDG                                                          | Puts are fully cash-secured; the premium offsets part of the loss                                                                                                                                                                                                                            |
| Pricing model error                | If Strike's volatility input is too low, options are sold too cheaply                                                   | Admin-bounded volatility that a keeper can move at most 25% per hour; a premium floor of 95% of fair value in the demo vaults (no mandate may go below 90%); premium re-priced at every purchase from the live oracle, at spot moved 0.5% against the buyer, and never below intrinsic value |
| Oracle error                       | A wrong settlement price moves value between you and buyers                                                             | Chainlink feeds only; the first print at or after expiry, proven on-chain across aggregator upgrades; a print too close to a split or dividend is replaced by the first print after the corporate-action window; staleness and pause checks ([threat model](threat-model.md))                |
| Liquidity                          | Your deposit is locked while an epoch runs; withdrawals queue until Friday's settlement                                 | Instant withdrawals between epochs; queued requests are processed at settlement automatically. Shares stay transferable, but while an epoch runs their `convertToAssets` value ignores what the vault may owe option holders                                                                 |
| Agent quality                      | A poor agent picks poor strikes inside the mandate                                                                      | The mandate bounds what it can do; its bond pays you for rejected proposals; its PnL record is on-chain and on ERC-8004                                                                                                                                                                      |
| Smart contract bugs                | Loss of funds                                                                                                           | 418 Foundry tests, invariants, fork tests, Slither triage, an internal security review with all findings fixed; still not externally audited. Mainnet vaults are capped                                                                                                                      |
| Stock token risk                   | Robinhood can pause the token or its oracle; tokens are for non-US persons only                                         | Strike waits during pauses and never settles on a paused feed                                                                                                                                                                                                                                |

## Fees

10% of a positive week's net premium (premium minus the value paid to buyers). Half goes to the agent that proposed the strike, half to the protocol treasury. Losing weeks pay no fee. The cap in the contract is 30%.
