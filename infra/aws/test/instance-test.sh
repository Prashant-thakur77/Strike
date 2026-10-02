#!/bin/bash
# Local test of the bot's start path on the EC2 instance, with no AWS account and no real Telegram token.
#
#  1. strike-bot-env against a fake `aws` on PATH: writes a 0600 env file with the token and the Alchemy key,
#     accepts a missing Alchemy parameter, fails on a missing or malformed token, never prints a secret.
#  2. A fresh clone of HEAD, installed with the instance's command (pnpm install --prod --filter
#     "@strike/telegram-bot..."): only production dependencies of the bot and the SDK.
#  3. strike-bot.service, emulated: ExecStartPre, the EnvironmentFile= and Environment= lines in order, then
#     ExecStart from WorkingDirectory with output appended to the StandardOutput= file, against a fake Telegram
#     API. The bot must print its startup line, use the token and the Alchemy key from SSM, write its state file
#     and stop cleanly on SIGTERM; ExecStopPost removes the secrets file. Reads Robinhood Chain testnet (read-only;
#     the fake Alchemy key is refused, so the SDK falls back to the public RPC).
#
# Usage: infra/aws/test/instance-test.sh [--skip-bot]     NODE=/path/to/node to pick the Node binary
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
INST=$ROOT/infra/aws/instance
UNIT=$INST/strike-bot.service
NODE=${NODE:-$(command -v node)}
skip_bot=false
[ "${1:-}" != --skip-bot ] || skip_bot=true

T=$(mktemp -d "${TMPDIR:-/tmp}/strike-instance-test.XXXXXX")
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$T"
}
trap cleanup EXIT

pass() { printf 'ok   %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*"
  exit 1
}

FAKE_TOKEN=123456789:AAtest-fake_token-not-real-0123456789
FAKE_ALCHEMY=alchemy_fake-key_0123456789
export FAKE_AWS_LOG=$T/aws-calls.log
mkdir -p "$T/bin" "$T/run" "$T/etc" "$T/state" "$T/log" "$T/home"

# A fake AWS CLI that only answers `ssm get-parameter --with-decryption`, from FAKE_SSM_<name> variables.
cat >"$T/bin/aws" <<'EOF'
#!/bin/bash
echo "$*" >>"$FAKE_AWS_LOG"
[ "$1 $2" = "ssm get-parameter" ] || { echo "fake aws: unexpected call: $*" >&2; exit 2; }
name="" decrypt=false region=false
while [ $# -gt 0 ]; do
  case $1 in --name) name=$2 && shift ;; --with-decryption) decrypt=true ;; --region) region=true ;; esac
  shift
done
$decrypt && $region || { echo "fake aws: --with-decryption or --region missing" >&2; exit 2; }
var="FAKE_SSM_$(printf '%s' "$name" | tr -c 'A-Za-z0-9' '_')"
[ -n "${!var+x}" ] || { echo "An error occurred (ParameterNotFound) when calling the GetParameter operation: " >&2; exit 254; }
printf '%s\n' "${!var}"
EOF
chmod +x "$T/bin/aws"

# bot.conf exactly as the CloudFormation user-data writes it (the heredoc in telegram-bot.yaml), with test values.
sed -n "/cat > \/etc\/strike-bot\/bot.conf <<'CONF'/,/^ *CONF\$/p" "$ROOT/infra/aws/telegram-bot.yaml" | sed '1d;$d' |
  sed -E 's/^ +//; s/\$\{AWS::Region\}/ap-southeast-1/; s/\$\{ChainId\}/46630/; s/\$\{RpcUrl\}//;
    s#\$\{TokenParameterName\}#/strike/telegram-bot-token#; s#\$\{AlchemyKeyParameterName\}#/strike/alchemy-api-key#;
    s#\$\{StateSeedParameterName\}#/strike/telegram-bot-state-seed#; s/\$\{NodeVersion\}/22.23.3/; s/\$\{RepoRef\}/main/' \
    >"$T/etc/bot.conf"
grep -qF "\${" "$T/etc/bot.conf" && fail "bot.conf from the template has unsubstituted parameters"
[ "$(grep -c = "$T/etc/bot.conf")" -eq 8 ] || fail "bot.conf from the template: expected 8 settings"
pass "bot.conf extracted from telegram-bot.yaml ($(cut -d= -f1 "$T/etc/bot.conf" | tr '\n' ' '))"

conf_env=()
while IFS= read -r line; do conf_env+=("$line"); done <"$T/etc/bot.conf"

# The unit's secrets file must be strike-bot-env's default output path (the test overrides it below).
grep -q '^EnvironmentFile=-/run/strike-bot/secrets.env$' "$UNIT" || fail "unit: secrets EnvironmentFile changed"
# shellcheck disable=SC2016  # a literal line of strike-bot-env
grep -qF 'out=${STRIKE_BOT_SECRETS_FILE:-/run/strike-bot/secrets.env}' "$INST/strike-bot-env" || fail "strike-bot-env default path changed"

