#!/usr/bin/env bash
# One-command local demo of Strike on anvil:
#   deploy + seed → deposit TSLA (and USDG) → the example agent proposes a 0.20-delta covered call (accepted)
#   → the agent forces a reckless at-the-money put (rejected on-chain, bond slashed) → a buyer agent (a second
#   account) buys calls within a 10 USDG budget → time jumps past Friday's close → the keeper publishes the
#   settlement price → the agent settles → the buyer agent redeems → balances.
#
#   scripts/demo-local.sh                 # settle out of the money at $380 (depositors keep the premium)
#   SETTLE_PRICE=400 scripts/demo-local.sh  # settle in the money (buyers get paid in TSLA)
#
# Needs Foundry (anvil, forge, cast), Node 22 and `pnpm install`. Uses port 8550 (DEMO_PORT to change it).
# The anvil it starts is always stopped at exit, by PID.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"

PORT="${DEMO_PORT:-8550}"
RPC="http://127.0.0.1:$PORT"
START_TS=1791212400 # Mon 2026-10-05 15:00 UTC: NYSE open
EXPIRY=1791576000   # Fri 2026-10-09 20:00 UTC = 16:00 New York, the week's expiry
SETTLE_PRICE="${SETTLE_PRICE:-380}"
PIDFILE="${TMPDIR:-/tmp}/strike-demo-anvil-$PORT.pid"

# Anvil's well-known dev accounts. #0 deploys, curates the vaults, deposits and is the agent's signer; #1 buys.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
BUYER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
BUYER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

bold() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

for cmd in anvil forge cast node pnpm; do
  command -v "$cmd" >/dev/null || die "$cmd not found (install Foundry, Node 22 and pnpm)"
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node 22+ required (nvm use 22)"
[[ -d "$ROOT/contracts/lib/forge-std/src" ]] || die "run: git submodule update --init --recursive"
[[ -d "$ROOT/node_modules" ]] || die "run: pnpm install"

# ---------------------------------------------------------------- anvil (ours only, by PID)

ANVIL_PID=""
stop_anvil() {
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
}
trap stop_anvil EXIT
trap 'exit 130' INT TERM

# A previous run that was killed hard may have left its anvil behind: stop it only if the PID we recorded is
# still an anvil process.
if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE")"
  if [[ "$old" =~ ^[0-9]+$ ]] && [[ "$(cat "/proc/$old/comm" 2>/dev/null || ps -p "$old" -o comm= 2>/dev/null)" == anvil* ]]; then
    note "stopping the demo anvil left over from a previous run (pid $old)"
    kill "$old" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PIDFILE"
fi
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  die "something is already listening on $RPC; stop it or set DEMO_PORT"
fi

bold "Start anvil at Mon 2026-10-05 15:00 UTC (NYSE open) on $RPC"
anvil --port "$PORT" --timestamp "$START_TS" --silent &
ANVIL_PID=$!
echo "$ANVIL_PID" >"$PIDFILE"
for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || die "anvil did not start"
note "anvil pid $ANVIL_PID"

# ---------------------------------------------------------------- deploy

bold "Deploy Strike and seed the demo agent and vaults (forge compiles first if needed)"
(
  cd "$ROOT/contracts"
  PRIVATE_KEY=$DEPLOYER_KEY forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --silent
  PRIVATE_KEY=$DEPLOYER_KEY forge script script/Seed.s.sol --rpc-url "$RPC" --broadcast --silent
)
node "$ROOT/scripts/export-abis.mjs"

json() { node -p "require('$ROOT/contracts/deployments/$1')$2"; }
USDG=$(json 31337.json .usdg)
EM=$(json 31337.json .epochManager)
FEES=$(json 31337.json .feeManager)
TSLA=$(json 31337.json .stocks.TSLA.token)
FEED=$(json 31337.json .stocks.TSLA.feed)
CALL_VAULT=$(json 31337-vaults.json .TSLA_covered_call)
PUT_VAULT=$(json 31337-vaults.json .TSLA_cash_secured_put)
note "EpochManager $EM"
note "TSLA covered-call vault (sTSLA-CC) $CALL_VAULT"
note "TSLA cash-secured-put vault (sTSLA-CSP) $PUT_VAULT"

send() { cast send --rpc-url "$RPC" "$@" >/dev/null; }
call() { cast call --rpc-url "$RPC" "$@" | awk '{print $1}'; }
usdg() { cast format-units "$1" 6; }
tokens() { cast format-units "$1" 18; }

# ---------------------------------------------------------------- deposits

bold "Depositor (account #0) deposits 10 TSLA into the covered-call vault and 50,000 USDG into the put vault"
send --private-key $DEPLOYER_KEY "$TSLA" "mint(address,uint256)" $DEPLOYER "$(cast to-wei 10)"
send --private-key $DEPLOYER_KEY "$TSLA" "approve(address,uint256)" "$CALL_VAULT" "$(cast to-wei 10)"
send --private-key $DEPLOYER_KEY "$CALL_VAULT" "deposit(uint256,address)" "$(cast to-wei 10)" $DEPLOYER
send --private-key $DEPLOYER_KEY "$USDG" "approve(address,uint256)" "$PUT_VAULT" 50000000000
send --private-key $DEPLOYER_KEY "$PUT_VAULT" "deposit(uint256,address)" 50000000000 $DEPLOYER
note "call vault totalAssets: $(tokens "$(call "$CALL_VAULT" "totalAssets()(uint256)")") TSLA"
note "put vault totalAssets:  $(usdg "$(call "$PUT_VAULT" "totalAssets()(uint256)")") USDG"

