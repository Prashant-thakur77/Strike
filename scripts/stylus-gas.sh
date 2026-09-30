#!/usr/bin/env bash
# Reproduces docs/gas.md: deploys the Stylus (Rust/WASM) and Solidity pricers to a local Arbitrum Nitro dev node
# and measures the same calls on both through PricerGasProbe (call overhead included, tx overhead excluded):
# the pricer (quote, strikeForDelta) and the risk engine (greeks, impliedVol, scenarioLoss).
# Needs Docker, Foundry and cargo-stylus.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
# The reproducible (Docker) Stylus build can leave target/ owned by root: build elsewhere if it is not writable.
if [ -e "$ROOT/stylus/pricer/target/release" ] && [ ! -w "$ROOT/stylus/pricer/target/release" ]; then
  export CARGO_TARGET_DIR="${TMPDIR:-/tmp}/strike-stylus-target"
fi
RPC=http://127.0.0.1:8547
KEY=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659 # Nitro dev node's pre-funded key
IMAGE=offchainlabs/nitro-node:v3.7.1-926f1ab
NAME=strike-gas-nitro

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p 8547:8547 "$IMAGE" --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
until curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' "$RPC" | grep -q result; do sleep 1; done

DEPLOY=$(cd "$ROOT/stylus/pricer" && cargo stylus deploy --endpoint "$RPC" --private-key "$KEY" --no-verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
STY=$(echo "$DEPLOY" | grep -oE "deployed code at address: 0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}" | tail -1)
echo "Stylus $(echo "$DEPLOY" | grep -oE 'contract size: [^)]*\)' | head -1)"
echo
cd "$ROOT/contracts"
SOL=$(forge create src/pricing/BlackScholesRef.sol:BlackScholesRef --rpc-url "$RPC" --private-key "$KEY" --broadcast | grep "Deployed to" | awk '{print $3}')
PROBE=$(forge create script/gas/PricerGasProbe.sol:PricerGasProbe --rpc-url "$RPC" --private-key "$KEY" --broadcast | grep "Deployed to" | awk '{print $3}')

# Every measured call must also return identical values from both pricers.
same() {
  local a b
  a=$(cast call "$SOL" "$@" --rpc-url "$RPC" --gas-limit 30000000)
  b=$(cast call "$STY" "$@" --rpc-url "$RPC" --gas-limit 30000000)
  [ "$a" = "$b" ] || { echo "Stylus and Solidity differ on $1: $a vs $b" >&2; exit 1; }
}
q() { cast call "$PROBE" "measure(address,uint256,uint256,uint256,uint256,bool)(uint256,uint256,int256)" "$1" $2 --rpc-url "$RPC" | head -1 | awk '{print $1}'; }
k() { cast call "$PROBE" "measureStrike(address,uint256,uint256,uint256,uint256,bool)(uint256,uint256)" "$1" $2 --rpc-url "$RPC" --gas-limit 30000000 | head -1 | awk '{print $1}'; }

echo "| Call | Inputs | Solidity gas | Stylus gas |"
echo "| --- | --- | ---: | ---: |"
for args in "250000000000000000000 275000000000000000000 604800 600000000000000000 true|quote: TSLA 250, K 275 call, 7d, 60%" \
            "250000000000000000000 235000000000000000000 363600 600000000000000000 false|quote: K 235 put, 4.2d" \
            "100000000000000000000 100000000000000000000 2592000 500000000000000000 true|quote: ATM call, 30d"; do
  a="${args%%|*}"; label="${args##*|}"; same "quote(uint256,uint256,uint256,uint256,bool)(uint256,int256)" $a
  echo "| quote | ${label#quote: } | $(q "$SOL" "$a") | $(q "$STY" "$a") |"
done
for args in "250000000000000000000 200000000000000000 604800 600000000000000000 true|0.20-delta call, 7d" \
            "250000000000000000000 200000000000000000 604800 600000000000000000 false|0.20-delta put, 7d" \
            "100000000000000000000 350000000000000000 2592000 500000000000000000 true|0.35-delta call, 30d"; do
  a="${args%%|*}"; label="${args##*|}"; same "strikeForDelta(uint256,uint256,uint256,uint256,bool)(uint256)" $a
  echo "| strikeForDelta | $label | $(k "$SOL" "$a") | $(k "$STY" "$a") |"
done
g() { cast call "$PROBE" "measureGreeks(address,uint256,uint256,uint256,uint256,bool)(uint256,int256,uint256,uint256,int256)" "$1" $2 --rpc-url "$RPC" | head -1 | awk '{print $1}'; }
iv() { cast call "$PROBE" "measureImpliedVol(address,uint256,uint256,uint256,uint256,bool)(uint256,uint256)" "$1" $2 --rpc-url "$RPC" --gas-limit 30000000 | head -1 | awk '{print $1}'; }
sc() { cast call "$PROBE" "measureScenario(address,bool,uint256,uint256,uint256,int256[])(uint256,uint256)" "$1" $2 "$3" --rpc-url "$RPC" | head -1 | awk '{print $1}'; }
for args in "250000000000000000000 275000000000000000000 604800 600000000000000000 true|TSLA 250, K 275 call, 7d, 60%" \
            "250000000000000000000 235000000000000000000 363600 600000000000000000 false|K 235 put, 4.2d" \
            "100000000000000000000 100000000000000000000 2592000 500000000000000000 true|ATM call, 30d"; do
  a="${args%%|*}"; label="${args##*|}"; same "greeks(uint256,uint256,uint256,uint256,bool)(int256,uint256,uint256,int256)" $a
  echo "| greeks | $label | $(g "$SOL" "$a") | $(g "$STY" "$a") |"
done
# Implied vol of the premium the pricer quotes at 60% (50% for the ATM call): the solver recovers that sigma.
for args in "250000000000000000000 275000000000000000000 604800 600000000000000000 true|TSLA 250, K 275 call, 7d (60%)" \
            "250000000000000000000 235000000000000000000 363600 600000000000000000 false|K 235 put, 4.2d (60%)" \
            "100000000000000000000 100000000000000000000 2592000 500000000000000000 true|ATM call, 30d (50%)"; do
  read -r s k t v c <<<"${args%%|*}"; label="${args##*|}"
  p=$(cast call "$SOL" "price(uint256,uint256,uint256,uint256,bool)(uint256)" $s $k $t $v $c --rpc-url "$RPC" | awk '{print $1}')
  same "impliedVol(uint256,uint256,uint256,uint256,bool)(uint256)" $p $s $k $t $c
  echo "| impliedVol | $label | $(iv "$SOL" "$p $s $k $t $c") | $(iv "$STY" "$p $s $k $t $c") |"
done
GRID13="[$(seq -300 50 300 | awk '{printf "%s%s", (NR>1?",":""), ($1==0 ? "0" : $1 "000000000000000")}')]"
GRID61="[$(seq -300 10 300 | awk '{printf "%s%s", (NR>1?",":""), ($1==0 ? "0" : $1 "000000000000000")}')]"
SC="scenarioLoss(bool,uint256,uint256,uint256,int256[])(uint256,uint256[])"
same "$SC" true 275000000000000000000 100000000000000000000 250000000000000000000 "$GRID13"
same "$SC" false 235000000000000000000 100000000000000000000 250000000000000000000 "$GRID13"
same "$SC" true 275000000000000000000 100000000000000000000 250000000000000000000 "$GRID61"
echo "| scenarioLoss | 100 calls K 275, spot 250, 13 shocks (±30% by 5%) | $(sc "$SOL" "true 275000000000000000000 100000000000000000000 250000000000000000000" "$GRID13") | $(sc "$STY" "true 275000000000000000000 100000000000000000000 250000000000000000000" "$GRID13") |"
echo "| scenarioLoss | 100 puts K 235, spot 250, 13 shocks | $(sc "$SOL" "false 235000000000000000000 100000000000000000000 250000000000000000000" "$GRID13") | $(sc "$STY" "false 235000000000000000000 100000000000000000000 250000000000000000000" "$GRID13") |"
echo "| scenarioLoss | 100 calls K 275, 61 shocks (±30% by 1%) | $(sc "$SOL" "true 275000000000000000000 100000000000000000000 250000000000000000000" "$GRID61") | $(sc "$STY" "true 275000000000000000000 100000000000000000000 250000000000000000000" "$GRID61") |"
echo
echo "Every call returned identical values from the Stylus and Solidity pricers."
