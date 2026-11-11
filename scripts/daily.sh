#!/bin/zsh
# One scheduled run: the reference agent forecasts fixtures it has not forecast yet,
# then the verifier re-runs every receipt that nobody has re-run.
#
#   scripts/daily.sh            run from a clone of this repo, with the agent keys in data/
#
# Settings (environment): AGON_URL (default https://agon.nerom.site), AGON_DAILY_LIMIT (forecasts per run, default 6),
# AGON_REE_CPUS (processor cores for the container), AGON_PULL=1 (update the clone before running).
# Needs Docker Desktop and node on PATH. Starts Docker if it is not running and stops it again afterwards.

set -u
cd "$(dirname "$0")/.." || exit 1
BASE=${AGON_URL:-https://agon.nerom.site}
LIMIT=${AGON_DAILY_LIMIT:-6}
say() { echo "$(date -u +%FT%TZ) $*"; }

# One run at a time. A stale lock (its process is gone) is taken over.
LOCK=data/daily.lock
mkdir -p data
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then say "another run is still going, skipping"; exit 0; fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

say "run starts · $BASE · up to $LIMIT forecasts"

if [ "${AGON_PULL:-0}" = 1 ]; then
  before=$(git rev-parse HEAD)
  if git pull -q --ff-only; then
    after=$(git rev-parse HEAD)
    if [ "$before" != "$after" ]; then
      say "updated to $(git rev-parse --short HEAD)"
      git diff --name-only "$before" "$after" | grep -q '^package-lock.json$' && npm ci --silent
    fi
  else
    say "could not update the clone, running what is here"
  fi
fi

started_docker=0
if ! docker info >/dev/null 2>&1; then
  say "starting Docker"
  started_docker=1
  docker desktop start >/dev/null 2>&1 || open -ga Docker
  for i in {1..60}; do docker info >/dev/null 2>&1 && break; sleep 5; done
fi
if ! docker info >/dev/null 2>&1; then say "Docker did not come up, nothing was run"; exit 1; fi

# caffeinate keeps the machine from idle-sleeping in the middle of a model run.
caffeinate -i node scripts/reference-agent.ts "$BASE" --limit "$LIMIT"
caffeinate -i node scripts/verifier.ts "$BASE" --limit $((LIMIT * 2))

if [ "$started_docker" = 1 ]; then say "stopping Docker again"; docker desktop stop >/dev/null 2>&1; fi
say "run ends"
