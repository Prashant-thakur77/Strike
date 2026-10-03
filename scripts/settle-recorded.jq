# Is a vault's settle run already done? Used by scripts/weekly-agent.sh and agent.yml's agent #2 step:
#   jq -s -e -f scripts/settle-recorded.jq --arg v <vault, lowercase> --arg d <today> --arg w <7 days ago> <dir>/*.json
# True (exit 0) when the vault's records include a settlement recorded today, or when its newest record is a "skipped"
# settle record (no live series, no settlement in the last 7 days) from the last 7 days: nothing has happened to the
# vault since, so a second run would only write the same record again. A stopped attempt counts for neither.
[.[] | select(((.vault.address // "") | ascii_downcase) == $v)] as $r
| any($r[]; .action == "settle" and .result.status == "settled" and .date == $d)
  or (($r | sort_by(.chainTimeIso) | last) as $l
      | $l != null and $l.action == "settle" and $l.result.status == "skipped" and $l.date >= $w)