secrets=$T/run/secrets.env
run_env() { # run strike-bot-env with the conf environment, the fake aws and extra VAR=value arguments
  env -i PATH="$T/bin:/usr/bin:/bin" "${conf_env[@]}" STRIKE_BOT_SECRETS_FILE="$secrets" "$@" "$INST/strike-bot-env"
}

# 1a. token and Alchemy key
out=$(run_env FAKE_SSM__strike_telegram_bot_token="$FAKE_TOKEN" FAKE_SSM__strike_alchemy_api_key="$FAKE_ALCHEMY" 2>&1) ||
  fail "strike-bot-env failed: $out"
[ "$(stat -c %a "$secrets")" = 600 ] || fail "secrets file mode is $(stat -c %a "$secrets"), not 600"
[ "$(cat "$secrets")" = "$(printf 'TELEGRAM_BOT_TOKEN=%s\nALCHEMY_API_KEY=%s' "$FAKE_TOKEN" "$FAKE_ALCHEMY")" ] ||
  fail "secrets file content is wrong"
case $out in *"$FAKE_TOKEN"* | *"$FAKE_ALCHEMY"*) fail "strike-bot-env printed a secret" ;; esac
pass "strike-bot-env: token and Alchemy key from SSM into a 0600 file; output has no secret: $out"

# 1b. no Alchemy parameter
run_env FAKE_SSM__strike_telegram_bot_token="$FAKE_TOKEN" >/dev/null 2>&1 || fail "strike-bot-env failed without an Alchemy key"
[ "$(cat "$secrets")" = "TELEGRAM_BOT_TOKEN=$FAKE_TOKEN" ] || fail "secrets file without an Alchemy key is wrong"
pass "strike-bot-env: a missing Alchemy parameter is fine (token only)"

# 1c. no token parameter, 1d. malformed token
rm -f "$secrets"
if out=$(run_env 2>&1); then fail "strike-bot-env succeeded without a token"; fi
[ ! -e "$secrets" ] || fail "strike-bot-env wrote a secrets file without a token"
pass "strike-bot-env: a missing token parameter fails: $out"
if out=$(run_env FAKE_SSM__strike_telegram_bot_token=not-a-token 2>&1); then fail "strike-bot-env accepted a malformed token"; fi
case $out in *not-a-token*) fail "strike-bot-env printed the malformed value" ;; esac
pass "strike-bot-env: a malformed token fails: $out"

$skip_bot && exit 0

# 2. Fresh clone of HEAD, installed with the instance's command.
pnpm_flags='--frozen-lockfile --prod --filter "@strike/telegram-bot..."'
grep -qF -- "corepack pnpm install $pnpm_flags" "$INST/install.sh" || fail "install.sh no longer runs: pnpm install $pnpm_flags"
git clone --quiet --depth 1 "file://$ROOT" "$T/repo"
(
  cd "$T/repo"
  PATH="$(dirname "$NODE"):$PATH"
  export CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PATH
  corepack pnpm install --frozen-lockfile --prod --filter "@strike/telegram-bot..." \
    --config.confirmModulesPurge=false --reporter=silent
)
[ -e "$T/repo/bots/telegram/node_modules/tsx" ] || fail "tsx was not installed for the bot"
[ ! -e "$T/repo/bots/telegram/node_modules/vitest" ] || fail "dev dependencies were installed"
[ ! -e "$T/repo/app/node_modules" ] || fail "the app's dependencies were installed"
pass "fresh clone $(git -C "$T/repo" log -1 --format=%h): bot and SDK production dependencies only ($(du -sh "$T/repo/node_modules" | cut -f1) in node_modules)"

# A fake Telegram Bot API: getMe, empty getUpdates (after 1 s, as a long poll would), ok for anything else.
cat >"$T/telegram.mjs" <<'EOF'
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const [log, portFile, token] = process.argv.slice(2);
const server = createServer((req, res) => {
  const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
  const method = m ? m[2] : "?";
  appendFileSync(log, `${method} token=${m && m[1] === token ? "match" : "MISMATCH"}\n`);
  const reply = (result) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  if (method === "getMe") reply({ id: 1, is_bot: true, first_name: "Strike test", username: "strike_test_bot" });
  else if (method === "getUpdates") setTimeout(() => reply([]), 1000);
  else reply({});
});
server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
EOF
"$NODE" "$T/telegram.mjs" "$T/telegram.log" "$T/telegram.port" "$FAKE_TOKEN" &
pids+=($!)
for _ in $(seq 50); do [ -s "$T/telegram.port" ] && break; sleep 0.1; done
port=$(cat "$T/telegram.port")

