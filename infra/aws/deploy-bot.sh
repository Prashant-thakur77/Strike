#!/bin/bash
# Deploys (or updates the infrastructure of) the Strike Telegram bot on AWS with infra/aws/telegram-bot.yaml.
#
#   infra/aws/deploy-bot.sh --i-stopped-the-local-bot            # first deploy
#   infra/aws/deploy-bot.sh --instance-type t4g.small            # later: change infrastructure
#
# First deploy: checks the AWS login, stores the bot token from bots/telegram/.env (and ALCHEMY_API_KEY from
# the repository's .env, if set) as SSM SecureString parameters without printing them, uploads the local
# bot's state file (subscribers, log cursor) so the cloud copy carries on where it stopped, creates the
# stack, and waits until the bot on the instance reports that it is running.
#
# Telegram allows one long-polling client per token: stop the local bot first. The script refuses to
# create the stack while a local bot process is running, and asks for --i-stopped-the-local-bot.
#
# Options:
#   --region R                 AWS region (default: AWS_REGION, the CLI profile, else ap-southeast-1)
#   --stack NAME               stack name (default strike-telegram-bot)
#   --instance-type T          t4g.nano (default), t4g.micro or t4g.small
#   --cpu-credits MODE         standard (default) or unlimited
#   --chain-id N               STRIKE_CHAIN_ID (default 46630)
#   --rpc-url URL              STRIKE_RPC_URL without secrets (default: the chain's public RPC)
#   --repo-ref REF             branch or tag to clone on the first boot (default main)
#   --token-file FILE          .env file with TELEGRAM_BOT_TOKEN (default bots/telegram/.env)
#   --alchemy-file FILE        .env file with ALCHEMY_API_KEY (default .env at the repository root)
#   --state-file FILE          state to start from (default bots/telegram/data/state-<chain>.json, if present)
#   --no-state                 start with no subscribers instead
#   --update-secrets           overwrite existing SSM parameters with the local values
#   --latest-ami               on an update, move to the newest Amazon Linux AMI. This replaces the instance,
#                              which resets the bot's state (run destroy-bot.sh --save-state first if needed)
#   --i-stopped-the-local-bot  confirms no other copy of the bot is polling this token
set -euo pipefail
# shellcheck source=infra/aws/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

region_arg="" STACK=$DEFAULT_STACK chain_id="" instance_type="" cpu_credits="" rpc_url="" rpc_set=false
repo_ref="" token_file=$REPO_ROOT/bots/telegram/.env alchemy_file=$REPO_ROOT/.env state_file="" no_state=false
update_secrets=false latest_ami=false stopped_local=false
while [ $# -gt 0 ]; do
  case $1 in
    --region) region_arg=$2 && shift ;;
    --stack) STACK=$2 && shift ;;
    --instance-type) instance_type=$2 && shift ;;
    --cpu-credits) cpu_credits=$2 && shift ;;
    --chain-id) chain_id=$2 && shift ;;
    --rpc-url) rpc_url=$2 rpc_set=true && shift ;;
    --repo-ref) repo_ref=$2 && shift ;;
    --token-file) token_file=$2 && shift ;;
    --alchemy-file) alchemy_file=$2 && shift ;;
    --state-file) state_file=$2 && shift ;;
    --no-state) no_state=true ;;
    --update-secrets) update_secrets=true ;;
    --latest-ami) latest_ami=true ;;
    --i-stopped-the-local-bot) stopped_local=true ;;
    -h | --help) usage && exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

