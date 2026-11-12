#!/usr/bin/env bash
# Fast inner loop: copy the current plugin source into the running dev gateway and restart only
# the gateway. Use scripts/dev-up.sh for the first run or after changing compose/config.
set -euo pipefail

cd "$(dirname "$0")/.."

# Stage the same artifact that gets installed: compiled output + manifest, no TypeScript source.
npm run build --silent
rm -rf .data/plugin && mkdir -p .data/plugin
cp -R dist openclaw.plugin.json package.json .data/plugin/

since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose --profile gateway restart openclaw-gateway >/dev/null

for _ in $(seq 1 60); do
  if docker compose logs --no-color --since "$since" openclaw-gateway 2>&1 | grep -q "\[chatwoot\] \[default\] starting account"; then
    sleep 3 # let the agent database finish its background preparation
    echo "gateway restarted with the current plugin"
    exit 0
  fi
  sleep 2
done
echo "gateway did not restart cleanly; see: docker compose logs openclaw-gateway" >&2
exit 1
