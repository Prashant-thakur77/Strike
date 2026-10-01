#!/usr/bin/env bash
# Agent #1's weekly run on one chain (GitHub Actions agent.yml, one job per chain): every active deployment file of
# CHAIN_ID, with the keeper's rule (scripts/keeper.sh: <chainId>.json first, then <chainId>-<name>.json, skipping
# *-vaults.json and files whose `status` starts with "superseded"), and on each the vaults in its -vaults.json
# (TSLA_covered_call, TSLA_cash_secured_put).
#   propose: --vault <v> --log <dir> --anchor, plus --llm --planner api|claude-code when a Claude credential is set
#   settle:  --vault <v> --log <dir> --anchor --settle (records the keeper's settlement; settles only if nothing has)
# A deployment other than <chainId>.json (46630-v3.json) is reached through the SDK's STRIKE_* address overrides.
#
# Signer: each deployment's agent #1 signer is `agentSigner` in its -vaults.json. The run signs with whichever of
# KEEPER_PRIVATE_KEY (the deployer: agent #1's signer on 46630 v2) and AGENT_SIGNER_KEY (agent #1's separate v3
# signer, 0x4fd9…AC6f, on 46630 v3 and 421614) has that address; a deployment whose key is not set is skipped with a
# warning. Records go to LOG_DIR (default docs/agent-log on 46630, docs/agent-log/arbitrum-sepolia on 421614), and
# each anchor's URL points at that folder on main. Two deployments on one chain share the folder, so the second
# deployment's record of a vault symbol gets the agent's `-2` suffix (v3 on 46630).
#
# Usage: CHAIN_ID=46630 RPC_URL=https://rpc.testnet.chain.robinhood.com scripts/weekly-agent.sh propose|settle [--dry-run]
#   --dry-run  read only, no key needed: propose runs the agent with --dry-run (no --anchor, records to a temporary
#              folder), settle runs --status; both print the signer, overrides, record folder and anchor URL.
# Exits 3 when at least one vault's run stopped (its decision record says why), after trying every vault.
# Needs Foundry (cast), jq, python3 and the workspace's pnpm install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHAIN_ID="${CHAIN_ID:?CHAIN_ID is required}"
RPC_URL="${RPC_URL:?RPC_URL is required}"
MODE="${1:-}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1
case "$MODE" in propose | settle) ;; *) echo "usage: scripts/weekly-agent.sh propose|settle [--dry-run]" >&2; exit 2 ;; esac
case "$CHAIN_ID" in
  46630) LOG_DIR="${LOG_DIR:-docs/agent-log}" ;;
  421614) LOG_DIR="${LOG_DIR:-docs/agent-log/arbitrum-sepolia}" ;;
  *) LOG_DIR="${LOG_DIR:-docs/agent-log/$CHAIN_ID}" ;;
esac
REPO="${GITHUB_REPOSITORY:-Prashant-thakur77/Strike}"
BASE_URL="https://github.com/$REPO/blob/main/$LOG_DIR/"

# The active deployment files for this chain, the primary <chainId>.json first (the same rule as keeper.sh).
deploy_files() {
  local f
  for f in "$ROOT/contracts/deployments/$CHAIN_ID.json" "$ROOT"/contracts/deployments/"$CHAIN_ID"-*.json; do
    [ -f "$f" ] || continue
    case "$f" in *-vaults.json) continue ;; esac
    python3 -c "import json,sys; sys.exit(1 if str(json.load(open(sys.argv[1])).get('status','')).startswith('superseded') else 0)" "$f" || continue
    echo "$f"
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
       "riskEngine": "STRIKE_RISK_ENGINE", "riskLens": "STRIKE_RISK_LENS"}
for key, name in env.items():
    v = d.get(key)
    if isinstance(v, str) and v.startswith("0x") and len(v) == 42:
        print(f"export {name}={shlex.quote(v)}")
if isinstance(d.get("block"), int):
    print(f"export STRIKE_DEPLOY_BLOCK={d['block']}")
PY
}

# key_for <address>: the private key (of KEEPER_PRIVATE_KEY, AGENT_SIGNER_KEY) whose address it is, or nothing.
key_for() {
  local want key addr
  want=$(echo "$1" | tr '[:upper:]' '[:lower:]')
  for key in "${KEEPER_PRIVATE_KEY:-}" "${AGENT_SIGNER_KEY:-}"; do
    [ -n "$key" ] || continue
    addr=$(cast wallet address --private-key "$key" | tr '[:upper:]' '[:lower:]')
    [ "$addr" = "$want" ] && { echo "$key"; return 0; }
  done
  return 0
}

