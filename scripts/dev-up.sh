#!/usr/bin/env bash
# Brings up the local dev stack: Chatwoot -> seed -> OpenClaw gateway with this plugin.
# Idempotent. Secrets are generated into .env (gitignored); Chatwoot admin credentials
# land in .data/chatwoot-admin.txt (gitignored, mode 600) and are never printed.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

mkdir -p .data/openclaw .data/plugin

# 1. .env with generated secrets
[ -f .env ] || cp .env.example .env
fill() { # fill KEY <generator>: set KEY only when it is empty
  local key="$1" value="$2"
  if ! grep -Eq "^${key}=.+" .env; then
    if grep -Eq "^${key}=" .env; then
      sed -i.bak -E "s|^${key}=.*|${key}=${value}|" .env && rm -f .env.bak
    else
      printf '%s=%s\n' "$key" "$value" >> .env
    fi
  fi
}
fill SECRET_KEY_BASE "$(openssl rand -hex 64)"
fill POSTGRES_PASSWORD "$(openssl rand -hex 16)"
fill REDIS_PASSWORD "$(openssl rand -hex 16)"
fill OPENCLAW_GATEWAY_TOKEN "$(openssl rand -hex 24)"
chmod 600 .env

set -a; . ./.env; set +a
CHATWOOT_PORT="${CHATWOOT_PORT:-3100}"

# 2. stage the plugin (source only, no node_modules: the gateway provides its own SDK)
rm -rf .data/plugin && mkdir -p .data/plugin
cp -R index.ts setup-entry.ts src openclaw.plugin.json package.json .data/plugin/

# 3. Chatwoot
echo "-> starting Chatwoot (first run pulls images and migrates the database; this takes a few minutes)"
docker compose up -d postgres redis chatwoot-prepare chatwoot-rails chatwoot-sidekiq

echo "-> waiting for Chatwoot on http://localhost:${CHATWOOT_PORT}"
for i in $(seq 1 120); do
  if curl -fsS "http://localhost:${CHATWOOT_PORT}/api" >/dev/null 2>&1; then ready=1; break; fi
  sleep 3
done
[ "${ready:-0}" = 1 ] || { echo "Chatwoot did not become ready; see: docker compose logs chatwoot-rails" >&2; exit 1; }

# 4. seed
echo "-> seeding Chatwoot"
SEED_OUT="$(docker compose exec -T chatwoot-rails bundle exec rails runner /seed/seed.rb 2>&1)" || { echo "$SEED_OUT" >&2; exit 1; }
LINE="$(printf '%s\n' "$SEED_OUT" | grep '^SEED_RESULT=' | tail -n1 | sed 's/^SEED_RESULT=//')"
[ -n "$LINE" ] || { echo "seed produced no result:" >&2; echo "$SEED_OUT" >&2; exit 1; }

printf '%s' "$LINE" | node -e '
  const fs = require("fs");
  const s = JSON.parse(fs.readFileSync(0, "utf8"));
  const { admin_password, admin_email, ...rest } = s;
  fs.writeFileSync(".data/seed.json", JSON.stringify(rest, null, 2), { mode: 0o600 });
  if (admin_password) {
    fs.writeFileSync(".data/chatwoot-admin.txt", `email: ${admin_email}\npassword: ${admin_password}\n`, { mode: 0o600 });
  }
'

# 5. OpenClaw
node scripts/render-openclaw-config.mjs
echo "-> starting the OpenClaw gateway"
# --no-deps matters: recreating the gateway must not recreate Redis, or Sidekiq exits and
# Chatwoot's webhook jobs pile up with no worker.
docker compose --profile gateway up -d mock-llm
docker compose --profile gateway up -d --force-recreate --no-deps openclaw-gateway
docker compose up -d chatwoot-sidekiq

echo "-> waiting for the gateway to start the chatwoot channel"
for i in $(seq 1 60); do
  if docker compose logs --no-color openclaw-gateway 2>&1 | grep -q "\[chatwoot\] \[default\] starting account"; then up=1; break; fi
  sleep 2
done
[ "${up:-0}" = 1 ] || { echo "gateway did not start the channel; see: docker compose logs openclaw-gateway" >&2; exit 1; }
sleep 3 # the agent database finishes its background preparation just after the listener binds

cat <<EOF

Stack is up.
  Chatwoot:  http://localhost:${CHATWOOT_PORT}   (admin login in .data/chatwoot-admin.txt)
  OpenClaw:  http://localhost:${OPENCLAW_PORT:-18789}   (gateway token in .env)
  Logs:      docker compose logs -f openclaw-gateway
  Smoke:     scripts/smoke.sh
EOF
