#!/bin/bash
# Installs or updates the Strike Telegram bot on an Amazon Linux 2023 instance, then (re)starts it and waits
# until it reports that it is running. Idempotent; run as root from the repository checkout:
#   - on first boot by the CloudFormation user-data (infra/aws/telegram-bot.yaml), after it cloned the repo;
#   - on every update by infra/aws/update-bot.sh (SSM Run Command), after it pulled the new commit.
#
# Usage: infra/aws/instance/install.sh [--os-updates]
#   --os-updates   also apply Amazon Linux updates (dnf upgrade --releasever=latest)
#
# Reads /etc/strike-bot/bot.conf. Holds no secrets: the bot token is read from SSM by strike-bot-env at each
# start. Output is appended to /var/log/strike-bot/install.log (shipped to CloudWatch Logs).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd "$HERE/../../.." && pwd)
CONF=/etc/strike-bot/bot.conf
BASE=/opt/strike
LOG_DIR=/var/log/strike-bot
BOT_LOG=$LOG_DIR/bot.log
STATE_DIR=/var/lib/strike-bot
BOT_USER=strike-bot
CW_CTL=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl
WAIT_SECONDS=${STRIKE_BOT_WAIT_SECONDS:-600}

os_updates=false
for arg in "$@"; do
  case $arg in
    --os-updates) os_updates=true ;;
    *) echo "unknown argument: $arg" >&2 && exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "install.sh: run as root" >&2; exit 1; }
[ -r "$CONF" ] || { echo "install.sh: $CONF is missing (the CloudFormation user-data writes it)" >&2; exit 1; }

# cloud-init and SSM Run Command do not always set HOME or a full PATH.
export HOME=${HOME:-/root}
export PATH=$BASE/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin

install -d -m 0755 "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/install.log") 2>&1

log() { printf '%s install: %s\n' "$(date -u +%FT%TZ)" "$*"; }
# conf KEY: the value of KEY in bot.conf (parsed, never sourced: values may contain shell metacharacters).
conf() { sed -n "s/^$1=//p" "$CONF" | tail -n 1; }