flags=()
if [ "$MODE" = settle ]; then
  flags+=(--settle)
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  flags+=(--llm --planner api)
  echo "ANTHROPIC_API_KEY is set: Claude plans each epoch through the API (--llm)."
elif [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  flags+=(--llm --planner claude-code)
  echo "CLAUDE_CODE_OAUTH_TOKEN is set: Claude plans each epoch through the Claude Code CLI (--llm)."
else
  echo "No Claude credential: the default rule plans each epoch (0.20 delta at fair value)."
fi

LOG_PATH="$ROOT/$LOG_DIR"
if [ "$DRY_RUN" = 1 ]; then
  LOG_PATH=$(mktemp -d)
  cp -r "$ROOT/$LOG_DIR/." "$LOG_PATH/" 2>/dev/null || true
fi

failed=0
for deploy in $(deploy_files); do
  name=$(basename "$deploy" .json)
  vaults="${deploy%.json}-vaults.json"
  if [ ! -f "$vaults" ]; then
    echo "::warning::$name: no $(basename "$vaults"); skipped"
    continue
  fi
  signer=$(jq -r '.agentSigner' "$vaults")
  # The deployer is the keeper key; any other signer is agent #1's separate signer key.
  secret=AGENT_SIGNER_KEY
  [ "$(jq -r '.deployer' "$deploy" | tr '[:upper:]' '[:lower:]')" = "$(echo "$signer" | tr '[:upper:]' '[:lower:]')" ] && secret=KEEPER_PRIVATE_KEY
  key=$(key_for "$signer")
  overrides=""
  [ "$deploy" != "$ROOT/contracts/deployments/$CHAIN_ID.json" ] && overrides=$(sdk_overrides "$deploy")
  echo "== $name: agent #$(jq -r '.agentId' "$vaults"), signer $signer (secret $secret), records in $LOG_DIR, anchor URL $BASE_URL<file>"
  [ -n "$overrides" ] && echo "   SDK overrides: $(echo "$overrides" | sed 's/^export //' | tr '\n' ' ')"
  if [ -z "$key" ] && [ "$DRY_RUN" = 0 ]; then
    echo "::warning::$name skipped: agent #1 signs there with $signer; set the secret $secret to that key"
    continue
  fi
  for vkey in TSLA_covered_call TSLA_cash_secured_put; do
    vault=$(jq -r ".$vkey // empty" "$vaults")
    [ -n "$vault" ] || continue
    if [ "$DRY_RUN" = 1 ]; then
      run_flags=(--vault "$vault")
      if [ "$MODE" = settle ]; then run_flags+=(--status); else run_flags+=(--log "$LOG_PATH" --dry-run "${flags[@]}"); fi
    else
      run_flags=(--vault "$vault" --log "$LOG_PATH" --anchor "${flags[@]}")
    fi
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::group::$name $vkey ($vault) ${run_flags[*]}"
    [ -z "${GITHUB_ACTIONS:-}" ] && echo "-- $name $vkey: pnpm --filter @strike/agent-example start ${run_flags[*]}"
    # A subshell per run: one deployment's overrides and key never reach the next.
    if ! (
      cd "$ROOT"
      export STRIKE_CHAIN_ID="$CHAIN_ID" STRIKE_RPC_URL="$RPC_URL" STRIKE_RECORD_BASE_URL="$BASE_URL"
      unset STRIKE_AGENT_PRIVATE_KEY
      [ -n "$key" ] && [ "$DRY_RUN" = 0 ] && export STRIKE_AGENT_PRIVATE_KEY="$key"
      [ -n "$overrides" ] && eval "$overrides"
      unset KEEPER_PRIVATE_KEY AGENT_SIGNER_KEY
      pnpm --silent --filter @strike/agent-example start "${run_flags[@]}"
    ); then
      failed=1
      echo "::warning::the agent stopped on $name $vkey ($vault); its decision record says why"
    fi
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::endgroup::"
  done
done

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run: records written to $LOG_PATH (a copy of $LOG_DIR), not to the repository."
  for f in "$LOG_PATH"/*; do echo "  $(basename "$f")"; done
fi
[ "$failed" = 0 ] || exit 3
