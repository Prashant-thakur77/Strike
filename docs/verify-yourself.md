# Verify it yourself, with standard tools

Six checks of Strike's headline claims that use only Foundry's `cast`, `jq`, `curl` and standard shell tools (`sed`, `awk`, `sha256sum`, `wc`). No Strike SDK, script or app is involved, and you do not need to clone this repository: every input comes from a public RPC, the Blockscout API or a raw file URL. Every command is a read; none needs a key or sends a transaction.

The expected outputs below were copied from our own run on 2 October 2026 between 15:00 and 15:30 UTC (cast 1.7.1, jq 1.8.1, bash 5). Where a command reads live state, the text says how the value changes later. Everything else reads a past transaction or a past price round and gives the same output forever.

| Check                                                                | What it proves                                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| [1. A buy](#1-a-buy)                                                 | The buyer paid 7.38387 USDG into escrow and received 4 options of the series, and the series' sale counters agree                   |
| [2. A rejection and its slash](#2-a-rejection-and-its-slash)         | The contract rejected an out-of-mandate proposal, took 10 USDG of the agent's bond and paid it, through the vault, to the depositor |
| [3. A decision record](#3-a-decision-record-against-its-anchor)      | The published record is byte for byte the one the agent's registered key anchored on-chain                                          |
| [4. A mirrored price](#4-a-mirrored-price-against-mainnet-chainlink) | A testnet price round equals the Robinhood Chain mainnet Chainlink round with the same timestamp                                    |
| [5. Settlement](#5-the-settlement-price)                             | The settlement price is the first mirrored round after expiry, and whether that is mainnet's first print after expiry               |
| [6. A vault's mandate](#6-a-vaults-mandate)                          | The mandate the contract enforces is the one the vault was created with, and no function can change it                              |

## Setup

You need [Foundry](https://getfoundry.sh) (for `cast`), jq 1.7 or later, curl and bash. Run everything below in one shell, in an empty directory (check 3 writes two files).

```bash
RH=https://rpc.testnet.chain.robinhood.com     # Robinhood Chain testnet, chain id 46630
MAIN=https://rpc.mainnet.chain.robinhood.com   # Robinhood Chain mainnet, 4663: the Chainlink feeds
EM=0x256D4546486368dCb23E94758b4cb500c215929F  # the v3 EpochManager on 46630 (DEPLOYMENTS.md)
cast chain-id --rpc-url $RH
cast chain-id --rpc-url $MAIN
curl -s https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts/$EM | jq -r '.name, .is_fully_verified'
```

```text
46630
4663
EpochManager
true
```

Blockscout holds the verified source of that address. The other addresses come from the EpochManager itself, so there is only one address to trust from us:

```bash
USDG=$(cast call $EM "usdg()(address)" --rpc-url $RH)
OPT=$(cast call $EM "optionToken()(address)" --rpc-url $RH)
SO=$(cast call $EM "oracle()(address)" --rpc-url $RH)
REG=$(cast call $EM "agents()(address)" --rpc-url $RH)
echo "usdg $USDG"; echo "optionToken $OPT"; echo "stockOracle $SO"; echo "agentRegistry $REG"
```

```text
usdg 0x7E955252E15c84f5768B83c41a71F9eba181802F
optionToken 0xfbeb6cf8350C182c7895165A8Fdd3D9884aB46B6
stockOracle 0x5BCdBFaB940BFAEF821392d7f58c670c2064989A
agentRegistry 0x1c42740145B245b2f894d8e989ca29dfd9A9052f
```

Two shell functions keep the checks short. `transfers` lists every ERC-20 `Transfer` in a transaction; `event` prints one contract's logs of one event in a transaction, matched by the event's signature hash (`cast sig-event`) and by the emitting address, so a look-alike event from another contract is ignored.

```bash
transfers() {  # transfers <tx> <rpc>: "token from -> to amount"
  cast receipt "$1" --json --rpc-url "$2" |
    jq -r --arg t "$(cast sig-event 'Transfer(address,address,uint256)')" \
      '.logs[] | select(.topics[0] == $t and (.topics | length) == 3) | "\(.address) \(.topics[1]) \(.topics[2]) \(.data)"' |
    while read -r token from to amount; do
      echo "$token $(cast parse-bytes32-address "$from") -> $(cast parse-bytes32-address "$to") $(cast to-dec "$amount")"
    done
}
event() {  # event <tx> <rpc> <emitter> <signature>: one JSON object per matching log
  cast receipt "$1" --json --rpc-url "$2" |
    jq -c --arg a "$3" --arg t "$(cast sig-event "$4")" \
      '.logs[] | select((.address | ascii_downcase) == ($a | ascii_downcase) and .topics[0] == $t) | {topics, data}'
}
```

USDG has 6 decimals (7383870 is 7.38387 USDG); option amounts, stock amounts and prices inside the contracts have 18 (4000000000000000000 is 4 options, 369360000000000000000 is $369.36); Chainlink answers have 8 (35668000000 is $356.68).

## 1. A buy

The 1 October buy on v3: 4 TSLA calls of the covered-call vault's series ([tx on Blockscout](https://explorer.testnet.chain.robinhood.com/tx/0x16d9345d815d1d5fb5a39540533b725367cfbaeab0287647f984d0202b6a61fc)).

```bash
BUY=0x16d9345d815d1d5fb5a39540533b725367cfbaeab0287647f984d0202b6a61fc
cast receipt $BUY status --rpc-url $RH
LOG=$(event $BUY $RH $EM "OptionsBought(uint256,address,address,uint256,uint256)")
SERIES=$(cast to-dec $(echo "$LOG" | jq -r '.topics[1]'))
BUYER=$(cast parse-bytes32-address $(echo "$LOG" | jq -r '.topics[2]'))
echo "series $SERIES"; echo "buyer $BUYER"
cast abi-decode "f()(uint256,uint256)" $(echo "$LOG" | jq -r .data)   # amount, premium
transfers $BUY $RH
MINT=$(event $BUY $RH $OPT "TransferSingle(address,address,address,uint256,uint256)")
echo "from $(cast parse-bytes32-address $(echo "$MINT" | jq -r '.topics[2]')) to $(cast parse-bytes32-address $(echo "$MINT" | jq -r '.topics[3]'))"
cast abi-decode "f()(uint256,uint256)" $(echo "$MINT" | jq -r .data)  # token id, amount
```

```text
true
series 48103703716925406245656156603615117052914973735876202170787552644395932337728
buyer 0x1a00BaDC191FFcB65d16D27C0d1F3599528F7364
4000000000000000000 [4e18]
7383870 [7.383e6]
0x7e955252e15c84f5768b83c41a71f9eba181802f 0x1a00BaDC191FFcB65d16D27C0d1F3599528F7364 -> 0x256D4546486368dCb23E94758b4cb500c215929F 7383870
from 0x0000000000000000000000000000000000000000 to 0x1a00BaDC191FFcB65d16D27C0d1F3599528F7364
48103703716925406245656156603615117052914973735876202170787552644395932337728 [4.81e76]
4000000000000000000 [4e18]
```

Then the state the buy left behind: the series, and the buyer's option balance.

```bash
cast call $EM "getSeries(uint256)((address,address,uint256,uint64,uint16,bool,bool,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))" $SERIES --rpc-url $RH
cast call $OPT "balanceOf(address,uint256)(uint256)" $BUYER $SERIES --rpc-url $RH
```

```text
(0x478E7BC3C3aB07fdd104e4765F178977adEe6285, 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E, 1, 1790971200 [1.79e9], 10500 [1.05e4], true, false, false, 369360000000000000000 [3.693e20], 4000000000000000000 [4e18], 4000000000000000000 [4e18], 7383870 [7.383e6], 4000000000000000000 [4e18], 0, 0, 0)
4000000000000000000 [4e18]
```

The fields are vault, underlying, agent, expiry, premium factor in basis points, is a call, settled, cancelled, strike, size, sold, premium, collateral, settlement price, payout per option and escrow. This is live state as of our run, before settlement: once the series settles, `settled` turns `true` and the settlement price is filled in (check 5), and the buyer's balance drops to 0 if they redeem. `sold` and `premium` never change after the last sale.

**What it proves.** The transaction succeeded. The EpochManager recorded a sale of 4 options of series `4810…7728` for 7.38387 USDG. In the same transaction the buyer's 7,383,870 USDG units moved to the EpochManager, which holds premiums in escrow until settlement, and the option token minted exactly 4 options of that series from the zero address to the buyer. The series agrees: 4 of 4 sold, 7,383,870 premium, strike $369.36, expiry 1790971200 (2026-10-02 20:00 UTC), priced at 105% of fair value. **What it does not prove:** that 7.38387 USDG was the contract's quote at that moment. The quote depends on the spot and volatility at that block, and re-executing the transaction (`cast run $BUY`) needs an archive node, which the public RPC is not.

## 2. A rejection and its slash

The fullest case is on v2, 29 September: the reckless agent's at-the-money put was rejected, its 10 USDG slash went to the put vault when the epoch closed, and the depositor withdrew it. Three transactions ([epoch log](testnet-epochs/2026-09-29.md)).

**The rejection** ([tx](https://explorer.testnet.chain.robinhood.com/tx/0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0)):

```bash
EM2=0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99   # the v2 EpochManager on 46630
REJ=0x3df523aae815e10cba8f5f99076f9cb348745e7657dd1f1338820af0469dc6a0
LOG=$(event $REJ $RH $EM2 "ProposalRejected(address,uint64,uint256,uint8,uint256,uint256,uint64,uint256,uint16)")
VAULT2=$(cast parse-bytes32-address $(echo "$LOG" | jq -r '.topics[1]'))
echo "vault $VAULT2, epoch $(cast to-dec $(echo "$LOG" | jq -r '.topics[2]')), agent $(cast to-dec $(echo "$LOG" | jq -r '.topics[3]'))"
cast abi-decode "f()(uint8,uint256,uint256,uint64,uint256,uint16)" $(echo "$LOG" | jq -r .data)  # reason, slashed, strike, expiry, size, premium bps
transfers $REJ $RH
```

```text
vault 0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7, epoch 1, agent 1
8
10000000 [1e7]
352440000000000000000 [3.524e20]
1790971200 [1.79e9]
45397798206786970 [4.539e16]
10000 [1e4]
0x7e955252e15c84f5768b83c41a71f9eba181802f 0xE5b76249041e59C74Ee317fC2729f26249618D32 -> 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 10000000
```

Reason 8 is a position in the `MandateGuard.Reason` enum. Read the enum from the verified source on Blockscout, not from this repository:

```bash
curl -s https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts/$EM2 |
  jq -r '.additional_sources[] | select(.file_path == "src/libraries/MandateGuard.sol") | .source_code' |
  sed -n '/enum Reason {/,/}/p' | sed '1d;$d' | tr -d ' ,' | awk '{print NR-1, $0}'
```

```text
0 None
1 ZeroSize
2 TenorOutOfRange
3 InvalidExpiry
4 StrikeWrongSide
5 SizeTooLarge
6 PremiumBelowFair
7 PremiumAboveCap
8 DeltaOutOfBand
9 PremiumTooSmall
```

**The slash reaches the vault, then the depositor.** The curator closed the epoch with `abortEpoch` ([tx](https://explorer.testnet.chain.robinhood.com/tx/0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7)), and the depositor claimed ([tx](https://explorer.testnet.chain.robinhood.com/tx/0x1c53ff12ec2e9749e84f92ae4fa29a4d584789a8abd661e6f099151361067620)):

```bash
ABORT=0x62442f37b3601aa5b56d5e991d3199464ba2e60373f70e00892746c053b629a7
transfers $ABORT $RH
event $ABORT $RH $VAULT2 "EpochSettled(uint64,uint256,uint256,uint256,uint256,uint256)" | jq -r .data |
  xargs cast abi-decode "f()(uint256,uint256,uint256,uint256,uint256)"   # payout, premium, assets, supply, premium per share x 1e36
CLAIM=0x1c53ff12ec2e9749e84f92ae4fa29a4d584789a8abd661e6f099151361067620
transfers $CLAIM $RH
cast call $EM2 "compensation(address)(uint256)" $VAULT2 --rpc-url $RH
```

```text
0x7e955252e15c84f5768b83c41a71f9eba181802f 0x5A3b58DF27e4DD5E0fa6493D90fF653e0E199C99 -> 0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7 10000000
0
10000000 [1e7]
20000000 [2e7]
20000000 [2e7]
500000000000000000000000000000000000 [5e35]
0x7e955252e15c84f5768b83c41a71f9eba181802f 0xE33EAD75Df1aF35cBA330f1fc7636926e31c67d7 -> 0x26b277b434B1670f207Afd8946edA9AF78A613Ff 10000000
0
```

**The same rejection on v3**, 1 October ([tx](https://explorer.testnet.chain.robinhood.com/tx/0xa8b5eba59bbffd9203c9deab6053754df82f69396fbc03b41de2a9897de7efb2)). That put vault's epoch is still open, so the slash is still held for its depositors:

```bash
PUT3=0x1bc73c1B28F520E57982FAe6127477190FA53690
transfers 0xa8b5eba59bbffd9203c9deab6053754df82f69396fbc03b41de2a9897de7efb2 $RH
cast call $EM "compensation(address)(uint256)" $PUT3 --rpc-url $RH
cast call $USDG "balanceOf(address)(uint256)" $EM --rpc-url $RH
```

```text
0x7e955252e15c84f5768b83c41a71f9eba181802f 0x1c42740145B245b2f894d8e989ca29dfd9A9052f -> 0x256D4546486368dCb23E94758b4cb500c215929F 10000000
10000000 [1e7]
17383870 [1.738e7]
```

**What it proves.** The v2 contract judged agent #1's put at strike $352.44 against the vault's mandate and rejected it with `DeltaOutOfBand`; it did not revert. In the same transaction the AgentRegistry sent 10 USDG of the agent's bond to the EpochManager. When the epoch closed, the EpochManager paid those 10 USDG to the put vault, which booked them as premium on its 20 USDG of collateral (payout 0, collateral and share supply unchanged at 20,000,000), and the depositor claimed exactly 10 USDG from the vault. Nothing is still owed (`compensation` 0). On v3 the 10 USDG wait as `compensation` until that epoch closes. The v3 EpochManager's USDG balance at our run, 17,383,870, is exactly check 1's escrowed premium (7,383,870) plus that compensation (10,000,000). Both live values change: the premium leaves the EpochManager at settlement, and the compensation when the put vault's epoch closes.

## 3. A decision record against its anchor

The record of the v3 rejection above, as the agent published it. The app's "Why this strike" panel fetches the same raw file.

```bash
curl -s https://raw.githubusercontent.com/Prashant-thakur77/Strike/main/docs/agent-log/2026-10-01-sTSLA-CSP.json -o record.json
jq -r '.anchor | .contract, .recordHash, .txHash, .epoch' record.json
```

```text
0xa98106db53519F8cfE4D7C56B34D4Fe0460403a4
0x51003bc2b3f8650ec40f05b6e50f9d7d5373225de5e555d8ebab16a8b5f8892a
0x966985d8ca2026bb6426a46d35ae708a48724a6ed74208a1ecd9c65fbf4a6e27
1
```

The `anchor` field is the record's own claim; do not trust it, rebuild it. The hash covers the record without its `anchor` field and without the `DecisionLog.record` entry in `transactions` (a record cannot contain the transaction that anchors it), written as JSON with two-space indentation, keys in the original order, number literals unchanged and one trailing newline. That is `JSON.stringify(record, null, 2) + "\n"` in JavaScript, which is how the agent wrote the file ([`agents/example/src/anchor.ts`](../agents/example/src/anchor.ts) and [`sdk/src/decisionRecord.ts`](../sdk/src/decisionRecord.ts) if you want to read the rule in code), and it is exactly what jq 1.7 or later prints:

```bash
jq 'del(.anchor) | .transactions |= map(select(.label != "DecisionLog.record"))' record.json > unanchored.json
wc -c < unanchored.json
sha256sum unanchored.json
cast keccak < unanchored.json
```

```text
3305
e5b474558947aed781d31128f2c83960885d22f60e73eedc1ca87b8a0952d929  unanchored.json
0x51003bc2b3f8650ec40f05b6e50f9d7d5373225de5e555d8ebab16a8b5f8892a
```

If your jq prints something else, compare the size and the SHA-256: those are the exact bytes. `cast keccak` reads standard input as raw bytes; `cast keccak "$(cat unanchored.json)"` would drop the trailing newline and give another hash. Now the anchor on chain, from the `DecisionRecorded` event of the anchoring transaction ([tx](https://explorer.testnet.chain.robinhood.com/tx/0x966985d8ca2026bb6426a46d35ae708a48724a6ed74208a1ecd9c65fbf4a6e27)):

```bash
DLOG=0xa98106db53519F8cfE4D7C56B34D4Fe0460403a4
ANCHOR=0x966985d8ca2026bb6426a46d35ae708a48724a6ed74208a1ecd9c65fbf4a6e27
LOG=$(event $ANCHOR $RH $DLOG "DecisionRecorded(uint256,address,uint64,bytes32,string,uint256)")
echo "agent $(cast to-dec $(echo "$LOG" | jq -r '.topics[1]')), vault $(cast parse-bytes32-address $(echo "$LOG" | jq -r '.topics[2]')), epoch $(cast to-dec $(echo "$LOG" | jq -r '.topics[3]'))"
cast abi-decode "f()(bytes32,string,uint256)" $(echo "$LOG" | jq -r .data)   # hash, uri, timestamp
echo "sent by $(cast receipt $ANCHOR from --rpc-url $RH); agent 1's signer is $(cast call $REG 'signerOf(uint256)(address)' 1 --rpc-url $RH)"
cast call $DLOG "registry()(address)" --rpc-url $RH
```

```text
agent 1, vault 0x1bc73c1B28F520E57982FAe6127477190FA53690, epoch 1
0x51003bc2b3f8650ec40f05b6e50f9d7d5373225de5e555d8ebab16a8b5f8892a
"https://github.com/Prashant-thakur77/Strike/blob/main/docs/agent-log/2026-10-01-sTSLA-CSP.json"
1790866350 [1.79e9]
sent by 0x4fd9565bf8C0Bda9bBdF2Add233d19c64e50AC6f; agent 1's signer is 0x4fd9565bf8C0Bda9bBdF2Add233d19c64e50AC6f
0x1c42740145B245b2f894d8e989ca29dfd9A9052f
```

A changed record fails: `sed 's/0.4928/0.4929/' unanchored.json | cast keccak` prints `0x4bbed215b1681166332f9934f0321669e1e6644869c5e8fbf9b575b00386098d`.

**What it proves.** The file served today hashes to the value agent #1's registered signer anchored at 1790866350 (2026-10-01 14:52:30 UTC), six seconds after the rejection it describes (block 127183195, 14:52:24 UTC). `DecisionLog.record` accepts only `AgentRegistry.signerOf(agentId)`, and this DecisionLog reads the v3 AgentRegistry from the setup. So not a byte of the record has changed since then. `cast call $DLOG "latestHash(uint256,address,uint64)(bytes32)" 1 $PUT3 1` returns the same hash today, but it keeps only the newest anchor per agent, vault and epoch (a later record for the same epoch replaces it), so the event in the anchoring transaction is the evidence to rely on. **What it does not prove:** who or what wrote the reasoning in the record.

## 4. A mirrored price against mainnet Chainlink

Which feed does the v3 StockOracle read for TSLA, and what is in its round 16?

```bash
TSLA=0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E   # the TSLA stock token on 46630
CL=0x4A1166a659A55625345e9515b32adECea5547C38     # TSLA / USD Chainlink proxy on Robinhood Chain mainnet
MF=$(cast call $SO "feedConfig(address)((address,uint32,uint32,uint8))" $TSLA --rpc-url $RH | tr -d '(' | cut -d, -f1)
echo "feed $MF: $(cast call $MF 'description()(string)' --rpc-url $RH)"
cast call $MF "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" 16 --rpc-url $RH
```

```text
feed 0x5476cb08769f406dE95F6171AcC1F5FE88431230: "TSLA / USD (mirror of mainnet Chainlink)"
16
35668000000 [3.566e10]
1790900632 [1.79e9]
1790900632 [1.79e9]
16
```

Now find the mainnet round with the same `updatedAt`. A Chainlink proxy's round id is `phase << 64 | aggregator round`, so the loop walks the aggregator's round numbers back from the latest and prints the first round at or before that time:

```bash
T=1790900632   # updatedAt of mirror round 16
cast call $CL "description()(string)" --rpc-url $MAIN
PHASE=$(cast call $CL "phaseId()(uint16)" --rpc-url $MAIN)
N=$(cast call $(cast call $CL "aggregator()(address)" --rpc-url $MAIN) "latestRound()(uint256)" --rpc-url $MAIN | cut -d' ' -f1)
while :; do
  ID=$(printf '0x%x%016x' $PHASE $N)
  read -r _ ANSWER _ UPDATED _ <<< "$(cast call $CL 'getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)' $ID --rpc-url $MAIN | cut -d' ' -f1 | tr '\n' ' ')"
  [ "$UPDATED" -le "$T" ] && break
  N=$((N - 1))
done
echo "mainnet round $ID (phase $PHASE, round $N): answer $ANSWER, updatedAt $UPDATED"
```

```text
"RHTSLA / USD"
mainnet round 0x10000000000000596 (phase 1, round 1430): answer 35668000000, updatedAt 1790900632
```

Who pushed it, and when:

```bash
FROM=$(cast find-block $T --rpc-url $RH)
cast logs --from-block $FROM --to-block $((FROM + 20000)) --address $MF \
  "AnswerUpdated(int256 indexed current,uint256 indexed roundId,uint256 updatedAt)" "" 16 --rpc-url $RH --json |
  jq -r '.[0].transactionHash'
```

```text
0xa49aa0d6e3be567554bf1b099f28f38ebd4df41caaea18021b0c500dae4e81d0
```

`cast receipt 0xa49aa0d6e3be567554bf1b099f28f38ebd4df41caaea18021b0c500dae4e81d0 from --rpc-url $RH` prints the keeper, `0x26b277b434B1670f207Afd8946edA9AF78A613Ff`, and the transaction is in block 127347649 (00:48:37 UTC).

**What it proves.** The price the v3 contracts read for TSLA in round 16, $356.68 at 2026-10-02 00:23:52 UTC, is exactly what Robinhood Chain mainnet's Chainlink TSLA feed printed at that second: the keeper copied it 25 minutes later and did not invent it. Mainnet's `startedAt` for that round is 13 seconds earlier; the mirror stores one time, `updatedAt`, which is the one the settlement rule reads. Repeat for any round number: a fabricated price has no mainnet round with its timestamp and answer. **What it does not prove:** that the keeper copied every mainnet print. It pushes when it runs, so it can skip prints; check 5 shows whether that matters for a settlement. `scripts/verify-mirror.mjs` runs this comparison for every round of every feed, if you prefer our code to your loop.

## 5. The settlement price

The series from check 1 expires at 1790971200 (2026-10-02 20:00 UTC). It settles at the first price round at or after expiry, recorded once in the StockOracle and final from then on. The keeper's settlement jobs run at about 20:40 UTC on 2 October. **The expected outputs in this section are filled after settlement**; at our run, before expiry, `settlementPrice` was `0` and the log query found nothing (`null`).

```bash
EXP=1790971200
cast call $SO "settlementPrice(address,uint64)(uint256)" $TSLA $EXP --rpc-url $RH
FROM=$(cast find-block $EXP --rpc-url $RH)
REC=$(cast logs --from-block $FROM --address $SO \
  "SettlementPriceRecorded(address indexed token,uint64 indexed expiry,uint80 roundId,uint256 price)" $TSLA $EXP \
  --rpc-url $RH --json | jq -c '.[0] | {transactionHash, data}')
echo "$REC" | jq -r .transactionHash
read -r ROUND PRICE <<< "$(cast abi-decode 'f()(uint80,uint256)' $(echo "$REC" | jq -r .data) | cut -d' ' -f1 | tr '\n' ' ')"
echo "round $ROUND, price $PRICE"
cast call $MF "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" $ROUND --rpc-url $RH
cast call $MF "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" $((ROUND - 1)) --rpc-url $RH
```

```text
Filled after settlement.
```

Expect: the price equals the round's answer times 10^10 (8 decimals to 18); the round's `updatedAt` is at or after `EXP`; the previous round's is before it. Then find mainnet's first print at or after expiry, with the same walk as check 4 (`PHASE` and `CL` from there):

```bash
N=$(cast call $(cast call $CL "aggregator()(address)" --rpc-url $MAIN) "latestRound()(uint256)" --rpc-url $MAIN | cut -d' ' -f1)
FIRST=none
while :; do
  ID=$(printf '0x%x%016x' $PHASE $N)
  read -r _ ANSWER _ UPDATED _ <<< "$(cast call $CL 'getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)' $ID --rpc-url $MAIN | cut -d' ' -f1 | tr '\n' ' ')"
  [ "$UPDATED" -lt "$EXP" ] && break
  FIRST="round $ID: answer $ANSWER, updatedAt $UPDATED"
  N=$((N - 1))
done
echo "mainnet's first print at or after $EXP: $FIRST"
```

```text
Filled after settlement.
```

We tested this loop against a past close: with `EXP=1790884800` (Thursday 1 October, 20:00 UTC) it prints `round 0x10000000000000596: answer 35668000000, updatedAt 1790900632`, the round from check 4, because mainnet's previous print came at 19:55:17 UTC.

**What it proves.** If the mirror round's answer and `updatedAt` equal mainnet's first print at or after expiry, the series settled at the price a mainnet deployment reading Chainlink directly would have used. If the mirror's round is a later mainnet print, the keeper missed the first one and the settlement used a later real price: the check shows that, and the [trust model](trust-model.md#what-is-still-on-trust-in-one-list) lists it as the part still on trust. Then `getSeries` from check 1 shows `settled` `true` and the same settlement price. The same steps work for the other two series that expire with it: v2 on 46630 (its StockOracle is `cast call $EM2 "oracle()(address)" --rpc-url $RH`, same feed) and v3 on Arbitrum Sepolia ([DEPLOYMENTS.md](DEPLOYMENTS.md)).

## 6. A vault's mandate

The v3 put vault from checks 2 and 3. The mandate the EpochManager enforces today:

```bash
cast call $EM "vaultConfig(address)((address,uint256,bool,(uint16,uint16,uint16,uint16,uint16,uint32,uint32)))" $PUT3 --rpc-url $RH
```

```text
(0x26b277b434B1670f207Afd8946edA9AF78A613Ff, 1, true, (1000, 3500, 9500, 5, 8000, 86400 [8.64e4], 691200 [6.912e5]))
```

Curator, agent, registered, then the mandate: |delta| from 0.10 to 0.35 (in basis points of 1), premium at least 95% of fair value, yield at least 0.05% of collateral, at most 80% of the vault's capacity sold, tenor from 1 to 8 days (in seconds). The vault's creation transaction, decoded from its calldata:

```bash
CREATE=0xe6a20a2fa543d7dd10445a3337f5233601cfa15d6630e531d4148def1b02d1cb
FACTORY=$(cast receipt $CREATE to --rpc-url $RH)
echo "factory $FACTORY; the EpochManager's factory role: $(cast call $EM 'hasRole(bytes32,address)(bool)' $(cast keccak FACTORY_ROLE) $FACTORY --rpc-url $RH)"
event $CREATE $RH $EM "VaultRegistered(address,address,uint256,address,bool)" | jq -r '.topics[1]' | xargs cast parse-bytes32-address
cast decode-calldata "createVault((address,bool,uint256,uint256,string,string,(uint16,uint16,uint16,uint16,uint16,uint32,uint32)))" \
  $(cast tx $CREATE input --rpc-url $RH)
```

```text
factory 0x97ab9ed707758Fc23b4e59132d97Ab7cb9fb215e; the EpochManager's factory role: true
0x1bc73c1B28F520E57982FAe6127477190FA53690
(0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E, false, 1, 5000000000000 [5e12], "Strike TSLA Cash-Secured Put", "sTSLA-CSP", (1000, 3500, 9500, 5, 8000, 86400 [8.64e4], 691200 [6.912e5]))
```

Nothing can change it. Every state-changing function in the EpochManager's verified ABI, filtered to those that take a mandate (a tuple):

```bash
curl -s https://explorer.testnet.chain.robinhood.com/api/v2/smart-contracts/$EM |
  jq -r '.abi[] | select(.type == "function" and .stateMutability != "view" and .stateMutability != "pure")
         | .name + "(" + ([.inputs[].type] | join(",")) + ")"' | grep tuple
cast call --from $FACTORY $EM "registerVault(address,address,uint256,(uint16,uint16,uint16,uint16,uint16,uint32,uint32))" \
  $PUT3 0x26b277b434B1670f207Afd8946edA9AF78A613Ff 1 "(0,10000,9000,10000,10000,1,3024000)" --rpc-url $RH 2>&1 |
  grep -o 'data: "0x[0-9a-f]*"'
cast decode-error --sig "VaultAlreadyRegistered(address)" 0x38bfcc160000000000000000000000001bc73c1b28f520e57982fae6127477190fa53690
cast storage $EM 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $RH
```

```text
registerVault(address,address,uint256,tuple)
data: "0x38bfcc160000000000000000000000001bc73c1b28f520e57982fae6127477190fa53690"
0x1bc73c1B28F520E57982FAe6127477190FA53690
0x0000000000000000000000000000000000000000000000000000000000000000
```

**What it proves.** The mandate the contract enforces now is the one in the vault's creation calldata (block 127181374), sent through the factory that holds the EpochManager's `FACTORY_ROLE`. The only state-changing function that takes a mandate is `registerVault`, and even the factory, simulated with `cast call --from`, gets `VaultAlreadyRegistered` for this vault: a wider mandate cannot be swapped in. The EpochManager is not an upgradeable proxy: its EIP-1967 implementation slot is empty, and the source Blockscout verified for this address has no upgrade function, so no new code can add a setter either. The agent can be replaced (`setVaultAgent`), the mandate cannot.

## What these checks do not cover

- **Admin powers.** A compromised admin can still choose a price before it is recorded, through `setFeed`, `setOracle` or `setPricer`; every use is an event. The mainnet deploy path puts those calls behind a 73-day timelock: [trust-model.md, "Staged path for the admin keys"](trust-model.md#staged-path-for-the-admin-keys).
- **The Stylus program against its source.** That needs `cargo stylus verify` with Docker, not `cast`: [gas.md](gas.md) and [DEPLOYMENTS.md](DEPLOYMENTS.md#stylus-pricer-verification).
- **Who wrote an agent's reasoning,** and whether a premium was the exact quote at its block (an archive node can replay it with `cast run`).
