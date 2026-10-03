#!/usr/bin/env bash
# Strike testnet keeper.
#  1. Mirrors Robinhood Chain mainnet Chainlink stock prices into the testnet MirrorFeeds (Robinhood testnet has no
#     Chainlink stock feeds). Only newer rounds are pushed, with their original timestamps.
#  2. Settles expired epochs (settle is permissionless; the first round at or after expiry is found automatically).
#
# Both steps cover every deployment file strike.config.json lists for the chain (chains.<id>.deployments, the primary
# first: 46630.json, then 46630-v3.json, v3 next to v2), skipping files whose `status` starts with "superseded". A
# MirrorFeed shared by two deployments is pushed once. The mainnet feeds are those of the chain's mainnetFeedsChain
# (chains.4663.stocks), and every RPC default is the config's public RPC (docs/configuration.md).
#
# Usage: CHAIN_ID=46630 RPC_URL=https://rpc.testnet.chain.robinhood.com PRIVATE_KEY=0x... scripts/keeper.sh [--once] [--dry-run]
#   --dry-run  read only: print what would be pushed or settled and send nothing (PRIVATE_KEY not needed).
# RPC_URL and MAINNET_RPC default to the public RPCs. With ALCHEMY_API_KEY set, cast reads and sends through Alchemy
# instead (scripts/rpc.sh: checked once, the public RPC if Alchemy does not answer); a loopback RPC_URL (a fork) is
# always used as given.
# Needs Foundry (cast), python3, and jq or node (scripts/config.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/rpc.sh
. "$ROOT/scripts/rpc.sh"
CHAIN_ID="${CHAIN_ID:-$(strike_config_get defaultChainId)}"
RPC_URL="${RPC_URL:-$(rpc_public_url "$CHAIN_ID" || rpc_public_url "$(strike_config_get defaultChainId)")}"
# The chain whose Chainlink rounds the MirrorFeeds copy (Robinhood Chain mainnet, 4663) and its public RPC.
FEEDS_CHAIN="$(strike_config_get chains "$CHAIN_ID" mainnetFeedsChain || true)"
MAINNET_RPC="${MAINNET_RPC:-$( [ -z "$FEEDS_CHAIN" ] || rpc_public_url "$FEEDS_CHAIN")}"
ONCE=0
DRY_RUN="${DRY_RUN:-0}"
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[ "$DRY_RUN" = "1" ] || : "${PRIVATE_KEY:?PRIVATE_KEY is required (keeper role on the MirrorFeeds)}"

# The active deployment files for this chain, the primary first (the SDK's default deployment of the chain).
DEPLOYS=$(strike_deployment_files "$CHAIN_ID")
[ -n "$DEPLOYS" ] || { echo "no deployment file for chain $CHAIN_ID" >&2; exit 1; }
PRIMARY=$(echo "$DEPLOYS" | head -n 1)

# What cast uses: Alchemy when ALCHEMY_API_KEY is set (the key is in these URLs: print them only through rpc_label).
# The SDK settle path below still gets RPC_URL as STRIKE_RPC_URL and adds Alchemy itself, with the key in a header.
CAST_RPC=$(rpc_url_for "$CHAIN_ID" "$RPC_URL")
CAST_MAINNET_RPC=""
[ -z "$FEEDS_CHAIN" ] || CAST_MAINNET_RPC=$(rpc_url_for "$FEEDS_CHAIN" "$MAINNET_RPC")
echo "RPC: $(rpc_label "$CAST_RPC"); mainnet feeds: $(rpc_label "${CAST_MAINNET_RPC:-none}")"

# The mainnet Chainlink feeds by symbol (docs.chain.link, see docs/research.md): strike.config.json
# chains.<mainnetFeedsChain>.stocks. NFLX has none. A chain without a mainnetFeedsChain mirrors nothing.
declare -A MAINNET_FEED=()
if [ -n "$FEEDS_CHAIN" ]; then
  for sym in $(strike_config_keys chains "$FEEDS_CHAIN" stocks || true); do
    MAINNET_FEED[$sym]=$(strike_config_get chains "$FEEDS_CHAIN" stocks "$sym" feed)
  done
fi

# json <file> <python expression over d>
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))" "$1" "$2"; }

