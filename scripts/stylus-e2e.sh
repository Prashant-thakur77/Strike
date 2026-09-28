#!/usr/bin/env bash
# Strike on a Stylus-enabled chain (local Arbitrum Nitro dev node): deploy the protocol, deploy the Rust pricer,
# switch the EpochManager to it, then measure real protocol transactions (proposeByDelta, buy) priced by Stylus
# against the same calls priced by the Solidity reference.
# Needs Docker, Foundry, cargo-stylus and Python 3. Must run during NYSE hours (the dev node cannot warp time).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
RPC=http://127.0.0.1:8547
KEY=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659 # Nitro dev node's pre-funded key
ME=$(cast wallet address --private-key $KEY)
NAME=strike-nitro-dev
IMAGE=offchainlabs/nitro-node:v3.7.1-926f1ab

if ! curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' $RPC | grep -q result; then
  docker rm -f $NAME >/dev/null 2>&1 || true
  docker run -d --name $NAME -p 8547:8547 $IMAGE --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug >/dev/null
  until curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' $RPC | grep -q result; do sleep 1; done
fi
CHAIN=$(cast chain-id --rpc-url $RPC)
send() { cast send "$@" --rpc-url $RPC --private-key $KEY --json | python3 -c "import json,sys; r=json.load(sys.stdin); print(int(r['gasUsed'],16))"; }
j() { python3 -c "import json,sys; d=json.load(open('$ROOT/contracts/deployments/$CHAIN.json')); print(eval(sys.argv[1]))" "$1"; }
jv() { python3 -c "import json,sys; d=json.load(open('$ROOT/contracts/deployments/$CHAIN-vaults.json')); print(eval(sys.argv[1]))" "$1"; }

cd "$ROOT/contracts"
PRIVATE_KEY=$KEY forge script script/Deploy.s.sol --rpc-url $RPC --broadcast >/dev/null
STY=$(cd "$ROOT/stylus/pricer" && cargo stylus deploy --endpoint $RPC --private-key $KEY --no-verify 2>&1 | grep -oE "activated contract 0x[0-9a-fA-F]{40}" | awk '{print $3}')
MANAGER=$(j "d['epochManager']"); SOL=$(j "d['pricer']"); TSLA=$(j "d['stocks']['TSLA']['token']"); FEED=$(j "d['stocks']['TSLA']['feed']")
USDG=$(j "d['usdg']"); CAL=$(j "d['marketCalendar']")
echo "chain $CHAIN · EpochManager $MANAGER · Solidity pricer $SOL · Stylus pricer $STY"

NOW=$(cast block latest --rpc-url $RPC -f timestamp)
[ "$(cast call $CAL 'isMarketOpen(uint256)(bool)' $NOW --rpc-url $RPC)" = "true" ] || { echo "NYSE is closed; run during regular hours"; exit 1; }
EXPIRY=$(cast call $CAL 'weeklyExpiry(uint256)(uint256)' $((NOW + 86400)) --rpc-url $RPC | awk '{print $1}')
send $FEED 'push(int256,uint64)' 36900000000 $((NOW - 5)) >/dev/null
send $TSLA 'mint(address,uint256)' $ME 400000000000000000000 >/dev/null

# Each pricer gets its own covered-call vault (a selling vault cannot be aborted before expiry).
new_vault() {
  PRIVATE_KEY=$KEY forge script script/Seed.s.sol --rpc-url $RPC --broadcast >/dev/null
  local v; v=$(jv "d['TSLA_covered_call']")
  send $TSLA 'approve(address,uint256)' $v 200000000000000000000 >/dev/null
  send $v 'deposit(uint256,address)' 200000000000000000000 $ME >/dev/null
  echo $v
}
VAULT_SOL=$(new_vault)
VAULT_STY=$(new_vault)
send $USDG 'approve(address,uint256)' $MANAGER 1000000000000 >/dev/null

run_epoch() { # $1 = pricer, $2 = vault; prints: proposeByDelta gas, buy gas, strike
  send $MANAGER 'setPricer(address)' $1 >/dev/null
  send $MANAGER 'openEpoch(address)' $2 >/dev/null
  local g1; g1=$(send $MANAGER 'proposeByDelta(address,uint16,uint64,uint256,uint16)' $2 2000 $EXPIRY 100000000000000000000 10000)
  local sid; sid=$(cast call $MANAGER 'epochs(address)(uint8,uint64,uint256)' $2 --rpc-url $RPC | sed -n 3p | awk '{print $1}')
  local g2; g2=$(send $MANAGER 'buy(uint256,uint256,uint256,address)' $sid 5000000000000000000 1000000000000 $ME)
  local strike; strike=$(cast call $MANAGER 'getSeries(uint256)((address,address,uint256,uint64,uint16,bool,bool,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))' $sid --rpc-url $RPC | python3 -c "import sys; print(sys.stdin.read().strip('()').split(', ')[8].split()[0])")
  echo "$g1 $g2 $strike"
}
read -r S_PROP S_BUY S_STRIKE < <(run_epoch $SOL $VAULT_SOL)
read -r T_PROP T_BUY T_STRIKE < <(run_epoch $STY $VAULT_STY)
echo
echo "| Transaction (EpochManager) | Solidity pricer | Stylus pricer |"
echo "| --- | ---: | ---: |"
echo "| proposeByDelta (0.20 delta, solves the strike on-chain) | $S_PROP | $T_PROP |"
echo "| buy 5 options (live Black-Scholes quote) | $S_BUY | $T_BUY |"
echo "| strike chosen (WAD) | $S_STRIKE | $T_STRIKE |"
[ "$S_STRIKE" = "$T_STRIKE" ] && echo "Both pricers chose the same strike." || { echo "Strikes differ"; exit 1; }
