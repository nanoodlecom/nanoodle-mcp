#!/usr/bin/env bash
set -euo pipefail

revision="${1:?An exact deployment revision is required}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]]

for origin in https://mcp.nanoodle.com https://near.nanoodle.com; do
  verified=false
  for ((attempt = 1; attempt <= 6; attempt++)); do
    if curl -q --proto '=https' --connect-timeout 4 --max-time 8 --max-filesize 1048576 --fail \
        --silent --show-error -H 'Cache-Control: no-cache' "$origin/version" |
      jq -es --arg revision "$revision" '
        (length == 1) and (.[0] |
        (.name == "nanoodle-mcp") and
        (.commit | type == "string" and test("^[0-9a-f]{7,40}$")) and
        (.commit as $commit | $revision | startswith($commit)))
      ' >/dev/null &&
      curl -q --proto '=https' --connect-timeout 4 --max-time 8 --max-filesize 1048576 --fail \
        --silent --show-error -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$origin/mcp" |
      jq -es '(length == 1) and (.[0] | .jsonrpc == "2.0" and .id == 1 and (.result.tools | any(.name == "run_noodle")))' >/dev/null; then
      printf 'Verified hosted MCP revision %s on %s\n' "$revision" "$origin"
      verified=true
      break
    fi
    if ((attempt < 6)); then sleep 3; fi
  done
  if [[ "$verified" != true ]]; then
    printf 'Hosted activation of %s was not verified on %s\n' "$revision" "$origin" >&2
    exit 1
  fi
done

curl -q --proto '=https' --connect-timeout 4 --max-time 15 --max-filesize 1048576 --fail \
  --silent --show-error -H 'Cache-Control: no-cache' https://mcp.nanoodle.com/rates/nano |
  jq -es '(length == 1) and (.[0] | .usable == true and (.xnoUsd | type == "number" and . > 0))' >/dev/null
printf 'Verified a usable XNO/USD rate from the live Nano checkout\n'
