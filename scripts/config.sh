# shellcheck shell=bash
# Sourced by scripts/rpc.sh (so by keeper.sh and weekly-agent.sh) and the other scripts: reads strike.config.json, the
# one file that names Strike's chains, endpoints, deployment files and services (docs/configuration.md). jq when it
# is installed, else node (STRIKE_CONFIG_READER=jq|node forces one). STRIKE_CONFIG points at another file.
#   strike_config_get <key>...    the value at that path, one line per element for a list; exit 4 if absent or empty
#   strike_config_keys <key>...   the keys of the object at that path, in file order
#   strike_deployment_files <chainId>
#                                 the chain's active deployment files (absolute paths), the primary first: the
#                                 config's `deployments` list, minus missing files and files whose `status` starts
#                                 with "superseded"
# Example: strike_config_get chains 46630 rpc public  ->  https://rpc.testnet.chain.robinhood.com

STRIKE_ROOT="${STRIKE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STRIKE_CONFIG_FILE="${STRIKE_CONFIG:-$STRIKE_ROOT/strike.config.json}"

_strike_config_reader() {
  case "${STRIKE_CONFIG_READER:-}" in
    jq | node) echo "$STRIKE_CONFIG_READER" ;;
    *) if command -v jq >/dev/null 2>&1; then echo jq; else echo node; fi ;;
  esac
}

# _strike_config <get|keys> <key>...
_strike_config() {
  local mode="$1"
  shift
  if [ "$(_strike_config_reader)" = jq ]; then
    if [ "$mode" = keys ]; then
      jq -er 'getpath($ARGS.positional) | if type == "object" then keys_unsorted[] else empty end' "$STRIKE_CONFIG_FILE" --args "$@"
    else
      jq -er 'getpath($ARGS.positional) as $v | if $v == null then empty elif ($v | type) == "array" then $v[] else $v end' \
        "$STRIKE_CONFIG_FILE" --args "$@"
    fi
  else
    # The same output and exit status as jq -e: 4 when nothing is printed, 1 when the last value is false.
    node -e '
      const [file, mode, ...path] = process.argv.slice(1);
      let v = JSON.parse(require("fs").readFileSync(file, "utf8"));
      for (const k of path) v = v === null || typeof v !== "object" ? undefined : v[k];
      if (v === undefined || v === null) process.exit(4);
      const isMap = typeof v === "object" && !Array.isArray(v);
      const out = mode === "keys" ? (isMap ? Object.keys(v) : []) : Array.isArray(v) ? v : [v];
      for (const x of out) console.log(typeof x === "object" && x !== null ? JSON.stringify(x) : String(x));
      process.exit(out.length === 0 ? 4 : out[out.length - 1] === false ? 1 : 0);
    ' "$STRIKE_CONFIG_FILE" "$mode" "$@"
  fi
}

strike_config_get() { _strike_config get "$@"; }
strike_config_keys() { _strike_config keys "$@"; }

strike_deployment_files() {
  local f
  for f in $(strike_config_get chains "$1" deployments || true); do
    f="$STRIKE_ROOT/$f"
    [ -f "$f" ] || continue
    python3 -c "import json,sys; sys.exit(1 if str(json.load(open(sys.argv[1])).get('status','')).startswith('superseded') else 0)" "$f" || continue
    echo "$f"
  done
}
