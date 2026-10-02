#!/usr/bin/env bash
# The CI keeper key's roles on one chain: exactly what scripts/keeper.sh needs, and nothing else.
#   MirrorFeed.push needs KEEPER_ROLE on the feed (contracts/src/testnet/MirrorFeed.sol). The keeper pushes only the
#   feeds whose symbol has a mainnet Chainlink feed (strike.config.json chains.<mainnetFeedsChain>.stocks), so those
#   are the feeds that get the role; NFLX on 46630 has no mainnet feed and is left out.
#   EpochManager.settle and StockOracle.recordSettlementPrice(WithHints) are permissionless: no role.
#   EpochManager's own KEEPER_ROLE (setSigma, openEpoch) is not granted: keeper.sh calls neither.
# The feeds are those of every active deployment file of the chain (the keeper's rule, scripts/config.sh); v2 and v3
# on 46630 share their MirrorFeeds, so one grant serves both.
#
# Usage: CHAIN_ID=46630 scripts/keeper-role.sh check|grant|revoke <keeper address> [--dry-run]
#   check   read only: the address's roles on every feed and on each EpochManager, its balance, and that an admin
#           setter called from it reverts
#   grant   grantRole(KEEPER_ROLE, address) on each feed that lacks it, from PRIVATE_KEY (the feeds' admin)
#   revoke  revokeRole(KEEPER_ROLE, address) on each feed that has it (rotating or retiring a keeper key)
#   --dry-run  print the transactions instead of sending them (no key needed)
# RPC_URL defaults to the chain's public RPC (strike.config.json); ALCHEMY_API_KEY works as in keeper.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/rpc.sh
. "$ROOT/scripts/rpc.sh"
CHAIN_ID="${CHAIN_ID:?CHAIN_ID is required}"
MODE="${1:-}"
ADDR="${2:-}"
DRY_RUN=0
[ "${3:-}" = "--dry-run" ] && DRY_RUN=1
case "$MODE" in check | grant | revoke) ;; *) echo "usage: CHAIN_ID=<id> scripts/keeper-role.sh check|grant|revoke <address> [--dry-run]" >&2; exit 2 ;; esac
[[ "$ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "not an address: '$ADDR'" >&2; exit 2; }
if [ "$MODE" != check ] && [ "$DRY_RUN" = 0 ]; then
  : "${PRIVATE_KEY:?PRIVATE_KEY is required (the deployer: DEFAULT_ADMIN_ROLE on the MirrorFeeds)}"
fi
RPC=$(rpc_url_for "$CHAIN_ID" "${RPC_URL:-$(rpc_public_url "$CHAIN_ID")}")
EXPLORER=$(strike_config_get chains "$CHAIN_ID" explorer)
FEEDS_CHAIN=$(strike_config_get chains "$CHAIN_ID" mainnetFeedsChain)
KEEPER_ROLE=$(cast keccak "KEEPER_ROLE")
ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
GUARDIAN_ROLE=$(cast keccak "GUARDIAN_ROLE")
DEPLOYS=$(strike_deployment_files "$CHAIN_ID")
echo "Chain $CHAIN_ID via $(rpc_label "$RPC"); keeper $ADDR; deployments: $(for d in $DEPLOYS; do basename "$d"; done | tr '\n' ' ')"

has() { cast call "$1" "hasRole(bytes32,address)(bool)" "$2" "$3" --rpc-url "$RPC"; }

# The mirrored feeds: symbol and address, one per line, each feed once.
feeds() {
  local deploy sym feed seen=" "
  for deploy in $DEPLOYS; do
    for sym in $(jq -r '.stocks | keys[]' "$deploy"); do
      strike_config_get chains "$FEEDS_CHAIN" stocks "$sym" feed >/dev/null 2>&1 || continue
      feed=$(jq -r --arg s "$sym" '.stocks[$s].feed' "$deploy")
      case "$seen" in *" ${feed,,} "*) continue ;; esac
      seen="$seen${feed,,} "
      echo "$sym $feed"
    done
  done
}

while read -r sym feed; do
  keeper=$(has "$feed" "$KEEPER_ROLE" "$ADDR")
  admin=$(has "$feed" "$ADMIN_ROLE" "$ADDR")
  echo "MirrorFeed $sym $feed: KEEPER_ROLE $keeper, DEFAULT_ADMIN_ROLE $admin"
  [ "$admin" = false ] || echo "  warning: the keeper key is an admin of this feed" >&2
  if { [ "$MODE" = grant ] && [ "$keeper" = false ]; } || { [ "$MODE" = revoke ] && [ "$keeper" = true ]; }; then
    fn="${MODE}Role(bytes32,address)"
    if [ "$DRY_RUN" = 1 ]; then
      echo "  dry run: would send $feed $fn KEEPER_ROLE $ADDR"
    else
      tx=$(cast send "$feed" "$fn" "$KEEPER_ROLE" "$ADDR" --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --json | jq -r .transactionHash)
      echo "  $MODE: $EXPLORER/tx/$tx (now KEEPER_ROLE $(has "$feed" "$KEEPER_ROLE" "$ADDR"))"
    fi
  fi
done < <(feeds)

if [ "$MODE" = check ]; then
  for deploy in $DEPLOYS; do
    manager=$(jq -r .epochManager "$deploy")
    echo "EpochManager $(basename "$deploy") $manager: KEEPER_ROLE $(has "$manager" "$KEEPER_ROLE" "$ADDR"), GUARDIAN_ROLE $(has "$manager" "$GUARDIAN_ROLE" "$ADDR"), DEFAULT_ADMIN_ROLE $(has "$manager" "$ADMIN_ROLE" "$ADDR")"
    # An admin setter called from the keeper's address must revert (setSpotBuffer is DEFAULT_ADMIN_ROLE only).
    token=$(jq -r '.stocks.TSLA.token' "$deploy")
    if cast call "$manager" "setSpotBuffer(address,uint16)" "$token" 0 --from "$ADDR" --rpc-url "$RPC" >/dev/null 2>&1; then
      echo "  warning: setSpotBuffer from $ADDR did not revert" >&2
    else
      echo "  setSpotBuffer from the keeper reverts (not an admin)"
    fi
  done
  echo "Balance: $(cast balance "$ADDR" --ether --rpc-url "$RPC") ETH"
fi
