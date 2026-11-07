#!/usr/bin/env bash
# Run from cron on the server. Updates only this stack: pulls the repo and this compose
# file's images, then restarts what changed. Waits while a call is being recorded.
set -euo pipefail
cd "$(dirname "$0")/.."

exec 9>.update.lock
flock -n 9 || exit 0

git pull --ff-only -q
docker compose pull -q >/dev/null 2>&1

# Not configured yet: do not start a bot that would crash-loop without its token.
grep -q '^DISCORD_TOKEN=.\+' .env 2>/dev/null || exit 0

# data/ACTIVE exists while the bot is recording; ignore one older than 8 h (a crash leftover).
if [ -n "$(find data/ACTIVE -mmin -480 2>/dev/null)" ]; then
  exit 0
fi

out=$(docker compose up -d --remove-orphans 2>&1)
if grep -qE "Recreat|Creat|Started" <<<"$out"; then
  echo "$(date -Is) deployed"
  echo "$out"
fi