# 3. The unit, emulated. Paths on the instance map to the test directory.
rewrite() {
  sed -e "s#/opt/strike/node/bin/node#$NODE#g; s#/opt/strike/repo#$T/repo#g; s#/usr/local/sbin/strike-bot-env#$INST/strike-bot-env#g" \
    -e "s#/etc/strike-bot/bot.conf#$T/etc/bot.conf#g; s#/run/strike-bot/secrets.env#$secrets#g" \
    -e "s#/var/lib/strike-bot#$T/state#g; s#/var/log/strike-bot#$T/log#g"
}
directive() { sed -n "s/^$1=//p" "$UNIT" | rewrite; }

pre=$(directive ExecStartPre)
pre=${pre#+}
rm -f "$secrets"
# shellcheck disable=SC2086  # $pre is a command line, split like systemd does
env -i PATH="$T/bin:/usr/bin:/bin" "${conf_env[@]}" STRIKE_BOT_SECRETS_FILE="$secrets" \
  FAKE_SSM__strike_telegram_bot_token="$FAKE_TOKEN" FAKE_SSM__strike_alchemy_api_key="$FAKE_ALCHEMY" \
  $pre >/dev/null || fail "ExecStartPre failed"

bot_env=(PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin HOME="$T/home")
while IFS= read -r line; do bot_env+=("$line"); done < <(directive Environment)
while IFS= read -r file; do
  optional=false
  [ "${file#-}" = "$file" ] || { optional=true && file=${file#-}; }
  if [ -f "$file" ]; then
    while IFS= read -r line; do [[ -z $line || $line == \#* ]] || bot_env+=("$line"); done <"$file"
  elif ! $optional; then
    fail "EnvironmentFile $file is missing"
  fi
done < <(directive EnvironmentFile)
bot_env+=(TELEGRAM_API_URL="http://127.0.0.1:$port")

# A state file already in DATA_DIR, as install.sh writes it from the state seed: one subscriber, and a cursor past
# the head so the bot does not spend the test catching up from the deploy block.
seed='{"version":1,"chainId":46630,"cursor":"999999999999","updateOffset":7,"subscribers":[42]}'
printf '%s\n' "$seed" >"$T/state/state-46630.json"

workdir=$(directive WorkingDirectory)
logfile=$(directive StandardOutput)
logfile=${logfile#append:}
read -r -a start <<<"$(directive ExecStart)"
(cd "$workdir" && exec env -i "${bot_env[@]}" "${start[@]}" >>"$logfile" 2>&1) &
bot=$!
pids+=("$bot")

up=""
for _ in $(seq 120); do
  up=$(grep -E ' on chain [0-9]+[ ;]' "$logfile" || true)
  [ -z "$up" ] || break
  kill -0 "$bot" 2>/dev/null || fail "the bot exited: $(tail -n 5 "$logfile")"
  sleep 1
done
[ -n "$up" ] || fail "no startup line after 120 s: $(tail -n 5 "$logfile")"
pass "ExecStart from $workdir: $up"
# The fake key fails at Alchemy and the SDK falls back to the public RPC; the line shows the bot got the key.
[[ $up == *"via Alchemy ("* ]] || fail "the bot did not pick up ALCHEMY_API_KEY from the secrets file"
pass "ALCHEMY_API_KEY from SSM reached the bot (Alchemy first, public RPC as fallback)"
grep -q '^getMe token=match$' "$T/telegram.log" || fail "the bot did not call getMe with the token from SSM"
pass "the bot called the Telegram API with the token from the SSM parameter ($(sort -u "$T/telegram.log" | tr '\n' ' '))"

# systemd waits TimeoutStopSec (90 s by default) after SIGTERM before it sends SIGKILL.
kill -TERM "$bot"
stop_start=$SECONDS
for _ in $(seq 90); do kill -0 "$bot" 2>/dev/null || break; sleep 1; done
! kill -0 "$bot" 2>/dev/null || fail "the bot did not stop within 90 s of SIGTERM: $(tail -n 3 "$logfile")"
grep -q ' stopped$' "$logfile" || fail "the bot did not log a clean stop"
state=$(tr -d ' \n' <"$T/state/state-46630.json")
[[ $state == *'"subscribers":[42]'* && $state == *'"updateOffset":7'* ]] || fail "the state file lost the seeded subscriber: $state"
pass "SIGTERM: clean stop after $((SECONDS - stop_start)) s; the seeded state file was read and kept ($state)"

post=$(directive ExecStopPost)
${post#+}
[ ! -e "$secrets" ] || fail "ExecStopPost left the secrets file"
pass "ExecStopPost removed the secrets file"
grep -qF -e "$FAKE_TOKEN" -e "$FAKE_ALCHEMY" "$logfile" && fail "the bot log contains a secret"
pass "the bot log has no token and no Alchemy key; all tests passed"