REGION=$(resolve_region "$region_arg")
TEMPLATE=$AWS_DIR/telegram-bot.yaml
WORK=$(mktemp -d)
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# env_value FILE KEY: the last KEY=value in a .env file, without quotes, comments or CR. Never printed.
env_value() {
  [ -f "$1" ] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=[[:space:]]*//p" "$1" | tail -n 1 |
    tr -d '\r' | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

# put_secure NAME VALUE TIER: store VALUE as a SecureString through a 0600 file (not the command line).
put_secure() {
  local name=$1 value=$2 tier=${3:-Standard} file=$WORK/value extra=()
  printf '%s' "$value" >"$file"
  if parameter_exists "$name"; then extra=(--overwrite); else extra=(--tags "Key=Project,Value=Strike"); fi
  aws ssm put-parameter --region "$REGION" --name "$name" --type SecureString --tier "$tier" \
    --value "file://$file" "${extra[@]}" --query Version --output text >/dev/null
  rm -f "$file"
}

# Processes of a local bot: `pnpm --filter @strike/telegram-bot start` and the node or tsx process running
# in bots/telegram.
local_bot_pids() {
  local pid cwd
  for pid in $(pgrep -f -- '@strike/telegram-bot|src/index\.ts|dist/index\.js' || true); do
    [ "$pid" != "$$" ] || continue
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
    if [[ $cwd == */bots/telegram ]] || tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q '@strike/telegram-bot'; then
      printf '%s ' "$pid"
    fi
  done
}

require_aws
status=$(stack_status)
creating=true
case $status in
  "") ;;
  CREATE_COMPLETE | UPDATE_COMPLETE | UPDATE_ROLLBACK_COMPLETE) creating=false ;;
  UPDATE_FAILED) die "the last update of $STACK failed. Roll it back, then run this again:
    aws cloudformation rollback-stack --region $REGION --stack-name $STACK && aws cloudformation wait stack-rollback-complete --region $REGION --stack-name $STACK" ;;
  *) die "stack $STACK is in state $status. Read its events and the bootstrap log (README: Troubleshooting), then run infra/aws/destroy-bot.sh and deploy again" ;;
esac

if $creating; then
  info "creating stack $STACK"
  pids=$(local_bot_pids)
  pids=${pids% }
  if [ -n "$pids" ]; then
    die "a local copy of the bot is running (pid $pids). Two pollers on one token make Telegram return 409 Conflict. Stop it so it saves its state, then run this again:
    kill -TERM $pids"
  fi
  $stopped_local || die "confirm that no other copy of the bot uses this token (laptop, VPS, another account) with --i-stopped-the-local-bot"
else
  info "updating stack $STACK ($status)"
fi

# Secrets: the bot token is required, the Alchemy key optional. Existing parameters are kept unless
# --update-secrets is given.
if $update_secrets || ! parameter_exists "$TOKEN_PARAMETER"; then
  token=$(env_value "$token_file" TELEGRAM_BOT_TOKEN)
  [ -n "$token" ] || die "no TELEGRAM_BOT_TOKEN in $token_file, and parameter $TOKEN_PARAMETER does not exist"
  [[ $token =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]] || die "TELEGRAM_BOT_TOKEN in $token_file does not look like a BotFather token"
  put_secure "$TOKEN_PARAMETER" "$token"
  unset token
  info "stored the bot token from $token_file in $TOKEN_PARAMETER (SecureString)"
else
  info "bot token: using the existing $TOKEN_PARAMETER"
fi
if $update_secrets || ! parameter_exists "$ALCHEMY_PARAMETER"; then
  alchemy=$(env_value "$alchemy_file" ALCHEMY_API_KEY)
  [ -n "$alchemy" ] || alchemy=${ALCHEMY_API_KEY:-}
  if [ -n "$alchemy" ]; then
    [[ $alchemy =~ ^[A-Za-z0-9_-]+$ ]] || die "ALCHEMY_API_KEY does not look like an Alchemy API key"
    put_secure "$ALCHEMY_PARAMETER" "$alchemy"
    info "stored ALCHEMY_API_KEY in $ALCHEMY_PARAMETER (SecureString)"
  else
    info "no ALCHEMY_API_KEY in $alchemy_file or the environment; the bot uses STRIKE_RPC_URL or the public RPC"
  fi
  unset alchemy
else
  info "Alchemy key: using the existing $ALCHEMY_PARAMETER"