region=$(conf AWS_REGION)
chain_id=$(conf STRIKE_CHAIN_ID)
node_version=$(conf NODE_VERSION)
seed_parameter=$(conf STRIKE_STATE_SEED_PARAMETER)
[[ $node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "bad NODE_VERSION in $CONF: $node_version"; exit 1; }
[[ $chain_id =~ ^[0-9]+$ ]] || { log "bad STRIKE_CHAIN_ID in $CONF: $chain_id"; exit 1; }

log "repository $(git -C "$REPO_DIR" log -1 --format='%h %s' 2>/dev/null || echo "at $REPO_DIR")"

# 1 GB of swap: pnpm install and the first TypeScript compile can exceed 512 MB on a t4g.nano.
ensure_swap() {
  if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
    if [ ! -f /swapfile ]; then
      log "creating a 1 GB swap file"
      dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
    fi
    swapon /swapfile
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap defaults 0 0' >>/etc/fstab
}

ensure_packages() {
  local pkgs=(git logrotate amazon-cloudwatch-agent) missing=() p
  for p in "${pkgs[@]}"; do rpm -q "$p" >/dev/null 2>&1 || missing+=("$p"); done
  if [ ${#missing[@]} -gt 0 ]; then
    log "installing ${missing[*]}"
    dnf install -y -q --setopt=install_weak_deps=False "${missing[@]}"
  fi
  if $os_updates; then
    log "applying Amazon Linux updates"
    dnf upgrade -y -q --releasever=latest
    log "OS updated; a new kernel takes effect after a reboot (aws ssm start-session, then sudo systemctl reboot)"
  fi
}

# Bot output goes to $BOT_LOG; the CloudWatch agent ships it (and the bootstrap and install logs) to the
# /strike/telegram-bot log group; logrotate keeps the local copies small.
ensure_logs() {
  install -m 0644 "$HERE/logrotate.conf" /etc/logrotate.d/strike-bot
  systemctl enable --now logrotate.timer >/dev/null 2>&1 || true
  install -m 0644 "$HERE/cloudwatch-agent.json" /opt/aws/amazon-cloudwatch-agent/etc/strike-bot.json
  "$CW_CTL" -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/strike-bot.json >/dev/null
  log "CloudWatch agent: $("$CW_CTL" -a status | tr -d '\n ' | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')"
}

# Node from nodejs.org, checked against the release's SHASUMS256.txt.
ensure_node() {
  local arch dir tarball tmp
  case $(uname -m) in
    aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) log "unsupported architecture $(uname -m)"; return 1 ;;
  esac
  dir=$BASE/node-v$node_version-linux-$arch
  if [ ! -x "$dir/bin/node" ]; then
    log "installing Node $node_version ($arch)"
    tarball=node-v$node_version-linux-$arch.tar.xz
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 -o "$tmp/$tarball" "https://nodejs.org/dist/v$node_version/$tarball"
    curl -fsSL --retry 3 -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$node_version/SHASUMS256.txt"
    (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -)
    install -d -m 0755 "$BASE"
    tar -xJf "$tmp/$tarball" -C "$BASE"
    rm -rf "$tmp"
  fi
  ln -sfn "$dir" "$BASE/node"
  log "node $("$BASE/node/bin/node" --version)"
}

ensure_user() {
  if ! id -u "$BOT_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "$STATE_DIR" --shell /sbin/nologin "$BOT_USER"
  fi
  install -d -m 0700 -o "$BOT_USER" -g "$BOT_USER" "$STATE_DIR"
}

# Only the bot and its workspace dependency (@strike/sdk), production dependencies only. pnpm comes from
# the repository's packageManager field through corepack.
install_dependencies() {
  log "pnpm install (bot and SDK, production dependencies)"
  (
    cd "$REPO_DIR"
    export COREPACK_HOME=$BASE/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
    corepack pnpm install --frozen-lockfile --prod --filter "@strike/telegram-bot..." \
      --config.confirmModulesPurge=false --reporter=append-only
  )
}

# First start on this instance: take the subscribers and log cursor from the state seed parameter, if
# deploy-bot.sh uploaded the laptop copy's state file. An existing state file is never overwritten.
seed_state() {
  local state=$STATE_DIR/state-$chain_id.json err json count
  [ -e "$state" ] && return 0
  [ -n "$seed_parameter" ] || return 0
  err=$(mktemp)
  if json=$(aws ssm get-parameter --region "$region" --name "$seed_parameter" --with-decryption \
    --query Parameter.Value --output text 2>"$err"); then
    count=$(printf '%s' "$json" | node -e '
      const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
      if (s.chainId !== Number(process.argv[1]) || !Array.isArray(s.subscribers)) process.exit(1);
      console.log(s.subscribers.length);' "$chain_id") || { log "state seed $seed_parameter is not a state file for chain $chain_id"; rm -f "$err"; return 1; }
    (umask 077 && printf '%s\n' "$json" >"$state.seed")
    chown "$BOT_USER:$BOT_USER" "$state.seed"
    mv -f "$state.seed" "$state"
    log "seeded $state from $seed_parameter ($count subscriber(s))"
  elif grep -q ParameterNotFound "$err"; then
    log "no state seed; the bot starts with no subscribers and scans from the deploy block"
  else
    cat "$err"
    rm -f "$err"
    return 1
  fi
  rm -f "$err"
}

install_service() {
  install -m 0755 "$HERE/strike-bot-env" /usr/local/sbin/strike-bot-env
  install -m 0644 "$HERE/strike-bot.service" /etc/systemd/system/strike-bot.service
  systemctl daemon-reload
  systemctl enable strike-bot.service >/dev/null 2>&1
}

# Restart and wait for the bot's startup line ("@<bot> on chain <id> via <rpc>; ..." from bots/telegram/src/index.ts),
# which it prints once the token, the RPC and the state file all worked.
restart_and_wait() {
  local offset deadline line
  touch "$BOT_LOG"
  offset=$(stat -c %s "$BOT_LOG")
  log "restarting strike-bot"
  systemctl restart strike-bot.service
  deadline=$((SECONDS + WAIT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    line=$(tail -c "+$((offset + 1))" "$BOT_LOG" | grep -E ' on chain [0-9]+[ ;]' | tail -n 1 || true)
    if [ -n "$line" ]; then
      log "bot is up: $line"
      return 0
    fi
    sleep 5
  done
  log "the bot did not report a start within ${WAIT_SECONDS}s; recent output:"
  tail -n 30 "$BOT_LOG"
  systemctl status strike-bot.service --no-pager --lines=0 || true
  return 1
}

ensure_swap
ensure_packages
ensure_logs
ensure_node
ensure_user
install_dependencies
seed_state
install_service
restart_and_wait
