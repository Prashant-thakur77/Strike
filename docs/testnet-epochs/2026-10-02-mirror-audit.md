# Price mirror audit, first runs (2026-10-02)

On Robinhood Chain testnet and Arbitrum Sepolia, Strike's prices come from `MirrorFeed`s that the keeper fills with Robinhood Chain mainnet Chainlink rounds. `scripts/verify-mirror.mjs` checks every round on them against the mainnet feed it copies: the mainnet round with the same `updatedAt` must exist and carry the same answer. It needs no key and sends nothing. The why is [decision D40](../decisions.md#d40--a-price-mirror-audit-makes-the-testnet-prices-checkable-2026-10-02); the whole trust picture is [trust-model.md](../trust-model.md).

Run on 2026-10-02 at 12:12 UTC, before Friday's 20:00 UTC expiry, with the public RPCs (no `ALCHEMY_API_KEY`), from commit `09524ef`'s SDK.

## Summary

| Chain                           | Keeper rounds checked | Match | Not checked                                                   | Deploy seeds (round 1, listed apart)      | Largest gap between pushes                                |
| ------------------------------- | --------------------: | ----: | ------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Robinhood Chain testnet (46630) |                    66 |    66 | NFLX, 1 round (Chainlink has no NFLX feed on Robinhood Chain) | AMD 160, AMZN 225, PLTR 180, TSLA 369     | PLTR round 2 to 3, 23h 24m, 9 mainnet prints not mirrored |
| Arbitrum Sepolia (421614)       |                    23 |    23 | none                                                          | none (seeded from the live mainnet round) | NVDA round 9 to 10, 14h 19m, 0 mainnet prints in between  |

- **TSLA, the feed settlement uses**: on 46630, all 15 keeper rounds since the v2 deploy (rounds 2 to 16) equal mainnet rounds 1:1390 to 1:1430; on 421614, all 11 rounds equal mainnet rounds 1:1406 to 1:1430. The two testnets carry the same mainnet prints where both mirrored them (for example 350.23 at 2026-09-30 15:49:01, mainnet round 1:1406).
- **The deploy seeds.** Round 1 of each 46630 feed is the price `contracts/script/Deploy.s.sol` pushed when it created the feed (`Stock("TSLA", ..., 369e8, ...)`, `f.push(seedPrice8, block.timestamp)`), at 2026-09-28 21:11:19 UTC, before the keeper's first run. It was never a mainnet price, so the audit lists it apart and does not count it as a keeper round; any other value in round 1 counts as a mismatch. No vault used it: the six `EpochOpened` spots are 352.453 on both 46630 v2 vaults (TSLA round 2), 358.5505 on both 46630 v3 vaults (round 11) and 350.23 on both 421614 vaults (round 1 there, a mainnet print).
- **The oracles read these feeds.** Added after the runs below: the audit also checks that each deployment's `StockOracle` reads the audited MirrorFeed for every listed token (`feedConfig(token).feed`), so an admin `setFeed` to another contract would fail it. At 12:26 UTC: v2 (`0x7bb3…aB89`) and v3 (`0x5BCd…989A`) on 46630 for all 10 listed tokens, and v3 (`0x8B89…bA9F`) on 421614 for both, with 66 of 66 and 23 of 23 rounds still matching. A second check followed at 12:33 UTC: each deployment's `EpochManager` reads its recorded `StockOracle` (`oracle()`; v2 and v3 on 46630, v3 on 421614), so an admin `setOracle` would fail the audit too. Both checks detect a swap; neither prevents one.
- **Coverage.** The keeper is a GitHub Actions cron (every 10 minutes when enabled, `.github/workflows/keeper.yml`) and has not run continuously: on 46630 it mirrored 15 of the 41 TSLA mainnet prints between its first and its last push. The audit cannot tell a skipped print from a withheld one; that is why the settlement check below also asks whether the settlement round is mainnet's first print after expiry.

## A fabricated round is caught (local fork)

