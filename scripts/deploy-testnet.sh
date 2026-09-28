#!/usr/bin/env bash
# One-command testnet deployment:
#   scripts/deploy-testnet.sh robinhood-testnet | arbitrum-sepolia
# Deploys and verifies the Solidity protocol (Blockscout), deploys and activates the Stylus pricer, points the
# EpochManager at it, seeds the demo agent and vaults, and regenerates the SDK's ABIs and deployments map.
# Reads PRIVATE_KEY from contracts/.env.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$HOME/.cargo/bin:$PATH"
set -a; source "$ROOT/contracts/.env"; set +a

case "${1:-}" in
  robinhood-testnet)
    CHAIN_ID=46630
    RPC=https://rpc.testnet.chain.robinhood.com
    VERIFIER_URL=https://explorer.testnet.chain.robinhood.com/api/
    ;;
  arbitrum-sepolia)
    CHAIN_ID=421614
    RPC=https://sepolia-rollup.arbitrum.io/rpc
    VERIFIER_URL=https://arbitrum-sepolia.blockscout.com/api/
    ;;
  *) echo "usage: $0 robinhood-testnet|arbitrum-sepolia"; exit 1 ;;
esac

DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "Deploying Strike to chain $CHAIN_ID from $DEPLOYER ($(cast balance "$DEPLOYER" --rpc-url "$RPC" --ether) ETH)"

cd "$ROOT/contracts"
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --slow \
  --verify --verifier blockscout --verifier-url "$VERIFIER_URL" || {
  echo "Verification failed or partial; retrying verification only"
  forge script script/Deploy.s.sol --rpc-url "$RPC" --resume --verify --verifier blockscout --verifier-url "$VERIFIER_URL" || true
}

# Stylus pricer (Rust/WASM): deploy + activate, then make it the EpochManager's pricer.
cd "$ROOT/stylus/pricer"
# Reproducible (Docker) build first, so the WASM can be verified against this source with `cargo stylus verify`;
# fall back to a local build if Docker is unavailable.
STYLUS=$(cargo stylus deploy --endpoint "$RPC" --private-key "$PRIVATE_KEY" 2>&1 | tee /dev/stderr | grep -oE "activated contract 0x[0-9a-fA-F]{40}" | awk '{print $3}' || true)
if [ -z "$STYLUS" ]; then
  echo "Reproducible Stylus build failed; deploying a local build instead" >&2
  STYLUS=$(cargo stylus deploy --endpoint "$RPC" --private-key "$PRIVATE_KEY" --no-verify 2>&1 | tee /dev/stderr | grep -oE "activated contract 0x[0-9a-fA-F]{40}" | awk '{print $3}' || true)
fi
cd "$ROOT/contracts"
MANAGER=$(python3 -c "import json; print(json.load(open('deployments/$CHAIN_ID.json'))['epochManager'])")
if [ -n "$STYLUS" ]; then
  # Sanity check: the Stylus pricer must return exactly what the Solidity pricer returns.
  SOL=$(python3 -c "import json; print(json.load(open('deployments/$CHAIN_ID.json'))['pricer'])")
  ARGS="250000000000000000000 275000000000000000000 604800 600000000000000000 true"
  if [ "$(cast call "$STYLUS" "quote(uint256,uint256,uint256,uint256,bool)(uint256,int256)" $ARGS --rpc-url "$RPC")" = \
       "$(cast call "$SOL" "quote(uint256,uint256,uint256,uint256,bool)(uint256,int256)" $ARGS --rpc-url "$RPC")" ]; then
    cast send "$MANAGER" "setPricer(address)" "$STYLUS" --rpc-url "$RPC" --private-key "$PRIVATE_KEY" >/dev/null
    python3 - "$CHAIN_ID" "$STYLUS" <<'PY'
import json, sys
p = f"deployments/{sys.argv[1]}.json"; d = json.load(open(p)); d["stylusPricer"] = sys.argv[2]
json.dump(d, open(p, "w"), indent=2)
PY
    echo "EpochManager now prices with the Stylus pricer $STYLUS"
  else
    echo "Stylus and Solidity pricers disagree on-chain; keeping the Solidity pricer" >&2
  fi
fi

forge script script/Seed.s.sol --rpc-url "$RPC" --broadcast --slow
cd "$ROOT" && node scripts/export-abis.mjs
echo "Done. Addresses: contracts/deployments/$CHAIN_ID.json and $CHAIN_ID-vaults.json"
