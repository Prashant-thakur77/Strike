# Needs you

Tick an item (`[x]`) when done; blocked work resumes from there. Never paste private keys into chat or commit them: put them in `contracts/.env` (gitignored).

- [ ] Open `~/projects/strike` in VS Code (File → Open Folder). The old `protocol-monorepo-main` folder is untouched; delete or keep it as you like | why: Strike lives in the new folder | blocks: nothing | added: 2026-09-28
- [ ] Confirm the submission deadline, time zone and rules on the HackQuest page (it renders client-side) | why: everything is scheduled against it | blocks: submission planning | added: 2026-09-28
- [ ] Register the team on HackQuest before registration closes | why: required to submit | blocks: submission | added: 2026-09-28
- [ ] Create a fresh deployer wallet and put `PRIVATE_KEY=` in `contracts/.env` | why: deployments need a signer; use a new key with test funds only | blocks: Phase 4 deploys | added: 2026-09-28
- [ ] Fund the deployer: Robinhood Chain testnet ETH (faucet), Arbitrum Sepolia ETH | why: gas for deploys and the demo | blocks: Phase 4 deploys | added: 2026-09-28
- [ ] Get testnet USDG from faucet.paxos.com (Robinhood testnet, and Arbitrum Sepolia if offered) and testnet stock tokens (TSLA, AMZN, PLTR, NFLX, AMD) from the Robinhood faucet, sent to the deployer | why: seed vaults and buy options in the demo | blocks: testnet demo | added: 2026-09-28
- [ ] Choose the npm scope (`@strike` may be taken) and add an `NPM_TOKEN` | why: publish `@strike/sdk` | blocks: SDK publish | added: 2026-09-28
- [ ] Vercel (or similar) account connected to the GitHub repo | why: live demo URL | blocks: live demo | added: 2026-09-28
- [ ] Subgraph hosting account and deploy key (The Graph Studio, Goldsky or Envio) | why: index epochs and PnL | blocks: subgraph deploy | added: 2026-09-28
- [ ] Approve and fund a capped mainnet vault on Robinhood Chain (4663): a small amount of ETH for gas plus the stock token/USDG to seed | why: mainnet presence for the Robinhood reservation | blocks: Phase 5 | added: 2026-09-28
- [ ] Record the 3-minute demo video and the 2-minute pitch video (scripts will be in `docs/submission/`) | why: submission requirement | blocks: submission | added: 2026-09-28
- [ ] Post the build thread on X and in Arbitrum Discord #open-house | why: traction breaks ties | blocks: distribution | added: 2026-09-28
- [ ] Recruit 10+ testnet users and collect their feedback (form link will be in the app) | why: product-market-fit evidence | blocks: PMF score | added: 2026-09-28
- [ ] Submit on HackQuest before the deadline | why: required | blocks: everything | added: 2026-09-28
