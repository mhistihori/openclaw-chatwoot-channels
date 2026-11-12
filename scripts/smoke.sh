#!/usr/bin/env bash
# End-to-end check against the dev stack: a "customer" writes through the Chatwoot public API,
# then we watch for the bot's reply (or, with no model key, the handoff to a human).
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
[ -f .data/seed.json ] || { echo "run scripts/dev-up.sh first" >&2; exit 1; }

PORT="${CHATWOOT_PORT:-3100}"
BASE="http://localhost:${PORT}"
field() { node -e 'const s=JSON.parse(require("fs").readFileSync(".data/seed.json","utf8")); console.log(s[process.argv[1]])' "$1"; }
ACCOUNT="$(field account_id)"; IDENT="$(field inbox_identifier)"; TOKEN="$(field api_token)"
MESSAGE="${1:-Halo, saya mau tanya status pesanan saya}"

echo "-> creating a customer and a conversation"
CONTACT="$(curl -fsS -X POST "$BASE/public/api/v1/inboxes/$IDENT/contacts" -H 'content-type: application/json' -d '{"name":"Smoke Test"}')"
SOURCE="$(printf '%s' "$CONTACT" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).source_id)')"
CONV="$(curl -fsS -X POST "$BASE/public/api/v1/inboxes/$IDENT/contacts/$SOURCE/conversations" -H 'content-type: application/json' -d '{}')"
CONV_ID="$(printf '%s' "$CONV" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).id)')"

echo "-> customer says: $MESSAGE   (conversation #$CONV_ID)"
curl -fsS -X POST "$BASE/public/api/v1/inboxes/$IDENT/contacts/$SOURCE/conversations/$CONV_ID/messages" \
  -H 'content-type: application/json' -d "$(node -e 'console.log(JSON.stringify({content:process.argv[1]}))' "$MESSAGE")" >/dev/null

echo "-> waiting for the bot (up to 90s)"
for i in $(seq 1 45); do
  sleep 2
  RESP="$(curl -fsS "$BASE/api/v1/accounts/$ACCOUNT/conversations/$CONV_ID/messages" -H "api_access_token: $TOKEN")"
  SUMMARY="$(printf '%s' "$RESP" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const msgs = (r.payload || []).filter(m => m.message_type === 1 || m.private);
    console.log(JSON.stringify(msgs.map(m => ({ private: m.private, content: m.content }))));
  ')"
  if [ "$SUMMARY" != "[]" ]; then
    STATUS="$(curl -fsS "$BASE/api/v1/accounts/$ACCOUNT/conversations/$CONV_ID" -H "api_access_token: $TOKEN" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).status)')"
    echo "-> bot activity detected. conversation status: $STATUS"
    printf '%s\n' "$SUMMARY" | node -e 'for (const m of JSON.parse(require("fs").readFileSync(0,"utf8"))) console.log((m.private ? "   [private note] " : "   [reply] ") + m.content)'
    exit 0
  fi
done
echo "no bot activity after 90s. Check: docker compose logs openclaw-gateway chatwoot-sidekiq" >&2
exit 1
