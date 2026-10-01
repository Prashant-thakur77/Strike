# Testing Strike: a 5-minute guide

Strike runs on two testnets: Robinhood Chain testnet (chain 46630) and Arbitrum Sepolia (chain 421614). It is unaudited testnet software: use a fresh wallet, and remember that testnet tokens have no value. Robinhood stock tokens are offered only to non-US persons.

## 1. Try without a wallet: `/app/playground` (1 minute)

Open the app at https://strike-options.vercel.app. The landing page and the vaults page start with a four-step "New here? Start here" strip (see a vault, try the playground, watch an agent's record, check the proof), and every app page opens with one sentence on what it is for and ends with a "Next:" link to the next page. Words with a dotted underline are glossary terms: hover, focus or tap one for a one-sentence definition. All 26 terms are listed at [`/app/glossary`](https://strike-options.vercel.app/app/glossary).

To run the app locally instead:

```bash
git clone --recursive https://github.com/Prashant-thakur77/Strike && cd Strike
pnpm install && pnpm --filter @strike/app dev
# then open http://localhost:3000/app/playground
```

The [playground](https://strike-options.vercel.app/app/playground) reads the live testnet vaults and asks the `EpochManager` to judge a proposal (`previewProposal`, a read-only call). It needs no wallet and sends nothing. Pick a preset and watch the verdict:

- **Honest agent**, a 0.20-delta call: **Accepted**.
- **Reckless agent**, an at-the-money put: rejected with `DeltaOutOfBand`, and the page shows the bond a real proposal would lose.
- **Too big**: `SizeTooLarge`. **50% of fair value**: `PremiumBelowFair`.

Then change the strike, size or premium yourself. Two more pages need no wallet: `/app/monitor` (live safety checks on 8 Robinhood Chain mainnet stock tokens) and `/app/proof` (every claim with its evidence, and the live on-chain activity feed).

## 2. Network, wallet and tokens (2 minutes)

**Pick the network.** The network menu in the app's top bar (inside the Menu on a phone) switches between Robinhood Chain testnet and Arbitrum Sepolia. Reads work without a wallet; a connected wallet is asked to switch too, and the app follows the wallet when it is on a supported network. A link can also choose it: `/app?chain=46630` or `/app?chain=421614`. On Robinhood Chain testnet the app shows the v2 vaults (the app's default deployment there); on Arbitrum Sepolia it shows v3.

**Get test tokens.** The app's [faucet page](https://strike-options.vercel.app/app/faucet) (`/app/faucet`) shows your balances on the selected network and links the right faucet for each token.

| Network                 | Add it to your wallet                                                                                                    | Gas (ETH)                                                                          | USDG                                                                      | Stock tokens                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Robinhood Chain testnet | chain ID `46630`, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com` | [Robinhood faucet](https://faucet.testnet.chain.robinhood.com/)                    | [Paxos faucet](https://faucet.paxos.com/), choose Robinhood Chain testnet | Robinhood's own testnet TSLA (and AMZN, PLTR, NFLX, AMD) from the [Robinhood faucet](https://faucet.testnet.chain.robinhood.com/)                                                    |
| Arbitrum Sepolia        | chain ID `421614`, RPC `https://sepolia-rollup.arbitrum.io/rpc`, explorer `https://sepolia.arbiscan.io`                  | [Arbitrum Sepolia faucet](https://faucets.chain.link/arbitrum-sepolia) (Chainlink) | [Paxos faucet](https://faucet.paxos.com/), choose Arbitrum Sepolia        | TSLA and NVDA are Strike's `TestStockToken`s, because Robinhood's stock tokens do not exist on Arbitrum Sepolia: the **Get 10 TSLA** button on `/app/faucet`, once a day per address |

The contract addresses for both networks are in the [README](../README.md#live-on-two-chains) and [DEPLOYMENTS.md](DEPLOYMENTS.md).

## 3. Try one thing (1 minute)

Pick any of these:

- **Deposit.** Open the TSLA covered-call vault (`sTSLA-CC`, holds TSLA) or the cash-secured-put vault (`sTSLA-CSP`, holds USDG) and deposit; both networks have one of each. Between epochs a deposit is instant. While an epoch runs it is queued and becomes shares at the next settlement (the current call epochs settle after the NYSE close on Friday 2026-10-02, 20:00 UTC).
- **Buy an option.** Buying needs a vault in the Selling state with options left, during NYSE hours. The vault page shows the live series, the buy-price breakdown, the payoff chart, the maximum loss and the live risk panel. In each of the three live epochs a buyer took all 4 calls, so those series show **Sold out** until the next epoch opens.
- **Run the example agent.** Read-only, no key needed (put `STRIKE_CHAIN_ID=421614` in front for Arbitrum Sepolia):

  ```bash
  pnpm --filter @strike/agent-example start -- --status --vault sTSLA-CC
  ```

  As a buyer (a throwaway testnet key that holds USDG; never a key with real funds):

  ```bash
  STRIKE_AGENT_PRIVATE_KEY=0x... pnpm --filter @strike/agent-example start -- --buy --budget 5
  ```

  Proposing strikes needs a registered, bonded agent. The epoch logs show what that looks like, including a rejected proposal and its slash: [v2 on Robinhood Chain testnet, 29 September](testnet-epochs/2026-09-29.md), [v3 on Arbitrum Sepolia, 30 September](testnet-epochs/2026-09-30-arbitrum-sepolia.md) and [v3 on Robinhood Chain testnet, 1 October](testnet-epochs/2026-09-30-v3.md#7-live-epoch-1-october). In both v3 epochs Claude planned the accepted proposal.

- **Telegram alerts.** Once the owner deploys the bot, its handle goes here: `<bot handle>` (pending). Send it `/subscribe` for epoch, rejection, buy and settlement alerts, or ask `/vaults`, `/quote sTSLA-CC 2`, `/agent 1` or `/status`. Until then, preview it locally with no token; it prints the alerts from the real Robinhood Chain testnet logs and sends nothing:

  ```bash
  pnpm --filter @strike/telegram-bot dry-run "/vaults" "/quote sTSLA-CC 1" "/agent 1" "/status"
  ```

## 4. Tell us what happened (1 minute)

File the feedback form: https://github.com/Prashant-thakur77/Strike/issues/new?template=testnet-feedback.yml

It asks what you tried, what worked, what was confusing or broken, and whether you would use Strike on mainnet. A wallet address and contact are optional.
