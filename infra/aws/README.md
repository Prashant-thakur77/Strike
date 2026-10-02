# Strike Telegram bot on AWS

Infrastructure as code for running [@strike_options_bot](https://t.me/strike_options_bot) ([`bots/telegram`](../../bots/telegram/README.md)) on one small EC2 instance, instead of a laptop.

Status (2 October 2026): template and scripts ready, linted and tested locally; not deployed yet. The bot still runs on the owner's laptop.

| File                                                         | What it is                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [`telegram-bot.yaml`](telegram-bot.yaml)                     | CloudFormation template: network, security group, IAM role, log group, the instance and its first-boot script                     |
| [`deploy-bot.sh`](deploy-bot.sh)                             | Preflight, secrets into SSM Parameter Store, state hand-over from the local bot, `aws cloudformation deploy`, wait for the bot    |
| [`update-bot.sh`](update-bot.sh)                             | `git pull` and restart on the instance through SSM Run Command (or `--restart-only`, `--os-updates`)                              |
| [`destroy-bot.sh`](destroy-bot.sh)                           | Delete the stack; `--save-state` copies the subscribers back first, `--delete-parameters` removes the secrets                     |
| [`instance/install.sh`](instance/install.sh)                 | Runs on the instance (first boot and every update): swap, packages, CloudWatch agent, Node, `pnpm install`, systemd unit, restart |
| [`instance/strike-bot.service`](instance/strike-bot.service) | The systemd unit: unprivileged, sandboxed, `Restart=always`, output to `/var/log/strike-bot/bot.log`                              |
| [`instance/strike-bot-env`](instance/strike-bot-env)         | Reads the token (and Alchemy key) from SSM before every start into a root-only file on tmpfs                                      |
| [`test/instance-test.sh`](test/instance-test.sh)             | Local test of the start path with a fake `aws` and a fake Telegram API                                                            |

## What it creates, and why

All in one stack (default name `strike-telegram-bot`), tagged `Project=Strike`, in `ap-southeast-1` unless told otherwise.

| Resource                                 | Choice                                                                                                                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EC2 instance                             | `t4g.nano` (2 vCPU Graviton, 0.5 GiB), Amazon Linux 2023 arm64 from the public SSM parameter. The bot is one Node process of about 130 MB; a 1 GB swap file covers `pnpm install`.                                                                       |
| CPU credits                              | `standard`: CPU is capped at the baseline instead of billing surplus credits, so a crash loop cannot run up a bill. The first boot is slower for it (10 to 25 minutes in total). `--cpu-credits unlimited` to change.                                    |
| Root volume                              | 8 GiB gp3, encrypted, deleted with the instance. Holds the bot's state file (`/var/lib/strike-bot/state-<chain>.json`).                                                                                                                                  |
| VPC, public subnet, internet gateway     | A small VPC of its own (10.73.0.0/24), so the stack does not depend on a default VPC. The instance has a public IPv4 address for outbound traffic only: GitHub has no IPv6, and a NAT gateway would cost ten times more.                                 |
| Security group                           | No inbound rules at all. Outbound TCP 443 only (Telegram, the RPC, GitHub, nodejs.org, npm, Amazon Linux repositories, AWS endpoints). DNS, NTP and instance metadata are link-local and not filtered.                                                   |
| No SSH key                               | Access is Session Manager (`aws ssm start-session`), logged and gated by IAM. Updates use SSM Run Command.                                                                                                                                               |
| IMDSv2 required                          | `MetadataOptions: HttpTokens: required`, hop limit 1.                                                                                                                                                                                                    |
| IAM role                                 | `AmazonSSMManagedInstanceCore` (Session Manager, Run Command), `ssm:GetParameter` on the bot's three parameters with an explicit deny on every other parameter, write access to its own log group, and `cloudformation:SignalResource` on its own stack. |
| SSM parameters (made by `deploy-bot.sh`) | SecureString `/strike/telegram-bot-token` (required) and `/strike/alchemy-api-key` (optional), encrypted with the AWS-managed `aws/ssm` key. `/strike/telegram-bot-state-seed` exists only during a first deploy.                                        |
| CloudWatch Logs                          | Group `/strike/telegram-bot`, 14-day retention, streams `<instance-id>/bot`, `/bootstrap` and `/install`, shipped by the CloudWatch agent. Logs only, no custom metrics (those are billed per metric).                                                   |
| Creation policy                          | The stack completes only when the bot on the instance has printed its startup line (token, RPC and state file all worked). A failed first boot signals failure; `--disable-rollback` keeps the resources to inspect.                                     |

How the instance starts: the user-data (no secrets in it) writes `/etc/strike-bot/bot.conf` (region, chain id, RPC URL, parameter names, Node version), installs git, clones the repository at `RepoRef` (shallow) to `/opt/strike/repo` and runs [`instance/install.sh`](instance/install.sh). That script adds the swap file, installs the CloudWatch agent and logrotate, installs Node 22 from nodejs.org after checking it against the release's `SHASUMS256.txt`, creates the `strike-bot` system user, runs `pnpm install --frozen-lockfile --prod --filter "@strike/telegram-bot..."` (the bot and the SDK only, production dependencies), writes the state seed if there is one, installs the unit and starts it. systemd runs `strike-bot-env` as root before each start, which reads the SecureStrings into `/run/strike-bot/secrets.env` (tmpfs, mode 0600, removed when the bot stops), and starts the bot as `strike-bot` with `node --conditions=strike-source --import tsx src/index.ts`, the same thing `pnpm --filter @strike/telegram-bot start` runs, without the two wrapper processes.

## Cost

Prices for Asia Pacific (Singapore), on demand, looked up on 2 October 2026; a month is 730 hours.

| Item                                         | Rate                                                 | Bot's use                                                     |       Per month |
| -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- | --------------: |
| EC2 `t4g.nano`, Linux                        | $0.0053 per hour                                     | always on                                                     |           $3.87 |
| Public IPv4 address                          | $0.005 per hour                                      | one, always on                                                |           $3.65 |
| EBS gp3                                      | $0.096 per GB-month                                  | 8 GB (3,000 IOPS and 125 MB/s are included)                   |           $0.77 |
| CloudWatch Logs                              | $0.70 per GB ingested, $0.03 per GB-month            | a few MB a month (about 2 KB per 30 minutes on a bad network) |         < $0.01 |
| SSM Parameter Store                          | standard parameters and standard throughput are free | two or three SecureStrings, read at each start                |              $0 |
| KMS (`aws/ssm` AWS-managed key)              | no key charge; 20,000 requests a month free          | a few decrypts per restart                                    |              $0 |
| Session Manager, Run Command, CloudFormation | free                                                 |                                                               |              $0 |
| Data transfer out                            | first 100 GB a month free                            | RPC and Telegram requests, well under 1 GB                    |              $0 |
| **Total**                                    |                                                      |                                                               | **about $8.29** |

About $0.27 a day, $99.50 a year. AWS promotional credits normally apply to every line here (EC2, EBS, VPC public IPv4, CloudWatch), so the owner's credits cover it; the credit's terms are under Billing, Credits. With `standard` CPU credits there is no surplus-credit charge. Ways to pay less:

- `--instance-type t4g.small`: AWS's T4g free trial gives 750 hours a month of `t4g.small` at no charge through 31 December 2026 (offered to new and existing accounts; the volume and the IPv4 address are still billed; Billing, Free Tier shows whether the account gets it), so until then the total is about $4.42 a month, with 2 GiB of memory. From 2027 a `t4g.small` costs four times the nano rate, so switch back with `--instance-type t4g.nano`.
- Accounts in their first 12 months of the legacy Free Tier get 750 hours of public IPv4 a month free.

The figures come from AWS's published on-demand prices as listed by price trackers ([t4g.nano](https://aws-pricing.com/t4g.nano.html), [Singapore region](https://aws-pricing.com/ap-southeast-1.html)), [EBS pricing](https://aws.amazon.com/ebs/pricing/), the [public IPv4 charge](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/), CloudWatch pricing for Singapore and the [T4g free trial](https://aws.amazon.com/ec2/instance-types/t4/) ([checked against a bill](https://dev.classmethod.jp/en/articles/ec2-t4g-small-free-tier-2026/)). aws.amazon.com itself was not reachable from the machine that wrote this, so confirm the instance price once logged in:

```sh
aws pricing get-products --region us-east-1 --service-code AmazonEC2 --output text \
  --filters Type=TERM_MATCH,Field=instanceType,Value=t4g.nano Type=TERM_MATCH,Field=regionCode,Value=ap-southeast-1 \
    Type=TERM_MATCH,Field=operatingSystem,Value=Linux Type=TERM_MATCH,Field=tenancy,Value=Shared \
    Type=TERM_MATCH,Field=preInstalledSw,Value=NA Type=TERM_MATCH,Field=capacitystatus,Value=Used \
  --query 'PriceList[0]' | grep -o '"pricePerUnit":{"USD":"[0-9.]*"}'
```

## Deploy

Needs the AWS CLI v2, logged in (`aws login --region ap-southeast-1`, or SSO, or keys), and the bot token in `bots/telegram/.env`. The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) is only needed for a shell on the instance.

