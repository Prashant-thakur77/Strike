#!/usr/bin/env bash
# Strike testnet keeper.
#  1. Mirrors Robinhood Chain mainnet Chainlink stock prices into the testnet MirrorFeeds (Robinhood testnet has no
#     Chainlink stock feeds). Only newer rounds are pushed, with their original timestamps.
#  2. Settles expired epochs (settle is permissionless; the first round at or after expiry is found automatically).
#
# Usage: CHAIN_ID=46630 RPC_URL=https://rpc.testnet.chain.robinhood.com PRIVATE_KEY=0x... scripts/keeper.sh [--once]
# Needs Foundry (cast) and python3.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHAIN_ID="${CHAIN_ID:-46630}"
RPC_URL="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
MAINNET_RPC="${MAINNET_RPC:-https://rpc.mainnet.chain.robinhood.com}"
: "${PRIVATE_KEY:?PRIVATE_KEY is required (keeper role on the MirrorFeeds)}"
DEPLOY="$ROOT/contracts/deployments/$CHAIN_ID.json"

# Robinhood Chain mainnet Chainlink feeds (docs.chain.link, see docs/research.md). NFLX has none.
declare -A MAINNET_FEED=(
  [TSLA]=0x4A1166a659A55625345e9515b32adECea5547C38
  [NVDA]=0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15
  [AMZN]=0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C
  [PLTR]=0x820ABedFF239034956B7A9d2F0a331f9F075eB4c
  [AMD]=0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72
  [SPY]=0x319724394D3A0e3669269846abE664Cd621f9f6A
)

json() { python3 -c "import json,sys; d=json.load(open('$DEPLOY')); print(eval(sys.argv[1]))" "$1"; }

mirror_prices() {
  for sym in $(json "' '.join(d['stocks'].keys())"); do
    local src="${MAINNET_FEED[$sym]:-}"
    [ -z "$src" ] && continue
    local dst; dst=$(json "d['stocks']['$sym']['feed']")
    read -r _ answer _ updated _ < <(cast call "$src" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$MAINNET_RPC" | awk '{print $1}' | tr '\n' ' ')
    read -r _ _ _ last _ < <(cast call "$dst" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC_URL" | awk '{print $1}' | tr '\n' ' ')
    if [ "$updated" -gt "$last" ]; then
      cast send "$dst" "push(int256,uint64)" "$answer" "$updated" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" >/dev/null
      echo "$(date -u +%FT%TZ) $sym mirrored $answer @ $updated"
    fi
  done
}

settle_expired() {
  local manager count; manager=$(json "d['epochManager']")
  count=$(cast call "$manager" "vaultCount()(uint256)" --rpc-url "$RPC_URL" | awk '{print $1}')
  local now; now=$(date -u +%s)
  for ((i = 0; i < count; i++)); do
    local vault state series
    vault=$(cast call "$manager" "allVaults(uint256)(address)" "$i" --rpc-url "$RPC_URL")
    read -r state _ series < <(cast call "$manager" "epochs(address)(uint8,uint64,uint256)" "$vault" --rpc-url "$RPC_URL" | awk '{print $1}' | tr '\n' ' ')
    [ "$state" != "2" ] && continue
    local expiry underlying sym feed
    expiry=$(cast call "$manager" "getSeries(uint256)((address,address,uint256,uint64,uint16,bool,bool,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))" "$series" --rpc-url "$RPC_URL" | python3 -c "import sys; print(sys.stdin.read().strip('()').split(', ')[3].split()[0])")
    [ "$now" -lt "$expiry" ] && continue
    underlying=$(cast call "$vault" "underlying()(address)" --rpc-url "$RPC_URL")
    sym=$(json "[k for k,v in d['stocks'].items() if v['token'].lower()=='$underlying'.lower()][0]")
    feed=$(json "d['stocks']['$sym']['feed']")
    # Walk back from the latest round to the first one at or after expiry.
    local round prev at
    round=$(cast call "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$RPC_URL" | head -1 | awk '{print $1}')
    at=$(cast call "$feed" "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" "$round" --rpc-url "$RPC_URL" | sed -n 4p | awk '{print $1}')
    [ "$at" -lt "$expiry" ] && { echo "$(date -u +%FT%TZ) $sym: no print after expiry yet"; continue; }
    while true; do
      prev=$(python3 -c "print($round - 1)")
      at=$(cast call "$feed" "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" "$prev" --rpc-url "$RPC_URL" 2>/dev/null | sed -n 4p | awk '{print $1}') || break
      [ -z "$at" ] || [ "$at" -lt "$expiry" ] && break
      round=$prev
    done
    if cast send "$manager" "settle(address,uint80)" "$vault" "$round" --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" >/dev/null 2>&1; then
      echo "$(date -u +%FT%TZ) settled $vault at round $round"
    else
      # One round is not enough after a Chainlink phase change or a corporate action at expiry: the SDK finds every
      # hint (findSettlementHints), records the price with recordSettlementPriceWithHints, then settles.
      echo "$(date -u +%FT%TZ) $sym: single-round settle failed; settling through the SDK with hints"
      (cd "$ROOT" && STRIKE_CHAIN_ID="$CHAIN_ID" STRIKE_AGENT_PRIVATE_KEY="$PRIVATE_KEY" STRIKE_RPC_URL="$RPC_URL" \
        pnpm -s --filter @strike/agent-example start -- --settle --vault "$vault") || echo "settle failed for $vault"
    fi
  done
}

while true; do
  mirror_prices || echo "mirror failed"
  settle_expired || echo "settle failed"
  [ "${1:-}" = "--once" ] && break
  sleep "${INTERVAL:-60}"
done
