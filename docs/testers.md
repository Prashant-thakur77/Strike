# Testing Strike: a 5-minute guide

Strike runs on Robinhood Chain testnet (chain 46630). It is unaudited testnet software: use a fresh wallet, and remember that testnet tokens have no value. Robinhood stock tokens are offered only to non-US persons.

## 1. Wallet and tokens (2 minutes)

1. Add Robinhood Chain testnet to your wallet: chain ID `46630`, RPC `https://rpc.testnet.chain.robinhood.com`, explorer `https://explorer.testnet.chain.robinhood.com`.
2. Get testnet ETH and TSLA from the Robinhood faucet: https://faucet.testnet.chain.robinhood.com/
3. Get testnet USDG from the Paxos faucet (choose Robinhood Chain Testnet): https://faucet.paxos.com/

## 2. Open the app

The public app URL is **pending** (the Vercel deployment is not live yet). Until then, run it locally:

```bash
git clone --recursive https://github.com/Prashant-thakur77/Strike && cd Strike
pnpm install && pnpm --filter @strike/app dev
# then open http://localhost:3000/app?chain=46630
```

The app reads the live testnet contracts listed in the [README](../README.md#deployed-contracts).

## 3. Try one thing (2 minutes)

Pick any of these:

- **Deposit.** Open the TSLA covered-call vault (`sTSLA-CC`, holds TSLA) or the cash-secured-put vault (`sTSLA-CSP`, holds USDG) and deposit. Between epochs a deposit is instant. While an epoch runs it is queued and becomes shares at the next settlement (the current call epoch settles after the NYSE close on Friday 2026-10-02).
- **Buy an option.** Buying needs a vault in the Selling state with options left, during NYSE hours. The vault page shows the live series, the quote and the maximum loss. If nothing is on sale, the page says why.
- **Run the example agent.** Read-only, no key needed:

  ```bash
  pnpm --filter @strike/agent-example start -- --status --vault sTSLA-CC
  ```

  As a buyer (a throwaway testnet key that holds USDG; never a key with real funds):

  ```bash
  STRIKE_AGENT_PRIVATE_KEY=0x... pnpm --filter @strike/agent-example start -- --buy --budget 5
  ```

  Proposing strikes needs a registered, bonded agent; the [live epoch log](testnet-epochs/2026-09-29.md) shows what that looks like, including a rejected proposal and its slash.

## 4. Tell us what happened (1 minute)

File the feedback form: https://github.com/Prashant-thakur77/Strike/issues/new?template=testnet-feedback.yml

It asks what you tried, what worked, what was confusing or broken, and whether you would use Strike on mainnet. A wallet address and contact are optional.
