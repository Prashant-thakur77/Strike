#!/usr/bin/env bash
# Reproduces docs/gas.md: deploys the Stylus (Rust/WASM) and Solidity pricers to a local Arbitrum Nitro dev node
# and measures the same calls on both through PricerGasProbe (call overhead included, tx overhead excluded).
# Needs Docker, Foundry and cargo-stylus.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC=http://127.0.0.1:8547
KEY=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659 # Nitro dev node's pre-funded key
IMAGE=offchainlabs/nitro-node:v3.7.1-926f1ab
NAME=strike-gas-nitro

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 8547:8547 "$IMAGE" --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
until curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' "$RPC" | grep -q result; do sleep 1; done

STY=$(cd "$ROOT/stylus/pricer" && cargo stylus deploy --endpoint "$RPC" --private-key "$KEY" --no-verify 2>&1 | grep -oE "activated contract 0x[0-9a-fA-F]{40}" | awk '{print $3}')
cd "$ROOT/contracts"
SOL=$(forge create src/pricing/BlackScholesRef.sol:BlackScholesRef --rpc-url "$RPC" --private-key "$KEY" --broadcast | grep "Deployed to" | awk '{print $3}')
PROBE=$(forge create script/gas/PricerGasProbe.sol:PricerGasProbe --rpc-url "$RPC" --private-key "$KEY" --broadcast | grep "Deployed to" | awk '{print $3}')

q() { cast call "$PROBE" "measure(address,uint256,uint256,uint256,uint256,bool)(uint256,uint256,int256)" "$1" $2 --rpc-url "$RPC" | head -1 | awk '{print $1}'; }
k() { cast call "$PROBE" "measureStrike(address,uint256,uint256,uint256,uint256,bool)(uint256,uint256)" "$1" $2 --rpc-url "$RPC" --gas-limit 30000000 | head -1 | awk '{print $1}'; }

echo "| Call | Inputs | Solidity gas | Stylus gas |"
echo "| --- | --- | ---: | ---: |"
for args in "250000000000000000000 275000000000000000000 604800 600000000000000000 true|quote: TSLA 250, K 275 call, 7d, 60%" \
            "250000000000000000000 235000000000000000000 363600 600000000000000000 false|quote: K 235 put, 4.2d" \
            "100000000000000000000 100000000000000000000 2592000 500000000000000000 true|quote: ATM call, 30d"; do
  a="${args%%|*}"; label="${args##*|}"; echo "| quote | ${label#quote: } | $(q "$SOL" "$a") | $(q "$STY" "$a") |"
done
for args in "250000000000000000000 200000000000000000 604800 600000000000000000 true|0.20-delta call, 7d" \
            "250000000000000000000 200000000000000000 604800 600000000000000000 false|0.20-delta put, 7d" \
            "100000000000000000000 350000000000000000 2592000 500000000000000000 true|0.35-delta call, 30d"; do
  a="${args%%|*}"; label="${args##*|}"; echo "| strikeForDelta | $label | $(k "$SOL" "$a") | $(k "$STY" "$a") |"
done
