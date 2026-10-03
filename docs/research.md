# Strike: research notes (verified facts)

Compiled 2026-09-28 (UTC). I checked each fact against the source URL given. When a fact says **on-chain**, I read it myself with `cast` against the public RPC named in that row, so you can re-run the check. Anything I could not confirm is marked **UNVERIFIED** and is also listed at the end of this file.

Public RPCs used for on-chain checks:

- Robinhood mainnet `https://rpc.mainnet.chain.robinhood.com`
- Robinhood testnet `https://rpc.testnet.chain.robinhood.com`
- Arbitrum One `https://arb1.arbitrum.io/rpc`
- Arbitrum Sepolia `https://sepolia-rollup.arbitrum.io/rpc`

---

## 1. Hackathon: Arbitrum Open House Singapore, Online Buildathon

Sources: the [HackQuest page](https://www.hackquest.io/hackathons/Arbitrum-Open-House-Singapore-Online-Buildathon) and the Arbitrum Foundation posts linked below.

- "A three-week online Buildathon from September 14 to October 4, followed one month later by a three-day, in-person Founder House" ([Arbitrum Foundation](https://blog.arbitrum.foundation/open-house-singapore-applications-are-now-open/)). Submissions close 2026-10-04 at 15:59 UTC (23:59 in Singapore). Founder House Singapore runs October 23–25, 2026 ([Arbitrum Foundation](https://blog.arbitrum.foundation/founder-house-singapore-apply-now-to-launch-products-on-arbitrum-one-robinhood-chain/)).
- A project must be deployed on an Arbitrum chain, for example Arbitrum Sepolia, Arbitrum One or Robinhood Chain. The listed stacks are Solidity and Rust: "Build with Stylus in familiar programming languages or use Solidity."
- The submission form asks for the frontend link, the core, factory and token contract addresses (one per line, `network: address — label`), which code was written during the buildathon, and the sponsor technologies used. Each text field takes at most 300 characters. Strike's answers: [submission/hackquest-answers.md](submission/hackquest-answers.md).
- Robinhood Chain has committed $1M to early-stage teams building through Open House ([Builder's Block #024](https://blog.arbitrum.foundation/builders-block-024-robinhood-chain-commits-1m-in-funding-to-open-house-arbos-elara-now-live/)).
- Other resources on the page: the Robinhood Chain faucet `https://faucet.testnet.chain.robinhood.com/`, Discord `#open-house`, a workshop calendar and QuickNode credits.

---

## 2. Robinhood Chain: network facts

Sources:

- https://docs.robinhood.com/chain/connecting
- https://docs.robinhood.com/chain/add-network-to-wallet
- https://docs.robinhood.com/chain/deploy-smart-contracts

|                           | Mainnet                                                | Testnet                                                            |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Chain ID                  | **4663** (on-chain `eth_chainId` = 4663)               | **46630** (on-chain = 46630)                                       |
| Public RPC (rate-limited) | `https://rpc.mainnet.chain.robinhood.com`              | `https://rpc.testnet.chain.robinhood.com`                          |
| Alchemy RPC (recommended) | `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}` | `https://robinhood-testnet.g.alchemy.com/v2/{API_KEY}`             |
| Sequencer feed            | `wss://feed.mainnet.chain.robinhood.com`               | `wss://feed.testnet.chain.robinhood.com`                           |
| Explorer                  | `https://robinhoodchain.blockscout.com`                | `https://explorer.testnet.chain.robinhood.com`                     |
| Explorer type             | Blockscout                                             | Blockscout (backend v10.2.6, per `/api/v2/config/backend-version`) |
| Verifier API              | `https://robinhoodchain.blockscout.com/api/`           | `https://explorer.testnet.chain.robinhood.com/api/`                |
| Gas token                 | ETH                                                    | ETH (Sepolia-bridged)                                              |
| L1                        | Ethereum                                               | Ethereum Sepolia                                                   |

- **Contract verification.** The deploy page gives this command for mainnet:
  ```
  forge verify-contract <addr> src/X.sol:X --chain-id 4663 --rpc-url $RH_RPC_URL --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
  ```
  The same page says that for testnet you should "use chain ID 46630, and verify against https://explorer.testnet.chain.robinhood.com/api/". The testnet Etherscan-compatible `/api?module=...` endpoint answered correctly when I tested it. The mainnet Blockscout API sat behind a Cloudflare challenge when called with curl.
- **Faucet (testnet).**
  - `https://faucet.testnet.chain.robinhood.com/` gives testnet ETH plus test Stock Tokens "including Tesla, Amazon, Palantir, Netflix, and AMD". Source: https://blog.arbitrum.io/robinhood-chain-testnet/ (published 2026-02-11). It returned HTTP 429 to curl.
  - Chainlink faucet: `https://faucets.chain.link/robinhood-testnet` (HTTP 200).
  - USDG faucet: see section 4.
- **Bridge.**
  - The canonical Arbitrum bridge, with deposits taking about 10 minutes and withdrawals about 7 days.
  - Other routes: LayerZero OFT/Stargate (USDG, WBTC), Chainlink CCIP, Relay, Across, LiFi/0x. Source: https://docs.robinhood.com/chain/bridging
  - Portal URL: `https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum` (from a search result; the portal returned 403 to curl).
- **L1 and L2 protocol contracts:** https://docs.robinhood.com/chain/protocol-contracts. Examples:
  - L2 WETH: mainnet `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, testnet `0x7943e237c7F95DA44E0301572D358911207852Fa`.
  - Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` on both networks.
  - L2 Multicall: mainnet `0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1`, testnet `0xa432504b6F04Cafe775b09D8AA92e8dbe41Ec7a8`.
- **Chain behaviour.** Source: https://docs.robinhood.com/chain/differences-from-ethereum
  - `block.number` is an L1 estimate. Use `ArbSys(0x64).arbBlockNumber()` for the L2 block number.
  - `prevrandao` is constant.
  - Transactions are ordered first-come, first-served, with no priority-gas auctions.
  - Maximum code size is 96 KB and maximum init code is 192 KB.
  - Transactions are screened at the sequencer level (sanctioned addresses are excluded).
  - ERC-4337 and EIP-7702 are available.
- **Data Streams verifier proxy (mainnet):** `0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7`. Source: https://docs.robinhood.com/chain/data-streams
- **Notices.** On 2026-09-17 the websocket feed moved to compressed-only transmission (RFC 7692). Nitro v3.11.4 was released 2026-09-14. Source: https://docs.robinhood.com/chain/notices-and-upgrades

---

## 3. Stock Tokens

Facts from the docs (https://docs.robinhood.com/chain/stock-tokens, https://docs.robinhood.com/chain/building-with-stock-tokens):

- Stock Tokens are standard ERC-20s with **18 decimals**, implementing ERC-8056.
- The issuer is Robinhood Assets (Jersey) Ltd.
- Only Authorised Participants mint or burn, inside the tokenization window of Monday 02:00 to Saturday 02:00 CET/CEST. End users can trade on-chain at any time.
- They are not offered to US persons.
- The docs token-contracts page renders its table client-side from the "on-chain asset registry". The authoritative off-chain list is `GET https://api.robinhood.com/rhj/assets`. On 2026-09-28 it returned 195 assets, all with chainId 4663 only (no testnet deployments).

### 3a. Mainnet (4663) token addresses and Chainlink feeds

Token addresses come from the RHJ assets API. Feed addresses come from Chainlink's directory `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`, which backs https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood.

All tokens, on-chain:

- `decimals()=18`
- `paused()=false`
- `oraclePaused()=false`

All feeds, on-chain:

- `decimals()=8`, as the directory also states.
- Heartbeat `86400` s (directory).
- Deviation `0.5%` (directory).
- `marketHours: us_equities_24/5` (directory).

| Ticker | Token (mainnet)                              | uiMultiplier on 2026-09-28 (on-chain) | Chainlink **Standard proxy**                 | Chainlink SVR proxy                          | Feed `description()` (on-chain) |
| ------ | -------------------------------------------- | ------------------------------------- | -------------------------------------------- | -------------------------------------------- | ------------------------------- |
| TSLA   | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | 1.0                                   | `0x4A1166a659A55625345e9515b32adECea5547C38` | `0xE4479F01738B4e8C428CD8eB72D47AB9BC3c7de6` | RHTSLA / USD                    |
| NVDA   | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | 1.000775159164630595                  | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | `0xCF169363636D73dbBf77733629CB38919d14232d` | RHNVDA / USD                    |
| AMZN   | `0x12f190a9F9d7D37a250758b26824B97CE941bF54` | 1.0                                   | `0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C` | `0x9244830430bC7D9C9A48dd47603F24AD61f7c56e` | Robinhood AMZN / USD            |
| PLTR   | `0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A` | 1.0                                   | `0x820ABedFF239034956B7A9d2F0a331f9F075eB4c` | `0x8cd1DFC0fc61fcA55FA77b37e008A90f13364Fce` | Robinhood PLTR / USD            |
| NFLX   | `0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8` | 1.0                                   | **none listed by Chainlink**                 | —                                            | —                               |
| AMD    | `0x86923f96303D656E4aa86D9d42D1e57ad2023fdC` | 1.0                                   | `0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72` | `0xF6d57763DFa625F4A413485261Ab2E71Ff4304CF` | RHAMD / USD                     |
| SPY    | `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C` | 1.001717991187472003                  | `0x319724394D3A0e3669269846abE664Cd621f9f6A` | `0xa68CA83408bE3f78d1c58a82081c619e9d21486d` | RHSPY / USD                     |
| AAPL   | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | (API) 1.000566…                       | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` | `0x4bDbb3150014c6Ab2C6D9347B0779c49015a2f3f` | Robinhood AAPL / USD            |
| QQQ    | `0xD5f3879160bc7c32ebb4dC785F8a4F505888de68` | (API) 1.000700…                       | `0x80901d846d5D7B030F26B480776EE3b29374C2ae` | `0x41ed2c58611790af0760e31e80Bb427e4e83D603` | Robinhood QQQ / USD             |

Other mainnet feeds, all 8 decimals:

| Feed       | Standard proxy                               |
| ---------- | -------------------------------------------- |
| USDG / USD | `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2` |
| ETH / USD  | `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` |
| USDC / USD | `0x9e6f4605992a899eE2999999F3Ec80C41F452546` |

Notes on the feeds:

- **Which proxy is which.** In the Chainlink docs UI, `proxyAddress` is labelled "Standard Proxy" and `secondaryProxyAddress` is the SVR proxy. I read this in the docs JS bundle.
- **Other stock tokens.** The TSLA, NVDA and AAPL tokens and feeds match the Arbitrum Foundation sample repo: https://github.com/hummusonrails/robinhood-chain-dapp-example/blob/HEAD/contracts/script/Deploy.s.sol
- **Off-hours.** "These feeds do not have heartbeats during off-hours". Stock feeds update 24/5. Source: https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood
- **The price already includes the multiplier: YES.** The docs say: "The Chainlink price already includes the corporate-action multiplier (dividends, splits), so the value you read is the token's full price — don't apply the multiplier yourself." (https://docs.robinhood.com/chain/building-with-stock-tokens). Chainlink states "Token Price = Underlying Equity Market Price × Multiplier" (https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood).
- **REST prices differ.** The REST `/rhj/prices/{symbol}` endpoint is NOT multiplier-adjusted. Source: https://docs.robinhood.com/chain/stock-token-apis
- **Corporate-action flow**, from the Chainlink page:
  1. Robinhood calls `pauseOracle()`. While `oraclePaused()==true` the feed holds its last value.
  2. Robinhood stages `updateMultiplier(newMultiplier, effectiveAt)`. `updateMultiplier(uint256)` is the immediate variant.
  3. Robinhood calls `unpauseOracle()`.

  The Robinhood docs describe the `oraclePaused()` flag as "advisory and not enforced on-chain", so keep a staleness check as the primary guard.

### 3b. Testnet (46630) Stock Tokens (faucet tokens)

Robinhood publishes no official doc page listing testnet addresses. These addresses are backed by:

- two independent repos: the AF-linked `hummusonrails` Deploy script (TSLA, AMZN, NFLX) and archer-markets `scripts/config.mjs` (all five);
- on-chain checks: name and symbol match, all five share one BeaconProxy beacon `0x1df3ca0fd30ed5eeb09eb01938f4e9c5196e6ca5` (implementation `0xBd14156E05c6AF28ad39aA53a2AB8eB9CDf657DA`), each has about 6.2M supply, and each has about 220k holders.

| Ticker | Testnet token                                | Decimals (on-chain) |
| ------ | -------------------------------------------- | ------------------- |
| TSLA   | `0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E` | 18                  |
| AMZN   | `0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02` | 18                  |
| PLTR   | `0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0` | 18                  |
| NFLX   | `0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93` | 18                  |
| AMD    | `0x71178BAc73cBeb415514eB542a8995b82669778d` | 18                  |

Sources:

- https://github.com/hummusonrails/robinhood-chain-dapp-example (constants `TESTNET_TSLA/AMZN/NFLX`)
- https://github.com/nachfq/archer-markets/blob/HEAD/scripts/config.mjs

Limits on testnet:

- **NVDA and SPY: no official testnet token.** The faucet lists only the five above. Third-party lookalikes exist (for example "NVIDIA • Robinhood Token (Test)" `0x0aE6Ab…` and "NVIDIA (Testnet - No Real Value)" `0x2C00…`). Do not use them.
- **No Chainlink feeds exist on testnet.**
  - Chainlink's docs list only "Robinhood Chain Mainnet", and `feeds-robinhood-testnet.json` returns 404.
  - The AF blog confirms: "On testnet, the demo uses real faucet Stock Tokens for TSLA, AMZN, and NFLX with mock Chainlink feeds… the production Stock Token feeds live on mainnet." Source: https://blog.arbitrum.foundation/build-your-first-dapp-on-robinhood-chain/
  - **You must deploy mock AggregatorV3 feeds on testnet.**
- **The testnet token implementation is older and lacks the oracle-pause functions** (on-chain selector check):
  - `oraclePaused()`, `pauseOracle()` and `unpauseOracle()` are absent, and calling `oraclePaused()` reverts.
  - `uiMultiplier`, `newUIMultiplier`, `effectiveAt`, `balanceOfUI`, `totalSupplyUI`, `paused`, `tokenPaused` and `permit` are present.
  - **Wrap `oraclePaused()` in try/catch or gate it by chain.**

### 3c. Stock Token interface: exact names

**The ERC-8056 spec, quoted verbatim** from https://eips.ethereum.org/EIPS/eip-8056:

- Status: Draft. Created 2025-10-20.
- Authors include Gilbert Shih (Robinhood).
- Discussion: https://ethereum-magicians.org/t/erc-8056-scaled-ui-amount-extension-for-erc-20-tokens/25899

```solidity
interface IScaledUIAmount {
    // Emitted when the UI multiplier is updated
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);
    // OPTIONAL: Emitted during a token transfer with the UI-adjusted amount
    event TransferWithUIAmount(address indexed from, address indexed to, uint256 amount, uint256 uiAmount);
    // OPTIONAL: Emitted when a scheduled UI multiplier update is cancelled or superseded
    event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt);
    // Returns the current UI multiplier
    // Multiplier is represented with 18 decimals (1e18 = 1.0)
    function uiMultiplier() external view returns (uint256);
}

interface IScaledUIAmountConversion {
    // Converts a raw token amount to UI amount
    function toUIAmount(uint256 rawAmount) external view returns (uint256);
    // Converts a UI amount to raw token amount
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);
}

interface IScaledUIAmountBalances {
    // Returns the UI-adjusted balance of an account
    function balanceOfUI(address account) external view returns (uint256);
    // Returns the UI-adjusted total supply
    function totalSupplyUI() external view returns (uint256);
}

interface IScaledUIAmountNewUIMultiplier {
    // Returns the pending UI multiplier scheduled to take effect at effectiveAt
    // Multiplier is represented with 18 decimals (1e18 = 1.0)
    function newUIMultiplier() external view returns (uint256);
    // Returns the timestamp at which the pending multiplier becomes effective
    function effectiveAt() external view returns (uint256);
}
```

The spec's ERC-165 interface IDs are:

- IScaledUIAmount `0xa60bf13d`
- IScaledUIAmountNewUIMultiplier `0x4bd27648`
- IScaledUIAmountConversion `0x57854fc3`
- IScaledUIAmountBalances `0xd890fd71`

The spec requires IScaledUIAmount and IScaledUIAmountNewUIMultiplier.

**What the Robinhood tokens actually implement.** I checked the mainnet TSLA implementation `0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2` (behind beacon `0xe10b6f6B275de231345c20D14Ab812db62151b00`) by selector, event-topic and `supportsInterface` checks:

- `supportsInterface`: true for `0xa60bf13d`, `0x4bd27648` and `0xd890fd71`. False for `0x57854fc3`, so **`toUIAmount` and `fromUIAmount` are NOT implemented**.
- **The pending timestamp is `effectiveAt()`.** `newUIMultiplierEffectiveAt()` does not exist (selector `0xa2068de1` is absent).
- **The transfer event is named differently from the spec.** Robinhood emits `TransferWithScaledUI(address indexed from, address indexed to, uint256 value, uint256 uiValue)`. The spec's `TransferWithUIAmount` topic is absent. The docs agree: https://docs.robinhood.com/chain/building-with-stock-tokens
- The `UIMultiplierUpdateCancelled` topic is absent.
- On-chain observation: before any multiplier has been scheduled, `effectiveAt()` returns 0 and `newUIMultiplier()` equals `uiMultiplier()` (TSLA, AMZN, PLTR, NFLX, AMD). NVDA returned `effectiveAt()=1788998430` and SPY returned `1789690233`, both in the past.

Consolidated interface (every name below is confirmed present on mainnet by selector or topic):

```solidity
interface IRobinhoodStockToken /* is IERC20, IERC20Permit */ {
    // ERC-8056
    function uiMultiplier() external view returns (uint256);      // 1e18 = 1.0
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function balanceOfUI(address account) external view returns (uint256);
    function totalSupplyUI() external view returns (uint256);
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp);
    event TransferWithScaledUI(address indexed from, address indexed to, uint256 value, uint256 uiValue);
    // Pause (Robinhood-specific)
    function paused() external view returns (bool);       // both nets
    function tokenPaused() external view returns (bool);  // both nets (selector 0x86c75e74)
    function oraclePaused() external view returns (bool); // MAINNET ONLY - reverts on testnet tokens
    event Paused();          // topic keccak("Paused()") - note: NO address arg (differs from OZ)
    event Unpaused();
    event OraclePaused();    // mainnet only
    event OracleUnpaused();  // mainnet only
    // admin (not callable by us): pause(), unpause(), pauseOracle(), unpauseOracle(),
    // updateMultiplier(uint256), updateMultiplier(uint256,uint256), mint, burn, adminBurn, setMetadata
    function uid() external view returns (bytes32);
    function terms() external pure returns (string memory); // "https://robinhood.com/stocktoken/rhj"
    // EIP-2612: permit(address,address,uint256,uint256,uint8,bytes32,bytes32), nonces(address), DOMAIN_SEPARATOR(), eip712Domain()
}
```

- `paused()` is Robinhood-specific and not part of ERC-8056. On mainnet `paused()`, `tokenPaused()` and `oraclePaused()` all returned false.
- **UNVERIFIED:** the exact semantics of `paused()` vs `tokenPaused()`. Both exist, but neither is documented.
- There is no event or interface named "OraclePausable". The pause events on-chain are `OraclePaused()` and `OracleUnpaused()`, with no arguments.
- Where the names come from:
  - `pauseOracle`, `unpauseOracle` and `updateMultiplier(...)`: https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood
  - `tokenPaused`, `adminBurn`, `ACCESS_CONTROLLED_REGISTRY` and `setMetadata`: matched via openchain.xyz signature lookup.

---

## 4. USDG (Paxos Global Dollar)

Sources:

- https://docs.paxos.com/guides/stablecoin/usdg/mainnet
- https://docs.paxos.com/guides/stablecoin/usdg/testnet

| Network                       | USDG token                                                                                        | Decimals (on-chain) | name/symbol (on-chain) |
| ----------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- | ---------------------- |
| **Robinhood testnet (46630)** | **`0x7E955252E15c84f5768B83c41a71F9eba181802F`** (CONFIRMED)                                      | 6                   | Global Dollar / USDG   |
| Robinhood mainnet (4663)      | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (also on https://docs.robinhood.com/chain/contracts) | 6                   | Global Dollar / USDG   |
| Arbitrum Sepolia (421614)     | `0xFFC95faa3d63Cde504a05B567C600B78C0b41892`                                                      | 6                   | Global Dollar / USDG   |
| Arbitrum One (42161)          | `0x004B506865409877C9fA29bfb1ebA929984B9bbC`                                                      | 6                   | Global Dollar / USDG   |

Supporting contracts, from Paxos:

| Network           | Supply control                               | OFT                                          |
| ----------------- | -------------------------------------------- | -------------------------------------------- |
| Robinhood mainnet | `0xdf5FfF9cb88B3cAb50572FAE73E2EB08599D25D4` | `0x0d54755f5106BfdB43f7a35f5D49a23F940628d1` |
| Arbitrum One      | `0x359a1Ee087abD3042151b93eC8EA462D6B27bcb6` | `0xC3274Ec3f772D8534575EaAd5231cf250a48b6b6` |
| Robinhood testnet | `0x4549bb98c667aAb626627C118102c28065E8f54C` | —                                            |
| Arbitrum Sepolia  | `0xDDF7d873F5738c2A191624b1ba1Aba7042621E43` | —                                            |

- **EIP-2612 permit: YES, on all four networks** (on-chain probe). The Paxos docs pages do not mention it.
  - `PERMIT_TYPEHASH()` returns `0x6e71edae…c6c9`, which is `keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")`.
  - `nonces(address)` and `DOMAIN_SEPARATOR()` answer.
  - Calling `permit(...)` with a junk signature reverts with `InvalidSignature()` (`0x8baa579f`). A missing function would revert with `FacetNotFound()` (`0x800ab12c`), because USDG is a facet/diamond-style proxy.
  - `transferWithAuthorization(...)` (EIP-3009) likewise exists.
  - `eip712Domain()` (EIP-5267) does NOT exist: it reverts with FacetNotFound.
- **Faucet:** https://faucet.paxos.com/ (also `https://faucet.paxos.com/?network=robinhood`). The faucet JS config lists these networks for USDG: `ETHEREUM` (Sepolia), `SOLANA` (Devnet), `XLAYER` (testnet), `ARBITRUM_ONE` (displayed as "Arbitrum Sepolia", token `0xFFC95faa…1892`), `INK` (Sepolia), `ROBINHOOD` ("Robinhood Chain Testnet", token `0x7E955252…802F`), `MANTLE` (Sepolia). Source: faucet bundle `https://faucet.paxos.com/assets/index-Cnwrg2YM.js`
- **Chainlink USDG/USD feed**, 8 decimals:
  - Robinhood mainnet `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`
  - Arbitrum One `0xE9Bd4Ca2CDacb56cd06c9C4C5231e69c33340B3c`

  Source: Chainlink reference-data-directory JSONs.

---

## 5. ERC-8004 (Trustless Agents)

Spec: https://eips.ethereum.org/EIPS/eip-8004. Status Draft, created 2025-08-13. Requires EIP-155, 712, 721 and 1271.

### IdentityRegistry

It **is ERC-721-based**: "ERC-721 with the URIStorage extension".

- `agentId` is the tokenId and `agentURI` is the tokenURI.
- Ownership is read with the standard ERC-721 `ownerOf(agentId)`, and the URI with `tokenURI(agentId)`.
- The spec functions are:

```solidity
struct MetadataEntry { string metadataKey; bytes metadataValue; }
function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId)
function register(string agentURI) external returns (uint256 agentId)
function register() external returns (uint256 agentId)   // agentURI is added later with setAgentURI()
function setAgentURI(uint256 agentId, string calldata newURI) external
function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory)
function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external
function getAgentWallet(uint256 agentId) external view returns (address)
function unsetAgentWallet(uint256 agentId) external
event Registered(uint256 indexed agentId, string agentURI, address indexed owner)
event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)
event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)
```

### ReputationRegistry

```solidity
function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external
event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)
function getIdentityRegistry() external view returns (address identityRegistry)
function getSummary(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external
```

- `valueDecimals` must be between 0 and 18.
- The submitter MUST NOT be the agent owner or an operator of that agent.

### ValidationRegistry

It exposes `validationRequest(...)` and `validationResponse(...)`. The spec says it is "still under active update".

### Deployed addresses

Source: https://github.com/erc-8004/erc-8004-contracts README. I verified each on-chain: code is present, `name()="AgentIdentity"`, `symbol()="AGENT"`, `getVersion()="2.0.0"`, and the Reputation registry's `getIdentityRegistry()` points to the matching Identity registry.

| Network           | IdentityRegistry                             | ReputationRegistry                           |
| ----------------- | -------------------------------------------- | -------------------------------------------- |
| Arbitrum One      | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Arbitrum Sepolia  | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| Robinhood mainnet | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| Robinhood testnet | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

The same vanity addresses are used on every mainnet and on every testnet. The README publishes no ValidationRegistry addresses.

---

## 6. Arbitrum Stylus

- **Crate versions** (https://crates.io/api/v1/crates/...):
  - `stylus-sdk` **0.10.9**, released 2026-08-11. It is the latest stable version.
  - `cargo-stylus` **0.10.9**, released 2026-08-11, with crate `rust-version` 1.91.0.
  - `stylus-proc` 0.10.9.
  - `openzeppelin-stylus` 0.3.0.
- **Toolchain:**
  - SDK examples at tag v0.10.9 pin `rust-toolchain.toml` to `channel = "1.91.0"`. Source: https://github.com/OffchainLabs/stylus-sdk-rs/tree/v0.10.9/examples
  - The target is **`wasm32-unknown-unknown`**. The cargo-stylus README says: "cargo install cargo-stylus; rustup target add wasm32-unknown-unknown". Source: https://github.com/OffchainLabs/stylus-sdk-rs/blob/v0.10.9/cargo-stylus/README.md
  - `cargo stylus new --minimal <name>` creates a bare template.
  - The standalone template https://github.com/OffchainLabs/stylus-hello-world still uses `stylus-sdk = "0.9.0"`, `alloy-primitives = "=0.8.20"` and toolchain 1.87.0.
  - The v0.10.9 examples use `alloy-primitives = "1.5.7"` and `alloy-sol-types = "1.5.7"`.
- **Minimal pattern** (v0.10.9 `examples/first_app/src/lib.rs`, abridged):

```rust
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;
use stylus_sdk::{alloy_primitives::U256, prelude::*, storage::StorageU256};

#[storage]
#[entrypoint]
pub struct Counter { count: StorageU256 }

#[public]
impl Counter {
    pub fn get(&self) -> Result<U256, Vec<u8>> { Ok(self.count.get()) }
    pub fn set_count(&mut self, count: U256) -> Result<(), Vec<u8>> { self.count.set(count); Ok(()) }
}
```

- **The alternative is the `sol_storage!` macro:**
  ```rust
  sol_storage! { #[entrypoint] pub struct Contract { address owner; uint256 number; } }
  ```
  - Constructors use `#[constructor]` plus `#[payable]` inside `#[public] impl`.
  - Errors use `sol! { error Unauthorized(); }` together with `#[derive(SolidityError)] enum`.
  - Trait routing uses `#[public] #[implements(IErc20, IOwnable)] impl Contract {}`.
  - Environment access is `self.vm().msg_sender()` / `self.vm().tx_origin()`.
  - Source: `examples/constructor` and `examples/inheritance` at v0.10.9.
- **`main.rs`**, the same in hello-world and the v0.10.9 examples:

```rust
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
#[cfg(not(any(test, feature = "export-abi")))]
#[no_mangle]
pub extern "C" fn main() {}
#[cfg(feature = "export-abi")]
fn main() { <crate_name>::print_from_args(); }
```

- `Cargo.toml` needs `[lib] crate-type = ["lib", "cdylib"]` and `[features] export-abi = ["stylus-sdk/export-abi"]`.
- **Stylus is enabled on Robinhood Chain** (on-chain):
  - `ArbWasm(0x71).stylusVersion()` returns **3** on Robinhood mainnet, Robinhood testnet, Arbitrum One and Arbitrum Sepolia.
  - `ArbSys(0x64).arbOSVersion()` returns **116** on all four, which is 55 + **ArbOS 61 ("Elara")**. The "ArbOS 61 Elara" name comes from https://blog.arbitrum.foundation/builders-block-023-415k-in-prizes-at-open-house-singapore-apply-now/
  - ArbWasm and ArbWasmCache precompiles are listed for both Robinhood networks at https://docs.robinhood.com/chain/protocol-contracts
  - The AF blog says: "Stylus lets a Solidity contract call a Rust one" on Robinhood Chain. Source: https://blog.arbitrum.foundation/build-your-first-dapp-on-robinhood-chain/
  - Elara gives Stylus a 4x code-size limit (24 KB to 96 KB).

---

## 7. Chainlink L2 sequencer uptime feeds

Source: https://docs.chain.link/data-feeds/l2-sequencer-feeds

| Network              | Uptime feed                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **Arbitrum One**     | `0xFdB631F5EE196F0ed6FAa767959853A9F217697D`                                                 |
| **Arbitrum Sepolia** | **None listed** on the Chainlink page or in `feeds-ethereum-testnet-sepolia-arbitrum-1.json` |
| **Robinhood Chain**  | **None listed** on the Chainlink page or in `feeds-robinhood-mainnet.json`                   |

- Arbitrum One is verified on-chain: `description()="L2 Sequencer Uptime Status Feed"` and `answer=0` (up).
- Chainlink's network config for Robinhood also lacks the `l2SequencerFeed` flag that Arbitrum has.
- Robinhood's docs recommend a sequencer check but give no address (https://docs.robinhood.com/chain/oracles-and-price-feeds).
- **Treat the Robinhood feed as absent and make the address optional** (`address(0)` disables the check). This matches how StockGuard handles it.

---

## 8. Competitors and options on Robinhood Chain

Projects in this buildathon that overlap with Strike, from each project's public repository or HackQuest page (the source column).

| Name             | One-liner                                                                                                                                                                                                                                                   | Source                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **HarvestBot**   | "Tax-loss harvesting agent for Robinhood tokenized stocks, bounded by an onchain mandate: Stylus (Rust→WASM) HIFO tax-lot ledger, contract-enforced 30-day wash-sale wall, slashable agent bond. Live on Robinhood Chain testnet." Repo created 2026-09-27. | https://github.com/edycutjong/harvestbot                                          |
| **StockGuard**   | "Drop-in Morpho oracle that stops DeFi lending against wrong or weekend-stale Robinhood Chain stock prices". It checks ERC-8056 multiplier lag or pending status, staleness, copycat tokens and wrong feeds. Fork-tested on mainnet.                        | https://github.com/snit292012/stockguard                                          |
| **Lexifi**       | "Compliance for Uniswap v4 pools. Each pool sets its own rules - jurisdiction, KYC level, trade size - enforced in the contract… Live on Robinhood Chain (4663)."                                                                                           | https://www.hackquest.io/projects/Lexifi                                          |
| **Manda**        | "Human-owned payment identity with bounded AI agent authority across Arbitrum and Robinhood Chain". Uses ERC-4337 Modular Account V2, gas-sponsored payments, optional USDG mandates and a demo video.                                                      | https://github.com/Nifemi0/manda                                                  |
| **Regen Bazaar** | "tRWI (tokenized real-world impact) marketplace. EAS-attested, lazy-minted ERC-1155. Testnets: Celo Sepolia, Arbitrum Sepolia, Robinhood Chain (USDG)." Submitted 2026-09-27.                                                                               | https://github.com/Regen-Bazaar/regenbazaar-beta                                  |
| **ProtoRWA**     | Tokenized hardware manufacturing with milestone escrow in USDG. Includes a Stylus WASM Merkle verifier for sensor telemetry. Runs on Robinhood testnet.                                                                                                     | https://github.com/Fredincorporation/ProtoRWA (https://protorwa-eosin.vercel.app) |
| **Latheon**      | "Open-source privacy protocol — same code, live on Ethereum, Arbitrum, and Robinhood Chain. Prove a transaction to one chosen auditor, without spending power."                                                                                             | https://www.hackquest.io/projects/Latheon-UPDATED                                 |

**None of these entries is an options vault.**

### Options on Robinhood Chain: yes, they already exist

- **Stonkhouse (stonkhouse.fun). This is the most direct competitor. It is LIVE on mainnet.**
  - Tagline: "NVDA · SPCX live on Robinhood Chain … Daily calls and puts on Stock Tokens, from 0.01 share … Or hold the stock and get paid to sell calls."
  - It is settled in USDG, and "Winning calls are owed Stock Tokens."
  - The docs cover covered-call writing, cash-secured puts, presets and auto-roll, and an order book.
  - The contracts repo is described as a "pooled covered-call vault for Robinhood Chain Stock Tokens. Audit target." It was created 2026-09-13.
  - Sources: https://stonkhouse.fun, https://docs.stonkhouse.fun, https://github.com/stonkhousedotfun/callhouse-contracts
- **Archer Markets.** "Fully collateralized Stock Token options with an onchain bid/ask orderbook". Five testnet markets (TSLA, AMD, AMZN, NFLX, PLTR against USDG), with physical exercise and no oracle settlement. Testnet-only proof of concept. Source: https://github.com/nachfq/archer-markets
- **Trion.** A fully collateralized options order book on an H100 GPU-hour index (CMPT) on Robinhood mainnet, with USDG collateral. Exchange at `0xc2843dA66Ea70C4d6be90CeCB15c9185D92b3350` (per README, not verified by me). Source: https://github.com/Trionmarket/trion
- **St0kes.** A Monte Carlo option-pricing engine run inside a view call (GARCH(1,1)) that takes spot from Robinhood Chainlink feeds. Research code; its README lists CA `0x1390d4e06126082ce98a9fc7ac9cea38507f3ee6`, which I did not verify. Source: https://github.com/St0kesEth/st0kes
- **Clutch Labs / StonkBrokers.** "Covered Call Options … NFT options desk with TWAP pricing against StonkBroker NFTs". This comes from a search snippet only and is **UNVERIFIED**. Source: https://www.clutch.markets/

The official docs list "structured products" and "Perps & derivatives" as intended use cases but name no options partner. Source: https://docs.robinhood.com/chain/building-with-stock-tokens

### Past Open House winner on Robinhood Chain: Tilt Protocol

Added 2026-09-30. The result is from the Arbitrum Foundation's posts on the [NYC buildathon winners](https://blog.arbitrum.foundation/open-house-nyc-buildathon-concludes-meet-the-winning-teams/) and the [NYC Founder House](https://blog.arbitrum.foundation/nyc-founder-house-concludes-with-340k-in-awards-to-winning-teams/). The other rows come from Tilt's HackQuest text and linked repositories; I did not check them against its deployed contracts (**UNVERIFIED**, item 9 below).

| Field                 | What the sources say                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Result                | Open House NYC online buildathon 1st place ($15K); NYC Founder House Founder-in-Residence ($100K)                                                                                                                                                                              |
| What it does          | AI-driven management layer for tokenized-RWA vaults on Robinhood Chain; an oracle parses SEC and STOCK Act filings; an RFQ engine                                                                                                                                              |
| Stack                 | Solidity on Robinhood Chain testnet, Next.js; an agent skill published on ClawHub (`clawhub install tilt-protocol`, and a skill served over HTTP)                                                                                                                              |
| On-chain limits on AI | not described                                                                                                                                                                                                                                                                  |
| Bond or slashing      | not described                                                                                                                                                                                                                                                                  |
| Stock-token safety    | not described                                                                                                                                                                                                                                                                  |
| ERC-8004, USDG        | not described                                                                                                                                                                                                                                                                  |
| Sources               | [HackQuest](https://www.hackquest.io/projects/Arbitrum-Open-House-NYC-Online-Buildathon-Tilt-Protocol), [contracts](https://github.com/0xangky/bowstring-contracts), [agent skill](https://github.com/rontoTech/tilt-protocol-openclaw), [site](https://www.tiltprotocol.com/) |

How Strike differs. Tilt's AI manages the vault; Strike's agent only proposes a strike, the contract checks it against an immutable mandate, and a proposal outside the mandate slashes the agent's USDG bond to the vault's depositors. A Tilt vault's return depends on what its AI chooses to hold; a Strike vault earns option premium on a stock the depositor already holds (covered call) or would buy at the strike (cash-secured put). Tilt does not sell options, so it has no place on the options positioning chart in the README.

### USDG lending yields (the benchmark for the put vault)

| Venue                             | Yield                                                    | Date       | Source                                                                                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steakhouse USDG vault on Morpho   | about 1.9%                                               | 2026-07-20 | [FalconX Robinhood Chain primer](https://x.com/FalconXGlobal/article/2079248025214407089)                                                                                                                                          |
| Robinhood Earn on USDG            | about 7% estimated APY                                   | 2026       | [FalconX primer](https://x.com/FalconXGlobal/article/2079248025214407089), [Robinhood newsroom](https://robinhood.com/us/en/newsroom/robinhood-accelerates-global-expansion-robinhood-chain-mainnet-stock-tokens-agentic-trading/) |
| Pendle PT-USDG, expiry 2027-03-25 | 3.45% implied APY, fixed to expiry; about $51k liquidity | 2026-10-01 | [Pendle API, chain 4663](https://api-v2.pendle.finance/core/v1/4663/markets/active), [cryptobriefing](https://cryptobriefing.com/pendle-fixed-yield-usdg-robinhood-chain/)                                                         |

Strike's cash-secured-put vault, 2019 to 2026 ([backtest.md](backtest.md)): −0.9% to 3.7% a year at realised volatility × 1.15, and −3.8% to 0.5% at × 1.00, with collateral earning nothing. Only NVDA at × 1.15 (3.7%) beat the 1.9% organic rate; it is also just above Pendle's fixed 3.45%, and no case reached 7%. The other three tickers returned less than all three benchmarks. The put vault is therefore framed as being paid to bid below spot, not as a savings product.

---

## 9. Account abstraction and gas sponsorship on the two testnets

Checked 2026-10-03 (UTC) for onboarding: can a new user act without first getting testnet ETH from a faucet? The answer decided [D49](decisions.md).

**On-chain** (`cast code <address> --rpc-url <rpc>`, both public RPCs above):

| Contract                 | Address                                      | Robinhood testnet 46630 | Arbitrum Sepolia 421614 |
| ------------------------ | -------------------------------------------- | ----------------------- | ----------------------- |
| ERC-4337 EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | deployed                | deployed                |
| ERC-4337 EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | deployed                | deployed                |
| ERC-4337 EntryPoint v0.8 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | deployed                | deployed                |
| ERC-4337 EntryPoint v0.9 | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` | deployed                | deployed                |

- **ArbOS version, on-chain.** `ArbSys(0x64).arbOSVersion()` returns 116 on both chains, which is ArbOS 61 (the precompile adds 55). Both RPCs report Nitro `v3.12.1-rc.2`. EIP-7702 arrived in ArbOS 40 "Callisto" ([Arbitrum docs](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos40)).
- **EIP-7702, on-chain.** `cast estimate` of a type-4 transaction carrying a signed authorization (a throwaway key delegating to the v0.7 EntryPoint) succeeds on both chains, at 56,795 gas on 46630 and 52,514 on 421614 against 27,455 and 23,161 for the same call without it: the authorization is processed, not ignored. Robinhood's docs list 7702 support ([account abstraction](https://docs.robinhood.com/chain/account-abstraction)).
- **Pimlico public bundler, live.** `https://public.pimlico.io/v2/{46630,421614}/rpc` answers `eth_supportedEntryPoints` with all four EntryPoints and `pimlico_getUserOperationGasPrice` with prices, with no API key. Its docs list both chains for bundler and paymaster ([supported chains](https://docs.pimlico.io/llms-full.txt), "Robinhood Testnet, Chain ID 46630, EIP-7702 support"). The docs also say the public endpoint serves paymaster methods on testnets, but `pm_sponsorUserOperation` and `pm_getPaymasterStubData` on both chains answered `"Sponsorship policy ID is required for this API key"`: sponsorship needs a free Pimlico account and a policy. Testnet sponsorship is free once that exists ("Testnet User Operations are free to sponsor").
- **ZeroDev.** Lists Robinhood Testnet 46630 and Arbitrum Sepolia 421614 as supported networks ([docs](https://docs.zerodev.app/llms-full.txt), "Supported Networks"); every bundler and paymaster URL carries a project ID from the dashboard, and sponsoring needs a gas policy per chain ("confirm that a gas policy exists for the project and chain").
- **Alchemy.** Bundler and Gas Manager listed for Robinhood Chain testnet ([Wallet APIs supported chains](https://www.alchemy.com/docs/wallets/supported-chains)); needs an API key and a Gas Manager policy.
- **Biconomy.** Arbitrum Sepolia is supported ([supported networks](https://docs.biconomy.io/supportedNetworks)); we found no listing for Robinhood Chain testnet. Its paymaster URL comes from the dashboard.

**What follows for Strike.** The infrastructure is there on both chains, but every gas sponsor needs an account the team does not hold today, and smart accounts change who holds the funds: with a 4337 account a user's USDG and shares live at a new address, so every balance and position read in the app would move; with 7702 the address stays, but injected wallets do not let a site ask for an authorization signature. So the build is a starter drip (D49): a relayed, team-funded `GasDrip` contract that gives a new wallet 0.0001 ETH, which needs no outside account. Sponsored smart accounts stay the next step: a Pimlico or ZeroDev project with a testnet policy takes the owner a few minutes to set up.

---

## UNVERIFIED / needs a human check

1. **Clutch Labs "Covered Call Options"**: I only saw it in a search snippet.
2. **Robinhood testnet stock-token addresses.** These are not on any official Robinhood doc page. They are corroborated by two third-party repos, the on-chain name and symbol, and the shared beacon. If possible, confirm with the faucet UI (it returned HTTP 429 to curl).
3. **NFLX has no Chainlink feed on mainnet**, even though the Robinhood docs say "every Stock Token has a live Chainlink price feed". Re-check https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood before relying on NFLX.
4. **Chainlink sequencer uptime feed on Robinhood Chain and on Arbitrum Sepolia**: none found. Assume absent.
5. **`paused()` vs `tokenPaused()` on stock tokens**: both exist, but their semantics are not documented. Assume either being true blocks transfers.
6. **Standard vs SVR proxy labelling.** I inferred it from the Chainlink docs JS, where `proxyAddress` is labelled "Standard Proxy". Consumers such as Strike should use the Standard proxy.
7. **Trion and St0kes addresses**: taken from their READMEs; I did not check them on-chain.
8. **Robinhood mainnet Blockscout API**: it was behind a Cloudflare challenge for curl. `forge verify-contract` against `https://robinhoodchain.blockscout.com/api/` is what the official docs say, but I have not tested it.
9. **Tilt Protocol**: the table above repeats its HackQuest text; its contracts were not checked.
10. **Robinhood Earn at about 7%**: taken from the FalconX primer and the Robinhood newsroom, not from the Earn page itself. Whether it is subsidised is not confirmed.
