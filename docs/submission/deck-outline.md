# Deck outline (10 slides)

The finished deck: https://claude.ai/artifact/9TBBg2RwFueF3oEG6Qq5Eg (private until shared from its Share menu; Share › Export gives PPTX or PDF). Fill the bracketed placeholders on the business and roadmap slides: testnet users, feedback reports, live vaults, team, live app and video URLs.

1. Title: Strike · Weekly options vaults for Robinhood Chain stock tokens, paid in USDG, run by mandate-bound agents.
2. Problem: stock tokens earn 0%; about $14M stock-token market cap next to about $400M of idle stablecoins; no options on the chain; the integration traps (multiplier, weekend prices, pauses).
3. Users: stock holder (covered calls), USDG holder (cash-secured puts), option buyer (hedge), strategy agent (fee share), integrator (SDK/MCP).
4. Product: the weekly epoch in five steps with the payoff formulas (calls pay `(S − K)/S` tokens, puts pay `K − S` USDG).
5. Agents: propose-only, immutable mandate, reject-and-slash flow, `proposeByDelta` with the Stylus strike solver. Screenshot of the rejected proposal.
6. Safety: SafeStockFeed rules, invariants list, fork tests on chain 4663, differential Rust/Solidity, Slither 0 High, threat model.
7. Demo screenshots: vault page, buy panel, agent leaderboard.
8. Business model: 10% performance fee on positive net premium, half to the agent; revenue at $1M TVL and a 0.5% weekly premium = about $26K a year to the protocol.
9. Roadmap: testnet now, capped mainnet vault, more tickers and spreads, USDG gas paymaster, agent reputation via ERC-8004, wallet integrations through the SDK.
10. Team and links: GitHub, live app, demo video, contact.