1. Stop the local bot. Telegram allows one long-polling client per token, and the bot saves its state on SIGTERM. `deploy-bot.sh` refuses to create the stack while a local bot process is running and prints the `kill -TERM` command for it.
2. Deploy, from the repository root:

   ```sh
   infra/aws/deploy-bot.sh --i-stopped-the-local-bot
   ```

   It prints the account and region, stores `TELEGRAM_BOT_TOKEN` from `bots/telegram/.env` (and `ALCHEMY_API_KEY` from the repository's `.env` or the environment, if set) as SecureStrings without echoing them (the value goes through a 0600 temporary file, not the command line), uploads `bots/telegram/data/state-46630.json` as the state seed so the subscribers and the log cursor carry over, deploys the stack and waits for the bot to start (10 to 25 minutes), deletes the seed, and prints the last log lines and the commands below.

   Options: `--region`, `--instance-type`, `--cpu-credits`, `--chain-id`, `--rpc-url` (no keys in it; it is visible in the stack's parameters), `--repo-ref`, `--state-file` or `--no-state`, `--update-secrets` (`--help` lists them).

3. Send the bot `/status` in Telegram.

Running `deploy-bot.sh` again on an existing stack updates the infrastructure (for example `--instance-type t4g.small`, which stops and starts the instance and keeps its disk). It pins the instance's current AMI, so a newer Amazon Linux release never replaces the instance by surprise; `--latest-ami` moves to the newest one and replaces the instance, which starts its state over (save it first with `destroy-bot.sh --save-state`, or copy it over Session Manager). The first-boot script runs once per instance, so a new `--chain-id`, `--rpc-url` or `--repo-ref` on an existing stack does not reach the bot: edit `/etc/strike-bot/bot.conf` over Session Manager and restart, or destroy and deploy again.

## Operate

```sh
aws logs tail /strike/telegram-bot --region ap-southeast-1 --follow              # bot, bootstrap and install logs
infra/aws/update-bot.sh                                                           # git pull main on the instance, pnpm install, restart
infra/aws/update-bot.sh --ref v0.9.1                                              # a tag or another branch
infra/aws/update-bot.sh --restart-only                                            # restart (re-reads the SSM secrets)
infra/aws/update-bot.sh --os-updates                                              # also dnf upgrade --releasever=latest
aws ssm start-session --region ap-southeast-1 --target <instance-id>             # shell, then: sudo systemctl status strike-bot
```

`update-bot.sh` waits until the bot prints its startup line again and shows the install output. The state file and subscribers are kept across updates and restarts.

Rotate the bot token: `/revoke` in BotFather, put the new token in `bots/telegram/.env`, then `infra/aws/deploy-bot.sh --update-secrets` and `infra/aws/update-bot.sh --restart-only`. The same works for the Alchemy key.

## Destroy

```sh
infra/aws/destroy-bot.sh --save-state bots/telegram/data/state-46630.json   # stop the bot, copy its state home, delete the stack
infra/aws/destroy-bot.sh --delete-parameters --yes                          # also delete the SSM parameters
```

Deleting the stack removes the instance, its disk, the VPC, the role and the log group (and its logs). The SSM parameters stay unless `--delete-parameters` is given. With `--save-state`, the local bot (or the next deploy) carries on from the saved cursor and subscribers.

## Security notes

- No SSH key and no inbound security group rule: nothing on the instance accepts connections. Shell access is Session Manager, controlled by IAM and recorded in CloudTrail.
- Secrets live only in SSM Parameter Store as SecureStrings. They are not in the template, the user-data, the stack parameters, the unit file or the disk: `strike-bot-env` reads them at each start into `/run/strike-bot/secrets.env` (tmpfs, root, 0600), systemd hands them to the bot's environment, and the file is removed when the bot stops. Nothing in the scripts prints a secret, and `deploy-bot.sh` passes values to the AWS CLI through a 0600 file rather than the command line.
- `AmazonSSMManagedInstanceCore` allows `ssm:GetParameter` on all parameters in the account; the role adds an explicit deny for every parameter except the bot's three (and AWS's public ones), so the instance cannot read other secrets.
- IMDSv2 is required (session tokens, hop limit 1). Any process on the instance can still use the instance role through IMDS, which is why the role is this narrow.
- The bot runs as the unprivileged `strike-bot` user under systemd's sandbox (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, an empty capability set, `RestrictAddressFamilies`; `systemd-analyze security` rates it 3.0, "OK", on systemd 259). It can write only `/var/lib/strike-bot`. It holds no wallet key and sends no transactions.
- The root volume is encrypted (EBS default key). Node is checked against nodejs.org's `SHASUMS256.txt`; npm packages are pinned by `pnpm-lock.yaml` (`--frozen-lockfile`).
- Trust: whoever can push to the deployed branch can change what `update-bot.sh` installs, including the unit and `install.sh`, which run as root. Deploy a tag (`--repo-ref`, `update-bot.sh --ref`) to pin a reviewed commit.

## Limits

- One copy per token, and one stack per account and region (the log group name is fixed).
- The state lives on the root volume. Updates, restarts, reboots and instance type changes keep it; deleting the stack or replacing the instance (`--latest-ami`, a new `VolumeSize`) does not, so save it first.
- The template and the scripts need a `RepoRef` that contains `infra/aws/instance` (this commit or later).
- On SIGTERM the bot finishes its in-flight RPC requests before it exits; systemd waits up to 90 s, then kills it. The cursor is saved after each delivered chunk, so a kill can repeat at most one chunk of alerts and never skips one.

## Checks

```sh
pip install --target ~/.cache/cfn-lint-py cfn-lint
PYTHONPATH=~/.cache/cfn-lint-py python3 ~/.cache/cfn-lint-py/bin/cfn-lint --regions ap-southeast-1 us-east-1 -- infra/aws/telegram-bot.yaml
shellcheck -x infra/aws/*.sh infra/aws/instance/install.sh infra/aws/instance/strike-bot-env infra/aws/test/instance-test.sh
infra/aws/test/instance-test.sh
```

On 2 October 2026: cfn-lint 1.57.1 found nothing (also with `--include-checks I`); ShellCheck 0.11.0 found nothing at `-S style`; `systemd-analyze verify` accepts the unit; and `instance-test.sh` passed on Node 22.22.3 and 22.23.3. The test runs `strike-bot-env` against a fake `aws` (token and Alchemy key into a 0600 file, a missing Alchemy key accepted, a missing or malformed token refused, no secret printed), installs a fresh clone with the instance's exact `pnpm install` command (bot and SDK production dependencies only, 129 MB), then emulates the unit (ExecStartPre, the EnvironmentFile and Environment lines, ExecStart from the working directory, output to the log file) against a fake Telegram API: the bot started with the token from the fake SSM parameter, read through Alchemy first because the key reached it, kept a seeded state file, stopped cleanly on SIGTERM, and `ExecStopPost` removed the secrets file.

What only a real deploy can check: the Amazon Linux packages, the CloudWatch agent, the creation signal and the IAM policy. `deploy-bot.sh` fails the stack if the bot does not start, and keeps the resources to look at.

## Troubleshooting

- The deploy failed: `aws logs tail /strike/telegram-bot --region ap-southeast-1 --since 1h` shows the bootstrap and install streams. If the CloudWatch agent never started, `aws ec2 get-console-output --region ap-southeast-1 --latest --instance-id <id>` shows the boot log. Then `infra/aws/destroy-bot.sh` and deploy again (the seed parameter is kept for the retry).
- `409 Conflict` in the bot log: another copy is polling the same token. Stop it.
- `parameter /strike/telegram-bot-token does not exist` in the bot log: run `deploy-bot.sh` (it creates it), then `update-bot.sh --restart-only`.
- `instance ... is not online in Systems Manager`: the instance is still booting, or it cannot reach the SSM endpoints (check the security group still allows outbound 443).
