# Needs you

Tick an item (`[x]`) when done; blocked work resumes from there. Never paste private keys into chat or commit them: put them in `contracts/.env` (gitignored).

- [ ] Open `~/projects/strike` in VS Code (File → Open Folder). The old `protocol-monorepo-main` folder is untouched; delete or keep it as you like | why: Strike lives in the new folder | blocks: nothing | added: 2026-09-28
- [ ] **URGENT: register the team on HackQuest before 2026-10-02 17:01 UTC** | why: registration closes then; no registration, no submission | blocks: submission | added: 2026-09-28
- [ ] Skim the deadline and rules in [hackathon.md](hackathon.md) (submission closes **2026-10-04 15:59 UTC**) and the 12 open items at the end of [research.md](research.md) | why: taken from the page's embedded data; worth a human glance | blocks: nothing | added: 2026-09-28
- [x] Create a fresh deployer wallet: done for you. Testnet-only key in `contracts/.env` (gitignored, chmod 600). **Deployer address: `0x26b277b434B1670f207Afd8946edA9AF78A613Ff`** | added: 2026-09-28
- [ ] **URGENT (by Sep 30): fund `0x26b277b434B1670f207Afd8946edA9AF78A613Ff`** on both testnets. A watcher deploys automatically as soon as the Robinhood testnet ETH arrives. | why: gas for deploys, the Stylus pricer and the demo | blocks: all testnet deploys | added: 2026-09-28
  - Robinhood Chain testnet (46630): ~0.05 ETH from the Robinhood Chain faucet, plus the faucet's stock tokens (TSLA, AMZN, PLTR, NFLX, AMD)
  - Robinhood Chain testnet: ~200 USDG from https://faucet.paxos.com (network: Robinhood Chain testnet)
  - Arbitrum Sepolia (421614): ~0.05 ETH (any Arbitrum Sepolia faucet or bridge) and ~200 USDG from https://faucet.paxos.com (network: Arbitrum Sepolia)
- [ ] Choose the npm scope (`@strike` may be taken) and add an `NPM_TOKEN` | why: publish `@strike/sdk` | blocks: SDK publish | added: 2026-09-28
- [ ] Vercel (or similar) account connected to the GitHub repo | why: live demo URL | blocks: live demo | added: 2026-09-28
- [ ] Goldsky account and API key (the only host with Robinhood Chain testnet subgraph support, see [indexing.md](indexing.md)) | why: index epochs and PnL for the app and agents | blocks: subgraph deploy | added: 2026-09-28
- [ ] Approve and fund a capped mainnet vault on Robinhood Chain (4663): a small amount of ETH for gas plus the stock token/USDG to seed | why: mainnet presence for the Robinhood reservation | blocks: Phase 5 | added: 2026-09-28
- [ ] Record the 3-minute demo video and the 2-minute pitch video (scripts will be in `docs/submission/`) | why: submission requirement | blocks: submission | added: 2026-09-28
- [ ] Post the build thread on X and in Arbitrum Discord #open-house | why: traction breaks ties | blocks: distribution | added: 2026-09-28
- [ ] Recruit 10+ testnet users and ask each to file the feedback form: https://github.com/Prashant-thakur77/Strike/issues/new?template=testnet-feedback.yml (also linked in the app footer) | why: product-market-fit evidence; the form answers go straight into the repo | blocks: PMF score | added: 2026-09-28
- [ ] Submit on HackQuest before **2026-10-04 15:59 UTC**; answers for every form field will be ready in `docs/submission/` | why: required | blocks: everything | added: 2026-09-28