fi

overrides=()
[ -z "$instance_type" ] || overrides+=("InstanceType=$instance_type")
[ -z "$cpu_credits" ] || overrides+=("CpuCredits=$cpu_credits")
[ -z "$chain_id" ] || overrides+=("ChainId=$chain_id")
! $rpc_set || overrides+=("RpcUrl=$rpc_url")
[ -z "$repo_ref" ] || overrides+=("RepoRef=$repo_ref")

seeded=false
if $creating; then
  # Carry the local bot's subscribers and log cursor over (the instance reads this once, on its first boot).
  [ -n "$state_file" ] || state_file=$REPO_ROOT/bots/telegram/data/state-${chain_id:-46630}.json
  if ! $no_state && [ -f "$state_file" ]; then
    size=$(wc -c <"$state_file")
    tier=Standard
    [ "$size" -le 4096 ] || tier=Advanced
    [ "$size" -le 8192 ] || die "$state_file is $size bytes, over the 8 KB parameter limit; deploy with --no-state and copy it over Session Manager"
    put_secure "$SEED_PARAMETER" "$(cat "$state_file")" "$tier"
    seeded=true
    info "uploaded $state_file to $SEED_PARAMETER ($size bytes, $tier tier) for the first boot"
  else
    info "no local state file; the bot starts with no subscribers"
  fi
elif ! $latest_ami; then
  # Keep the running AMI so a newer Amazon Linux release does not replace the instance.
  ami=$(stack_output ImageId)
  [ -z "$ami" ] || [ "$ami" = None ] || overrides+=("ImageId=$ami")
else
  warn "--latest-ami replaces the instance if a newer AMI exists; its state file (subscribers) starts over"
  overrides+=("ImageId=")
fi

info "deploying $TEMPLATE (the first deploy takes 10 to 25 minutes: it waits until the bot is running)"
deploy_args=(--region "$REGION" --stack-name "$STACK" --template-file "$TEMPLATE"
  --capabilities CAPABILITY_IAM --tags Project=Strike --no-fail-on-empty-changeset --disable-rollback)
[ ${#overrides[@]} -eq 0 ] || deploy_args+=(--parameter-overrides "${overrides[@]}")
if ! aws cloudformation deploy "${deploy_args[@]}"; then
  warn "the deploy failed; resources are kept for inspection (--disable-rollback)"
  aws cloudformation describe-stack-events --region "$REGION" --stack-name "$STACK" \
    --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId, ResourceStatusReason]" \
    --output text | head -n 10 >&2 || true
  cat >&2 <<EOF
Bootstrap and install logs:
  aws logs tail $LOG_GROUP --region $REGION --since 1h
Console output of the instance (if the CloudWatch agent never started):
  aws ec2 get-console-output --region $REGION --latest --output text --instance-id \$(aws cloudformation describe-stack-resource --region $REGION --stack-name $STACK --logical-resource-id BotInstance --query StackResourceDetail.PhysicalResourceId --output text)
Clean up before trying again:
  infra/aws/destroy-bot.sh --region $REGION --stack $STACK
EOF
  exit 1
fi

if $seeded; then
  aws ssm delete-parameter --region "$REGION" --name "$SEED_PARAMETER"
  info "deleted $SEED_PARAMETER (the instance has its own state file now)"
fi

iid=$(stack_output InstanceId)
info "the bot runs on $iid"
aws logs tail "$LOG_GROUP" --region "$REGION" --since 30m --log-stream-name-prefix "$iid/bot" 2>/dev/null | tail -n 5 || true
cat <<EOF

Logs:     aws logs tail $LOG_GROUP --region $REGION --follow
Shell:    $(stack_output StartSessionCommand)
Update:   infra/aws/update-bot.sh --region $REGION      (git pull on the instance and restart)
Destroy:  infra/aws/destroy-bot.sh --region $REGION --save-state bots/telegram/data/state-$(stack_parameter ChainId).json
EOF