# ---------------------------------------------------------------- the agent

export STRIKE_CHAIN_ID=31337 STRIKE_RPC_URL="$RPC" STRIKE_AGENT_PRIVATE_KEY=$DEPLOYER_KEY
agent() { (cd "$ROOT" && pnpm --silent --filter @strike/agent-example start "$@"); }

bold "Agent: propose this week's covered call at 0.20 delta (through the Strike MCP server)"
agent --vault sTSLA-CC

bold "Agent (reckless): force an at-the-money put on the put vault"
agent --reckless --vault sTSLA-CSP

# ---------------------------------------------------------------- a buyer agent

# The same example agent in buyer mode, signing with account #1: it starts its own MCP server with that key.
buyer_agent() { (cd "$ROOT" && STRIKE_AGENT_PRIVATE_KEY=$BUYER_KEY pnpm --silent --filter @strike/agent-example start "$@"); }
OPTION_TOKEN=$(json 31337.json .optionToken)

bold "Buyer agent (account #1): find the live series and buy calls within a 10 USDG budget"
send --private-key $BUYER_KEY "$USDG" "faucet(uint256)" 10000000000
note "account #1 took 10,000 USDG from the testnet faucet"
BUYER_USDG_BEFORE=$(call "$USDG" "balanceOf(address)(uint256)" $BUYER)
buyer_agent --buy --budget 10
SERIES=$(cast call --rpc-url "$RPC" "$EM" "epochs(address)(uint8,uint64,uint256)" "$CALL_VAULT" | sed -n 3p | awk '{print $1}')
PREMIUM=$((BUYER_USDG_BEFORE - $(call "$USDG" "balanceOf(address)(uint256)" $BUYER)))
OPTIONS=$(call "$OPTION_TOKEN" "balanceOf(address,uint256)(uint256)" $BUYER "$SERIES")

# ---------------------------------------------------------------- expiry and settlement

bold "Time passes: jump past Fri 2026-10-09 16:00 New York; the keeper publishes TSLA at \$$SETTLE_PRICE"
cast rpc --rpc-url "$RPC" evm_setNextBlockTimestamp $((EXPIRY + 60)) >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
send --private-key $DEPLOYER_KEY "$FEED" "push(int256,uint64)" $((SETTLE_PRICE * 100000000)) $((EXPIRY + 30))
note "MirrorFeed round $(call "$FEED" "latestRound()(uint80)") at $((EXPIRY + 30)) (30 s after expiry)"

bold "Agent: settle the expired series (settlement round found automatically)"
agent --settle --vault sTSLA-CC

bold "Curator aborts the put vault's epoch (no valid proposal), paying the slashed bond to its depositors"
send --private-key $DEPLOYER_KEY "$EM" "abortEpoch(address)" "$PUT_VAULT"

bold "Buyer agent: redeem the settled calls (redeem_options finds the series from the vault)"
BUYER_TSLA_BEFORE=$(call "$TSLA" "balanceOf(address)(uint256)" $BUYER)
buyer_agent --redeem --vault sTSLA-CC
BUYER_TSLA_AFTER=$(call "$TSLA" "balanceOf(address)(uint256)" $BUYER)

bold "Depositor collects the premium"
CALL_PREMIUM=$(call "$CALL_VAULT" "pendingPremium(address)(uint256)" $DEPLOYER)
PUT_PREMIUM=$(call "$PUT_VAULT" "pendingPremium(address)(uint256)" $DEPLOYER)
send --private-key $DEPLOYER_KEY "$CALL_VAULT" "claimPremium()"
send --private-key $DEPLOYER_KEY "$PUT_VAULT" "claimPremium()"

bold "Balances"
note "Buyer:     paid $(usdg "$PREMIUM") USDG for $(tokens "$OPTIONS") options; redeemed for $(tokens $((BUYER_TSLA_AFTER - BUYER_TSLA_BEFORE))) TSLA (settled at \$$SETTLE_PRICE)"
note "Depositor: claimed $(usdg "$CALL_PREMIUM") USDG premium from sTSLA-CC and $(usdg "$PUT_PREMIUM") USDG (the slashed bond) from sTSLA-CSP"
note "           sTSLA-CC now holds $(tokens "$(call "$CALL_VAULT" "totalAssets()(uint256)")") TSLA; vault locked: $(call "$CALL_VAULT" "locked()(bool)")"
note "Fees:      $(usdg "$(call "$FEES" "claimable(address)(uint256)" $DEPLOYER)") USDG performance fee claimable (agent share and treasury share: the same demo address)"

bold "Agent: status and on-chain track record"
agent --status --vault sTSLA-CC

bold "Done. Stopping anvil (pid $ANVIL_PID)."
