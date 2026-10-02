#!/bin/bash
# Shared helpers for deploy-bot.sh, update-bot.sh and destroy-bot.sh. Sourced, not run.
# shellcheck disable=SC2034  # variables set here are used by the scripts that source this file

AWS_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$AWS_DIR/../.." && pwd)
DEFAULT_STACK=strike-telegram-bot
DEFAULT_REGION=ap-southeast-1
TOKEN_PARAMETER=/strike/telegram-bot-token
ALCHEMY_PARAMETER=/strike/alchemy-api-key
SEED_PARAMETER=/strike/telegram-bot-state-seed
LOG_GROUP=/strike/telegram-bot

# Progress goes to stderr, so command substitutions only capture data.
info() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# resolve_region [explicit]: --region, then AWS_REGION / AWS_DEFAULT_REGION, then the CLI profile, then
# ap-southeast-1.
resolve_region() {
  local r=${1:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}
  [ -n "$r" ] || r=$(aws configure get region 2>/dev/null || true)
  printf '%s' "${r:-$DEFAULT_REGION}"
}

require_aws() {
  command -v aws >/dev/null 2>&1 || die "the AWS CLI v2 is not installed"
  local who
  who=$(aws sts get-caller-identity --query '[Account, Arn]' --output text 2>&1) ||
    die "the AWS CLI is not logged in (aws sts get-caller-identity failed): $who"
  info "AWS account $(cut -f1 <<<"$who") as $(cut -f2 <<<"$who"), region $REGION"
}

# stack_status: the stack's status, or empty when it does not exist.
stack_status() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true
}

stack_output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

stack_parameter() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue | [0]" --output text
}

parameter_exists() {
  local name
  name=$(aws ssm describe-parameters --region "$REGION" \
    --parameter-filters "Key=Name,Option=Equals,Values=$1" --query 'Parameters[0].Name' --output text)
  [ "$name" = "$1" ]
}

# instance_id: the stack's instance, checked to be online in Systems Manager.
instance_id() {
  local id ping
  id=$(stack_output InstanceId)
  [ -n "$id" ] && [ "$id" != None ] || die "stack $STACK in $REGION has no InstanceId output"
  ping=$(aws ssm describe-instance-information --region "$REGION" \
    --filters "Key=InstanceIds,Values=$id" --query 'InstanceInformationList[0].PingStatus' --output text)
  [ "$ping" = Online ] || die "instance $id is not online in Systems Manager (status: $ping)"
  printf '%s' "$id"
}

json_string() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# run_on_instance INSTANCE_ID COMMENT TIMEOUT_SECONDS COMMAND...: run shell commands as root through SSM Run
# Command (AWS-RunShellScript), wait, print their output, and return non-zero unless they succeeded.
run_on_instance() {
  local iid=$1 comment=$2 timeout=$3 params cmd_id status="" deadline line
  shift 3
  params='{"executionTimeout":["'"$timeout"'"],"commands":['
  for line in "$@"; do params+="$(json_string "$line"),"; done
  params="${params%,}]}"
  cmd_id=$(aws ssm send-command --region "$REGION" --instance-ids "$iid" --document-name AWS-RunShellScript \
    --comment "$comment" --parameters "$params" --query Command.CommandId --output text)
  info "SSM command $cmd_id on $iid: $comment"
  deadline=$((SECONDS + timeout + 120))
  while [ "$SECONDS" -lt "$deadline" ]; do
    sleep 5
    status=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$iid" \
      --query Status --output text 2>/dev/null || echo Pending)
    case $status in
      Pending | InProgress | Delayed) ;;
      *) break ;;
    esac
  done
  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$iid" \
    --query StandardOutputContent --output text
  local err
  err=$(aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$iid" \
    --query StandardErrorContent --output text)
  [ -z "$err" ] || printf '%s\n' "$err" >&2
  [ "$status" = Success ] || { warn "SSM command $cmd_id ended with status $status"; return 1; }
}