The mismatch path, run against an anvil fork of Robinhood Chain testnet (forked at the head at 12:13 UTC, port 8546), where the deployer (the feed's keeper) was impersonated to push `push(35668000001, now - 60)`: the latest mainnet price plus one unit, at a time mainnet never printed. Nothing was sent to a public chain; the fork was stopped afterwards. The testnet was read from the fork (`STRIKE_RPC_URL=http://127.0.0.1:8546`), mainnet from its public RPC.

```text
$ STRIKE_RPC_URL=http://127.0.0.1:8546 node scripts/verify-mirror.mjs --chain 46630 --symbol TSLA --rounds 3
Price mirror audit: Robinhood Chain testnet (46630) MirrorFeeds against Robinhood Chain mainnet (4663) Chainlink
Testnet block 127,590,641 (2026-10-02 12:13:18 UTC), mainnet block 78,222,144 (2026-10-02 12:13:28 UTC).
Mainnet round = phase:aggregator round (the proxy's round id is phase << 64 | aggregator round).

TSLA  MirrorFeed 0x5476cb08769f406dE95F6171AcC1F5FE88431230 copies RHTSLA / USD 0x4A1166a659A55625345e9515b32adECea5547C38
  Round  Price          updatedAt (UTC)      Mainnet   Push tx      Result
  15     354.904        2026-10-01 19:55:17  1:1429    0x47dc23aa…  match
  16     356.68         2026-10-02 00:23:52  1:1430    0xa49aa0d6…  match
  17     356.68000001   2026-10-02 12:12:14  -         0x1665261f…  MISMATCH: mainnet printed no round at this time (nearest: 1:1430 at 2026-10-02 00:23:52)
  2 of 3 keeper rounds match; the keeper mirrored 2 of the 2 mainnet prints from its first push to its last, and 0 printed since; largest gap between pushes: round 16 to 17, 11h 48m, 0 mainnet print(s) in between not mirrored.

Largest gap between pushes: TSLA round 16 to 17, 11h 48m (2026-10-02 00:23:52 to 2026-10-02 12:12:14 UTC), 0 mainnet print(s) in between. The audit checks every value pushed; it cannot make the keeper push (withheld rounds show up only as gaps).

1 mismatch(es):
  TSLA round 17 (356.68000001 at 2026-10-02 12:12:14 UTC, push 0x1665261fc1eea6e51a0d8fea3d9e81cc42baa1db4354b5992ab83e38fd0621ff): MISMATCH: mainnet printed no round at this time (nearest: 1:1430 at 2026-10-02 00:23:52)

2 of 3 rounds match Robinhood Chain mainnet Chainlink
exit=1
```

## Settlement rounds (dry run before expiry)

`--settlement <vault>` finds the round each series of a vault settled at (`StockOracle`'s `SettlementPriceRecorded`) or will settle at (the first MirrorFeed round at or after expiry), checks it against mainnet, checks that the recorded price is that round's answer, and says whether it is mainnet's first print at or after expiry (what a settlement on mainnet would use). At 12:12 UTC the three live series expire in 7h 47m, so the check reports that no candidate round exists yet. After 20:00 UTC the same commands check the round the keeper settles at.

```text
$ node scripts/verify-mirror.mjs --chain 46630 --settlement 0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e
Settlement audit: vault 0xADFF7900dbe01E8170a750AB88e1f4eA8D9D1D4e (v2, EpochManager 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99) on Robinhood Chain testnet (46630)
Testnet time 2026-10-02 12:12:36 UTC, mainnet time 2026-10-02 12:12:38 UTC.

Series 8614008145645214741184698995285385951692715470493509368088435356950067027964 (epoch 1): TSLA, expiry 2026-10-02 20:00:00 UTC, 4 options sold
  Feed read by the oracle: 0x5476cb08769f406dE95F6171AcC1F5FE88431230, copying 0x4A1166a659A55625345e9515b32adECea5547C38
  Result: Not settled yet; candidate round not yet printed (expires 2026-10-02 20:00 UTC, in 7h 47m).

No settlement round of this vault fails the check against Robinhood Chain mainnet Chainlink
exit=0
```

The v3 covered call on 46630, agent #2's put vault (no series yet), v2's put vault (its proposal was rejected, no series) and the v3 covered call on Arbitrum Sepolia:

```text
Settlement audit: vault 0x478E7BC3C3aB07fdd104e4765F178977adEe6285 (v3, EpochManager 0x256D4546486368dCb23E94758b4cb500c215929F) on Robinhood Chain testnet (46630)
Testnet time 2026-10-02 12:12:50 UTC, mainnet time 2026-10-02 12:12:51 UTC.

Series 48103703716925406245656156603615117052914973735876202170787552644395932337728 (epoch 1): TSLA, expiry 2026-10-02 20:00:00 UTC, 4 options sold
  Feed read by the oracle: 0x5476cb08769f406dE95F6171AcC1F5FE88431230, copying 0x4A1166a659A55625345e9515b32adECea5547C38
  Result: Not settled yet; candidate round not yet printed (expires 2026-10-02 20:00 UTC, in 7h 47m).

No settlement round of this vault fails the check against Robinhood Chain mainnet Chainlink
exit=0
Settlement audit: vault 0x8aEb1e0aC30Ff7829609954688B2aC649Ef26969 (v2, EpochManager 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99) on Robinhood Chain testnet (46630)
Testnet time 2026-10-02 12:12:53 UTC, mainnet time 2026-10-02 12:12:54 UTC.

The vault has sold no series yet.
No settlement round of this vault fails the check against Robinhood Chain mainnet Chainlink
exit=0
Settlement audit: vault 0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7 (v2, EpochManager 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99) on Robinhood Chain testnet (46630)
Testnet time 2026-10-02 12:12:55 UTC, mainnet time 2026-10-02 12:12:56 UTC.

The vault has sold no series yet.
No settlement round of this vault fails the check against Robinhood Chain mainnet Chainlink
exit=0
Settlement audit: vault 0x5655659E18bf54ee0EF8f6A816E2e18D000F7311 (v3, EpochManager 0xB8Ed17588AB022d8f84b8305d784Fa01478Cb7F0) on Arbitrum Sepolia (421614)
Testnet time 2026-10-02 12:12:56 UTC, mainnet time 2026-10-02 12:12:59 UTC.

Series 8200340887102394470889505950118944065123972136398888610989328404594772867353 (epoch 1): TSLA, expiry 2026-10-02 20:00:00 UTC, 4 options sold
  Feed read by the oracle: 0x85B92cF975E3cf9Ad44c0664d6aF67f358360FFA, copying 0x4A1166a659A55625345e9515b32adECea5547C38
  Result: Not settled yet; candidate round not yet printed (expires 2026-10-02 20:00 UTC, in 7h 47m).

No settlement round of this vault fails the check against Robinhood Chain mainnet Chainlink
exit=0
```

## Full output

```text
$ node scripts/verify-mirror.mjs --chain 46630
Price mirror audit: Robinhood Chain testnet (46630) MirrorFeeds against Robinhood Chain mainnet (4663) Chainlink
Testnet block 127,590,299 (2026-10-02 12:12:16 UTC), mainnet block 78,221,452 (2026-10-02 12:12:19 UTC).
Mainnet round = phase:aggregator round (the proxy's round id is phase << 64 | aggregator round).

AMD  MirrorFeed 0xf7f60670f8D45a648b2844aF1d25c2C6C02ffA4E copies RHAMD / USD 0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72
  Round  Price          updatedAt (UTC)      Mainnet   Push tx      Result
  1      160            2026-09-28 21:11:19  -         0x8756cde9…  deploy seed (Deploy.s.sol), not a mainnet price
  2      611.305        2026-09-29 16:44:36  1:3027    0x7d02afa8…  match
  3      603.745        2026-09-30 13:53:04  1:3039    0x3934fafd…  match
  4      600.611        2026-09-30 15:18:06  1:3040    0x568cabc8…  match
  5      603.671        2026-09-30 16:07:37  1:3041    0xe24c2643…  match
  6      615.55         2026-10-01 02:23:47  1:3049    0x4c10bf5c…  match
  7      618.69         2026-10-01 03:16:18  1:3050    0xc219f151…  match
  8      621.855        2026-10-01 03:54:48  1:3051    0xe7aa1d04…  match
  9      625            2026-10-01 05:19:50  1:3052    0x8d435584…  match
  10     628.18         2026-10-01 05:55:20  1:3053    0xc371f207…  match
  11     621.615        2026-10-01 07:26:52  1:3055    0xa154a5ff…  match
  12     618.50005      2026-10-01 08:24:53  1:3056    0xe976158b…  match
  13     615.40045      2026-10-01 11:19:56  1:3057    0x77729cc5…  match
  14     612.3214       2026-10-01 12:58:29  1:3058    0xa7d1ad8a…  match
  15     617.145        2026-10-01 13:41:29  1:3061    0x0a3e2d97…  match
  16     611.005        2026-10-01 14:40:18  1:3068    0xfbed84b0…  match
  17     607.69         2026-10-01 15:01:19  1:3069    0x6607e33e…  match
  18     611.082        2026-10-01 15:25:49  1:3070    0x2a9aaf3c…  match
  19     607.935        2026-10-01 15:36:19  1:3071    0x43bbacd6…  match
  20     618.2158       2026-10-01 17:31:20  1:3074    0x8b8e99ec…  match
  21     617.99         2026-10-01 18:35:22  1:3078    0xeab156ba…  match
  22     617.8791       2026-10-01 19:50:23  1:3080    0x89fd991d…  match
  23     614.78855      2026-10-01 21:26:55  1:3081    0xa0adcccf…  match
  24     618.605        2026-10-02 00:42:29  1:3084    0x7e4b403e…  match
  25     621.75         2026-10-02 07:14:36  1:3085    0x797139da…  match
  26     625.13975      2026-10-02 08:22:07  1:3086    0xd1aa56be…  match
  25 of 25 keeper rounds match; the keeper mirrored 25 of the 60 mainnet prints from its first push to its last, and 1 printed since; largest gap between pushes: round 2 to 3, 21h 8m, 11 mainnet print(s) in between not mirrored.

AMZN  MirrorFeed 0x698a624940DdAfA8380dbF933AbC1c2908796877 copies Robinhood AMZN / USD 0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C
  Round  Price          updatedAt (UTC)      Mainnet   Push tx      Result
  1      225            2026-09-28 21:11:19  -         0xa9d803d6…  deploy seed (Deploy.s.sol), not a mainnet price
  2      247.512        2026-09-29 16:51:10  1:845     0xe65fcc04…  match
  3      250.305        2026-09-30 14:02:03  1:853     0x6b8a28c8…  match
  4      251.71499999   2026-09-30 14:53:34  1:854     0x87b0f99b…  match
  5      250.375        2026-09-30 23:59:01  1:857     0x8b2f428e…  match
  6      251.675        2026-10-01 10:43:12  1:858     0x7d20712b…  match
  7      249.0651       2026-10-01 13:44:45  1:860     0x801acb2e…  match
  8      247.635        2026-10-01 14:01:16  1:861     0x6f1d3796…  match
  9      246.37         2026-10-01 14:54:46  1:862     0xa7a7784b…  match
  10     248.87         2026-10-01 17:25:19  1:864     0xa37a3724…  match
  11     250.165        2026-10-02 07:59:05  1:865     0x16f4e312…  match
  10 of 10 keeper rounds match; the keeper mirrored 10 of the 21 mainnet prints from its first push to its last, and 0 printed since; largest gap between pushes: round 2 to 3, 21h 10m, 7 mainnet print(s) in between not mirrored.

NFLX  MirrorFeed 0xc7e34AC0E39663b580Fe044c04F2b7aa7949b30D (no mainnet feed)
  1 round(s), not checked: Chainlink publishes no NFLX feed on Robinhood Chain mainnet.

PLTR  MirrorFeed 0x2992a2661f4eb802EFF63a985914a80D262c5291 copies Robinhood PLTR / USD 0x820ABedFF239034956B7A9d2F0a331f9F075eB4c
  Round  Price          updatedAt (UTC)      Mainnet   Push tx      Result
  1      180            2026-09-28 21:11:19  -         0xe4de2af7…  deploy seed (Deploy.s.sol), not a mainnet price
  2      186.185        2026-09-29 14:47:06  1:2091    0xd7e91c93…  match
  3      189.105        2026-09-30 14:11:53  1:2101    0xfbffa9ad…  match
  4      190.153        2026-09-30 14:55:23  1:2102    0x0420e1dc…  match
  5      187.09545      2026-09-30 23:53:03  1:2107    0x74b1ec4b…  match
  6      188.12         2026-10-01 04:28:08  1:2108    0x3e48a298…  match
  7      187.16         2026-10-01 07:21:41  1:2109    0x2a0cda9c…  match
  8      188.15795      2026-10-01 10:54:14  1:2110    0x6d4f1807…  match
  9      189.1156       2026-10-01 12:04:16  1:2111    0x7f2f8659…  match
  10     187.765        2026-10-01 13:32:17  1:2114    0x8d59929a…  match
  11     189.44         2026-10-01 14:41:06  1:2123    0x25f2c74f…  match
  12     188.38         2026-10-01 15:08:36  1:2124    0xe2440cfd…  match
  13     189.43455      2026-10-01 17:57:09  1:2127    0x775763f3…  match
  14     190.44         2026-10-01 19:09:10  1:2128    0xb28d470b…  match
  15     189.48485      2026-10-01 20:56:42  1:2129    0x5fd9962f…  match
  16     190.463        2026-10-01 22:54:44  1:2130    0x017a4344…  match
  17     191.66445      2026-10-02 08:04:06  1:2131    0x97d08b4b…  match
  16 of 16 keeper rounds match; the keeper mirrored 16 of the 41 mainnet prints from its first push to its last, and 0 printed since; largest gap between pushes: round 2 to 3, 23h 24m, 9 mainnet print(s) in between not mirrored.

TSLA  MirrorFeed 0x5476cb08769f406dE95F6171AcC1F5FE88431230 copies RHTSLA / USD 0x4A1166a659A55625345e9515b32adECea5547C38
  Round  Price          updatedAt (UTC)      Mainnet   Push tx      Result
  1      369            2026-09-28 21:11:19  -         0x13e46b12…  deploy seed (Deploy.s.sol), not a mainnet price
  2      352.453        2026-09-29 16:45:22  1:1390    0xa717188c…  match
  3      350.005        2026-09-30 14:18:59  1:1404    0x1554091f…  match
  4      348.24         2026-09-30 15:08:00  1:1405    0xc4697b3b…  match
  5      350.23         2026-09-30 15:49:01  1:1406    0x5b1a4afb…  match
  6      355.88         2026-10-01 02:04:42  1:1411    0x1b398916…  match
  7      357.66999999   2026-10-01 05:00:45  1:1412    0x4338176f…  match
  8      355.8108       2026-10-01 08:11:48  1:1413    0x4ed3ac52…  match
  9      355.86         2026-10-01 13:35:41  1:1415    0xab0da139…  match
  10     356.27         2026-10-01 14:33:42  1:1419    0x7ecca1a2…  match
  11     358.5505       2026-10-01 14:42:42  1:1420    0xe77c46c0…  match
  12     358.28         2026-10-01 15:17:12  1:1422    0x25a93c7f…  match
  13     356.3938       2026-10-01 15:35:43  1:1423    0x81a02c0e…  match
  14     356.264        2026-10-01 17:54:45  1:1427    0xc44f8466…  match
  15     354.904        2026-10-01 19:55:17  1:1429    0x47dc23aa…  match
  16     356.68         2026-10-02 00:23:52  1:1430    0xa49aa0d6…  match
  15 of 15 keeper rounds match; the keeper mirrored 15 of the 41 mainnet prints from its first push to its last, and 0 printed since; largest gap between pushes: round 2 to 3, 21h 33m, 13 mainnet print(s) in between not mirrored.

Not checked: NFLX (1 round(s)): Chainlink publishes no NFLX feed on Robinhood Chain mainnet.
Deploy seeds, listed apart (round 1, pushed by contracts/script/Deploy.s.sol when it created the feed, before the keeper ran; not mainnet prints): AMD 160 at 2026-09-28 21:11:19, AMZN 225 at 2026-09-28 21:11:19, PLTR 180 at 2026-09-28 21:11:19, TSLA 369 at 2026-09-28 21:11:19.
Largest gap between pushes: PLTR round 2 to 3, 23h 24m (2026-09-29 14:47:06 to 2026-09-30 14:11:53 UTC), 9 mainnet print(s) in between. The audit checks every value pushed; it cannot make the keeper push (withheld rounds show up only as gaps).

66 of 66 rounds match Robinhood Chain mainnet Chainlink
exit=0
```

```text
$ node scripts/verify-mirror.mjs --chain 421614
Price mirror audit: Arbitrum Sepolia (421614) MirrorFeeds against Robinhood Chain mainnet (4663) Chainlink
Testnet block 314,978,121 (2026-10-02 12:12:29 UTC), mainnet block 78,221,591 (2026-10-02 12:12:33 UTC).
Mainnet round = phase:aggregator round (the proxy's round id is phase << 64 | aggregator round).

NVDA  MirrorFeed 0x1B137e5CB2c0153B4B3f1cbBC78DdECBa5569aA1 copies RHNVDA / USD 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
  Round  Price          updatedAt (UTC)      Mainnet   Push tx      Result
  1      230.54857341   2026-09-30 14:09:17  1:1138    0x3d9cb2ba…  match
  2      229.23255408   2026-09-30 19:58:23  1:1139    0x473d054a…  match
  3      230.40846489   2026-10-01 03:55:32  1:1140    0x8c8a0ba6…  match
  4      231.6043912    2026-10-01 05:36:04  1:1141    0x95b5e19a…  match
  5      230.42347652   2026-10-01 07:28:36  1:1142    0x97417f84…  match
  6      230.33340675   2026-10-01 13:37:41  1:1144    0xadc8ffce…  match
  7      229.05241455   2026-10-01 14:59:43  1:1147    0x88fbf9bb…  match
  8      230.19930288   2026-10-01 15:20:14  1:1148    0x1b426b8a…  match
  9      231.39663028   2026-10-01 17:41:16  1:1151    0xff7ef197…  match
  10     232.5854019    2026-10-02 08:01:01  1:1152    0x606c95e7…  match
  11     233.80109268   2026-10-02 09:28:02  1:1153    0xb3cf03f9…  match
  12     235.02303915   2026-10-02 11:15:08  1:1154    0x7a084788…  match
  12 of 12 keeper rounds match; the keeper mirrored 12 of the 17 mainnet prints from its first push to its last, and 0 printed since; largest gap between pushes: round 9 to 10, 14h 19m, 0 mainnet print(s) in between not mirrored.

TSLA  MirrorFeed 0x85B92cF975E3cf9Ad44c0664d6aF67f358360FFA copies RHTSLA / USD 0x4A1166a659A55625345e9515b32adECea5547C38
  Round  Price          updatedAt (UTC)      Mainnet   Push tx      Result
  1      350.23         2026-09-30 15:49:01  1:1406    0xc824cfd2…  match
  2      355.88         2026-10-01 02:04:42  1:1411    0x17122935…  match
  3      357.66999999   2026-10-01 05:00:45  1:1412    0x6201f1d0…  match
  4      355.8108       2026-10-01 08:11:48  1:1413    0x18a3d2c8…  match
  5      355.86         2026-10-01 13:35:41  1:1415    0xf1608ee6…  match
  6      358.5505       2026-10-01 14:42:42  1:1420    0xc4caef6b…  match
  7      358.28         2026-10-01 15:17:12  1:1422    0xfb240acb…  match
  8      356.3938       2026-10-01 15:35:43  1:1423    0x219eabc4…  match
  9      356.264        2026-10-01 17:54:45  1:1427    0xe8f24252…  match
  10     354.904        2026-10-01 19:55:17  1:1429    0x3e8c7b3b…  match
  11     356.68         2026-10-02 00:23:52  1:1430    0x966ae34b…  match
  11 of 11 keeper rounds match; the keeper mirrored 11 of the 25 mainnet prints from its first push to its last, and 0 printed since; largest gap between pushes: round 1 to 2, 10h 15m, 4 mainnet print(s) in between not mirrored.

Largest gap between pushes: NVDA round 9 to 10, 14h 19m (2026-10-01 17:41:16 to 2026-10-02 08:01:01 UTC), 0 mainnet print(s) in between. The audit checks every value pushed; it cannot make the keeper push (withheld rounds show up only as gaps).

23 of 23 rounds match Robinhood Chain mainnet Chainlink
exit=0
```
