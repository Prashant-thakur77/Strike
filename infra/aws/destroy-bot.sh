#!/bin/bash
# Deletes the bot's CloudFormation stack: the instance and its disk, the VPC, the IAM role and the log group.
# The SSM parameters (bot token, Alchemy key) are kept unless --delete-parameters is given.
#
#   infra/aws/destroy-bot.sh --save-state bots/telegram/data/state-46630.json   # keep the subscribers
#   infra/aws/destroy-bot.sh --delete-parameters --yes                          # remove everything
#
# Options:
#   --region R            AWS region (default: AWS_REGION, the CLI profile, else ap-southeast-1)
#   --stack NAME          stack name (default strike-telegram-bot)
#   --save-state FILE     first copy the bot's state file (subscribers, log cursor) from the instance to FILE,
#                         so a local copy (or the next deploy-bot.sh) carries on from it
#   --delete-parameters   also delete /strike/telegram-bot-token, /strike/alchemy-api-key and the state seed
#   --yes                 do not ask for confirmation
set -euo pipefail
# shellcheck source=infra/aws/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

region_arg="" STACK=$DEFAULT_STACK save_state="" delete_parameters=false yes=false
while [ $# -gt 0 ]; do
  case $1 in
    --region) region_arg=$2 && shift ;;
    --stack) STACK=$2 && shift ;;
    --save-state) save_state=$2 && shift ;;
    --delete-parameters) delete_parameters=true ;;
    --yes) yes=true ;;
    -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' && exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

REGION=$(resolve_region "$region_arg")
require_aws
status=$(stack_status)

if ! $yes; then
  what="stack $STACK${status:+ ($status)} in $REGION"
  $delete_parameters && what+=" and the bot's SSM parameters"
  read -r -p "Delete $what? Type yes: " answer
  [ "$answer" = yes ] || die "aborted"
fi

if [ -n "$save_state" ]; then
  [ -n "$status" ] || die "stack $STACK does not exist; there is no state to save"
  chain_id=$(stack_parameter ChainId)
  iid=$(instance_id)
  out=$(mktemp)
  # Stop the bot first, so the saved cursor and update offset are its last ones.
  run_on_instance "$iid" "Strike bot: stop and read state" 120 \
    'systemctl stop strike-bot.service' "cat /var/lib/strike-bot/state-$chain_id.json" >"$out" ||
    die "could not read the state file; nothing was deleted (start the bot again: infra/aws/update-bot.sh --restart-only)"
  # run_on_instance prints only the command's output (the JSON) on stdout.
  if command -v node >/dev/null 2>&1; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$out" 2>/dev/null ||
      die "the state read from the instance is not JSON (see $out); nothing was deleted"
  fi
  mkdir -p "$(dirname "$save_state")"
  mv "$out" "$save_state"
  info "saved the bot's state to $save_state"
fi

if [ -n "$status" ]; then
  info "deleting stack $STACK"
  aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
  aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"
  info "stack $STACK deleted"
else
  info "stack $STACK does not exist in $REGION"
fi

if $delete_parameters; then
  for name in "$TOKEN_PARAMETER" "$ALCHEMY_PARAMETER" "$SEED_PARAMETER"; do
    if parameter_exists "$name"; then
      aws ssm delete-parameter --region "$REGION" --name "$name"
      info "deleted $name"
    fi
  done
fi

cat <<EOF
The bot is no longer running on AWS. To run it locally again (one copy per token):
  pnpm --filter @strike/telegram-bot start
EOF
