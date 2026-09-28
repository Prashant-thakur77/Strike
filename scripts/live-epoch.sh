#!/usr/bin/env bash
# Runs one real epoch on Robinhood Chain testnet through the example agent and the Strike MCP server, during NYSE
# hours: fresh prices, a 0.20-delta covered call proposed by delta (accepted), a reckless at-the-money put
# (rejected on-chain, bond slashed), and a buyer agent buying options. Logs every step to docs/testnet-epochs/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$HOME/.foundry/bin:$PATH"
set -a; source "$ROOT/contracts/.env"; set +a
export STRIKE_CHAIN_ID=46630 STRIKE_AGENT_PRIVATE_KEY=$PRIVATE_KEY
RPC=https://rpc.testnet.chain.robinhood.com
OUT="$ROOT/docs/testnet-epochs/$(date -u +%F).md"
mkdir -p "$(dirname "$OUT")"
agent() { (cd "$ROOT" && pnpm -s --filter @strike/agent-example start -- "$@" 2>&1); }
{
  echo "# Live epoch on Robinhood Chain testnet, $(date -u +'%F %H:%M UTC')"
  echo; echo '```'
  echo "== keeper: mirror mainnet Chainlink prices"
  CHAIN_ID=46630 RPC_URL=$RPC "$ROOT/scripts/keeper.sh" --once || true
  echo "== collateral for the put vault: 20 USDG"
  PUT=$(python3 -c "import json; print(json.load(open('$ROOT/contracts/deployments/46630-vaults.json'))['TSLA_cash_secured_put'])")
  USDG=0x7E955252E15c84f5768B83c41a71F9eba181802F
  if [ "$(cast call $PUT 'totalAssets()(uint256)' --rpc-url $RPC | awk '{print $1}')" = "0" ]; then
    cast send $USDG 'approve(address,uint256)' $PUT 20000000 --rpc-url $RPC --private-key $PRIVATE_KEY >/dev/null
    cast send $PUT 'deposit(uint256,address)' 20000000 $(cast wallet address --private-key $PRIVATE_KEY) --rpc-url $RPC --private-key $PRIVATE_KEY --json | python3 -c "import json,sys; print('deposit tx', json.load(sys.stdin)['transactionHash'])"
  fi
  echo; echo "== seller agent: 0.20-delta covered call, proposed by delta"
  agent --vault sTSLA-CC
  echo; echo "== reckless agent: at-the-money put, forced"
  agent --reckless --vault sTSLA-CSP
  echo; echo "== buyer agent: calls within a 15 USDG budget"
  agent --buy --budget 15 --vault sTSLA-CC
  echo '```'
} | sed 's/\x1b\[[0-9;]*m//g' | tee "$OUT"
