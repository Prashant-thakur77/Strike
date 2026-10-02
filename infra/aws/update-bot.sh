#!/bin/bash
# Updates the bot on its EC2 instance to the latest commit of a branch or tag, through SSM Run Command (no SSH):
# git fetch and reset on the instance, then infra/aws/instance/install.sh (pnpm install, unit and wrapper,
# restart), which waits until the bot reports that it is running. State and subscribers are kept.
#
#   infra/aws/update-bot.sh                    # the stack's RepoRef (main)
#   infra/aws/update-bot.sh --ref v0.9.1       # a tag or another branch
#   infra/aws/update-bot.sh --os-updates       # also apply Amazon Linux updates
#   infra/aws/update-bot.sh --restart-only     # re-read the SSM secrets (after a token rotation) and restart
#
# Options: --region R, --stack NAME (default strike-telegram-bot), --ref REF, --os-updates, --restart-only
set -euo pipefail
# shellcheck source=infra/aws/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

region_arg="" STACK=$DEFAULT_STACK ref="" os_updates="" restart_only=false
while [ $# -gt 0 ]; do
  case $1 in
    --region) region_arg=$2 && shift ;;
    --stack) STACK=$2 && shift ;;
    --ref) ref=$2 && shift ;;
    --os-updates) os_updates=--os-updates ;;
    --restart-only) restart_only=true ;;
    -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' && exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

REGION=$(resolve_region "$region_arg")
require_aws
[ -n "$(stack_status)" ] || die "stack $STACK does not exist in $REGION (deploy it with infra/aws/deploy-bot.sh)"
iid=$(instance_id)

if $restart_only; then
  run_on_instance "$iid" "Strike bot: restart" 900 \
    'systemctl restart strike-bot.service' \
    'sleep 20' \
    'systemctl is-active strike-bot.service' \
    'tail -n 5 /var/log/strike-bot/bot.log'
  exit
fi

[ -n "$ref" ] || ref=$(stack_parameter RepoRef)
[[ $ref =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid ref: $ref"
info "updating the bot on $iid to $ref"
# shellcheck disable=SC2016  # these $(...) run on the instance
run_on_instance "$iid" "Strike bot: update to $ref" 1800 \
  'set -euo pipefail' \
  'export HOME=/root' \
  'cd /opt/strike/repo' \
  "git fetch --quiet --depth 1 origin '$ref'" \
  'git reset --quiet --hard FETCH_HEAD' \
  'echo "repository at $(git log -1 --format="%h %s")"' \
  "./infra/aws/instance/install.sh $os_updates"
info "done. Logs: aws logs tail $LOG_GROUP --region $REGION --follow"