# send <description> <cast send args...>: sends, or only prints in a dry run.
send() {
  local what="$1"; shift
  if [ "$DRY_RUN" = "1" ]; then
    echo "$(date -u +%FT%TZ) dry run: would $what"
    return 0
  fi
  cast send "$@" --rpc-url "$CAST_RPC" --private-key "$PRIVATE_KEY" >/dev/null
}

mirror_prices() {
  local deploy sym seen=" "
  for deploy in $DEPLOYS; do
  for sym in $(json "$deploy" "' '.join(d['stocks'].keys())"); do
    local src="${MAINNET_FEED[$sym]:-}"
    [ -z "$src" ] && continue
    local dst; dst=$(json "$deploy" "d['stocks']['$sym']['feed'].lower()")
    case "$seen" in *" $dst "*) continue ;; esac
    seen="$seen$dst "
    read -r _ answer _ updated _ < <(cast call "$src" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$CAST_MAINNET_RPC" 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
    read -r _ _ _ last _ < <(cast call "$dst" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$CAST_RPC" 2>/dev/null | awk '{print $1}' | tr '\n' ' ')
    # A failed read (the mainnet RPC rate-limits with a Cloudflare 403 under load) skips the symbol with a message.
    if [ -z "${updated:-}" ] || [ -z "${last:-}" ]; then
      echo "$(date -u +%FT%TZ) $sym: feed read failed (mainnet: '${updated:-}', testnet: '${last:-}'); skipped" >&2
      continue
    fi
    if [ "$updated" -gt "$last" ]; then
      # Explicit branches: `set -e` is off inside `mirror_prices || ...`, so a failed send would otherwise be logged
      # as mirrored. One feed's failure (no KEEPER_ROLE, feed paused) does not stop the others.
      if send "push $sym $answer @ $updated to $dst" "$dst" "push(int256,uint64)" "$answer" "$updated"; then
        [ "$DRY_RUN" = "1" ] || echo "$(date -u +%FT%TZ) $sym mirrored $answer @ $updated"
      else
        echo "$(date -u +%FT%TZ) $sym: push failed (is the key the feed's KEEPER_ROLE?)" >&2
      fi
    fi
  done
  done
}

# settle_gas <manager> <vault> <round>: the gas limit for settle(): the estimate plus half again. eth_estimateGas stops
# at the lowest gas at which the call does not revert, and settle() posts the agent's ERC-8004 feedback inside a
# try/catch, so a bare estimate can leave that inner call short: it then runs out of gas, is caught, and the
# settlement succeeds with `ReputationFeedback(..., posted = false)` (seen on the 2026-10-01 fork rehearsal, v2).
settle_gas() {
  local est; est=$(cast estimate "$1" "settle(address,uint80)" "$2" "$3" --rpc-url "$CAST_RPC" 2>/dev/null) || return 1
  echo $((est * 3 / 2))
}

# settle_expired <deployment file>
settle_expired() {
  local deploy="$1" manager count; manager=$(json "$deploy" "d['epochManager']")
  count=$(cast call "$manager" "vaultCount()(uint256)" --rpc-url "$CAST_RPC" | awk '{print $1}')
  # The chain's clock, not the machine's: settle() checks block.timestamp, and a fork or devnet may be warped.
  local now; now=$(cast block latest -f timestamp --rpc-url "$CAST_RPC")
  for ((i = 0; i < count; i++)); do
    local vault state series gas
    vault=$(cast call "$manager" "allVaults(uint256)(address)" "$i" --rpc-url "$CAST_RPC")
    read -r state _ series < <(cast call "$manager" "epochs(address)(uint8,uint64,uint256)" "$vault" --rpc-url "$CAST_RPC" | awk '{print $1}' | tr '\n' ' ')
    [ "$state" != "2" ] && continue
    local expiry underlying sym feed
    expiry=$(cast call "$manager" "getSeries(uint256)((address,address,uint256,uint64,uint16,bool,bool,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))" "$series" --rpc-url "$CAST_RPC" | python3 -c "import sys; print(sys.stdin.read().strip('()').split(', ')[3].split()[0])")
    if [ "$now" -lt "$expiry" ]; then
      [ "$DRY_RUN" = "1" ] && echo "$(date -u +%FT%TZ) dry run: $vault ($(basename "$deploy")) selling, expires $(date -u -d "@$expiry" +%FT%TZ)"
      continue
    fi
    underlying=$(cast call "$vault" "underlying()(address)" --rpc-url "$CAST_RPC")
    sym=$(json "$deploy" "[k for k,v in d['stocks'].items() if v['token'].lower()=='$underlying'.lower()][0]")
    feed=$(json "$deploy" "d['stocks']['$sym']['feed']")
    # Walk back from the latest round to the first one at or after expiry.
    local round prev at
    round=$(cast call "$feed" "latestRoundData()(uint80,int256,uint256,uint256,uint80)" --rpc-url "$CAST_RPC" | head -1 | awk '{print $1}')
    at=$(cast call "$feed" "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" "$round" --rpc-url "$CAST_RPC" | sed -n 4p | awk '{print $1}')
    [ "$at" -lt "$expiry" ] && { echo "$(date -u +%FT%TZ) $sym: no print after expiry yet"; continue; }
    while true; do
      prev=$(python3 -c "print($round - 1)")
      at=$(cast call "$feed" "getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)" "$prev" --rpc-url "$CAST_RPC" 2>/dev/null | sed -n 4p | awk '{print $1}') || break
      [ -z "$at" ] || [ "$at" -lt "$expiry" ] && break
      round=$prev
    done
    if [ "$DRY_RUN" = "1" ]; then
      send "settle $vault ($(basename "$deploy")) at round $round" "$manager"
    elif gas=$(settle_gas "$manager" "$vault" "$round") &&
      cast send "$manager" "settle(address,uint80)" "$vault" "$round" --gas-limit "$gas" --rpc-url "$CAST_RPC" --private-key "$PRIVATE_KEY" >/dev/null 2>&1; then
      echo "$(date -u +%FT%TZ) settled $vault at round $round"
    else
      # One round is not enough after a Chainlink phase change or a corporate action at expiry: the SDK finds every
      # hint (findSettlementHints), records the price with recordSettlementPriceWithHints, then settles. For a
      # deployment other than the primary (the SDK's entry), its addresses go in as the SDK's STRIKE_* overrides.
      echo "$(date -u +%FT%TZ) $sym: single-round settle failed; settling through the SDK with hints"
      if (cd "$ROOT" && export STRIKE_CHAIN_ID="$CHAIN_ID" STRIKE_AGENT_PRIVATE_KEY="$PRIVATE_KEY" STRIKE_RPC_URL="$RPC_URL" &&
        if [ "$deploy" != "$PRIMARY" ]; then eval "$(sdk_overrides "$deploy")"; fi &&
        pnpm -s --filter @strike/agent-example start -- --settle --vault "$vault"); then
        echo "$(date -u +%FT%TZ) settled $vault through the SDK with hints"
      else
        echo "settle failed for $vault"
      fi
    fi
  done
}

# export lines for the SDK's address overrides (sdk/src/deployments.ts DEPLOYMENT_ENV) from a deployment file.
sdk_overrides() {
  python3 - "$1" <<'PY'
import json, shlex, sys
d = json.load(open(sys.argv[1]))
env = {"epochManager": "STRIKE_EPOCH_MANAGER", "agentRegistry": "STRIKE_AGENT_REGISTRY",
       "vaultFactory": "STRIKE_VAULT_FACTORY", "stockOracle": "STRIKE_STOCK_ORACLE",
       "optionToken": "STRIKE_OPTION_TOKEN", "feeManager": "STRIKE_FEE_MANAGER",
       "marketCalendar": "STRIKE_MARKET_CALENDAR", "usdg": "STRIKE_USDG", "pricer": "STRIKE_PRICER",
       "vaultImplementation": "STRIKE_VAULT_IMPLEMENTATION", "decisionLog": "STRIKE_DECISION_LOG",
       "riskLens": "STRIKE_RISK_LENS"}
for key, name in env.items():
    v = d.get(key)
    if isinstance(v, str) and v.startswith("0x") and len(v) == 42:
        print(f"export {name}={shlex.quote(v)}")
if isinstance(d.get("block"), int):
    print(f"export STRIKE_DEPLOY_BLOCK={d['block']}")
PY
}

while true; do
  mirror_prices || echo "mirror failed"
  for deploy in $DEPLOYS; do
    settle_expired "$deploy" || echo "settle failed ($(basename "$deploy"))"
  done
  [ "$ONCE" = "1" ] && break
  sleep "${INTERVAL:-60}"
done
