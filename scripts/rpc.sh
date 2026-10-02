# shellcheck shell=bash
# Sourced by scripts/keeper.sh and scripts/weekly-agent.sh: the RPC URL for cast, built like the SDK's rpcUrlFor().
#   rpc_url_for <chainId> [explicit URL]
#     ALCHEMY_API_KEY set and Alchemy serves the chain: Alchemy (the key in the path, as cast needs a URL), after one
#     eth_chainId check; if Alchemy does not answer with the right chain (bad key, network not enabled on the
#     Alchemy app, outage), the explicit URL or the public RPC instead, with a warning.
#     A loopback explicit URL (a local devnet or fork) always wins, so a rehearsal never reaches a live chain.
#   rpc_label <url>: the URL for logs, with an Alchemy key replaced by ***.
# The Node processes these scripts start (the example agent) pick Alchemy up themselves from ALCHEMY_API_KEY, with
# the key in a header; pass them the explicit or public URL as STRIKE_RPC_URL, never the Alchemy one.
# The endpoints come from strike.config.json (chains.<id>.rpc.public and .rpc.alchemy), through scripts/config.sh.

# shellcheck source=scripts/config.sh
. "$(dirname "${BASH_SOURCE[0]}")/config.sh"

# rpc_public_url <chainId>: the chain's public RPC; fails for a chain the config does not have.
rpc_public_url() {
  strike_config_get chains "$1" rpc public
}

# rpc_alchemy_base <chainId>: Alchemy's URL for the chain without the key (https://<network>.g.alchemy.com/v2).
rpc_alchemy_base() {
  strike_config_get chains "$1" rpc alchemy
}

# rpc_alchemy_network <chainId>: Alchemy's network name (robinhood-testnet); fails where Alchemy does not serve it.
rpc_alchemy_network() {
  local base
  base=$(rpc_alchemy_base "$1") || return 1
  base="${base#https://}"
  echo "${base%%.*}"
}

rpc_is_local() {
  case "$1" in
    http://localhost* | https://localhost* | http://127.* | https://127.* | http://\[::1\]* | http://0.0.0.0*) return 0 ;;
    *) return 1 ;;
  esac
}

rpc_label() {
  echo "$1" | sed -E 's#(\.alchemy\.com/v2/).*#\1***#'
}

rpc_url_for() {
  local chain="$1" explicit="${2:-}" fallback network url got
  fallback="${explicit:-$(rpc_public_url "$chain" || true)}"
  if [ -n "$explicit" ] && rpc_is_local "$explicit"; then
    echo "$explicit"
    return 0
  fi
  if [ -n "${ALCHEMY_API_KEY:-}" ] && network=$(rpc_alchemy_network "$chain"); then
    if [[ ! "$ALCHEMY_API_KEY" =~ ^[A-Za-z0-9_-]{8,128}$ ]]; then
      echo "warning: ALCHEMY_API_KEY is not a plain key; using $(rpc_label "$fallback")" >&2
    else
      url="$(rpc_alchemy_base "$chain")/$ALCHEMY_API_KEY"
      got=$(cast chain-id --rpc-url "$url" 2>/dev/null || true)
      if [ "$got" = "$chain" ]; then
        echo "$url"
        return 0
      fi
      echo "warning: Alchemy ($network) did not answer for chain $chain; using $(rpc_label "$fallback")" >&2
    fi
  fi
  [ -n "$fallback" ] || { echo "no RPC URL for chain $chain" >&2; return 1; }
  echo "$fallback"
}
