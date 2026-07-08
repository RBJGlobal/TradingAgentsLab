#!/usr/bin/env bash
# tools/dev-smoke.sh — backend smoke for the TradingAgentsLab engine sidecar.
#
# Run this when:
#   • starting a fresh dev session and you want to confirm the engine still works
#   • verifying that yfinance can reach Yahoo from your network
#   • diagnosing why the desktop UI isn't streaming (rule the backend out first)
#
# Usage:
#   ./tools/dev-smoke.sh              # smoke against ticker NVDA, today's date
#   ./tools/dev-smoke.sh AAPL         # specify ticker
#   ./tools/dev-smoke.sh AAPL 2026-05-08
#
# Exit codes: 0 = all checks passed, non-zero = at least one check failed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_PY="$REPO_ROOT/engine/.venv/bin/python"
TICKER="${1:-NVDA}"
TRADE_DATE="${2:-$(date +%Y-%m-%d)}"

if [[ ! -x "$ENGINE_PY" ]]; then
  echo "✗ engine venv not found at $ENGINE_PY"
  echo "  bootstrap with: $REPO_ROOT/engine/.venv/bin/pip install -r $REPO_ROOT/engine/requirements.txt"
  exit 1
fi

# Spawn engine in background; capture stdout (handshake) and stderr (uvicorn log)
# to separate temp files. We tear down on exit no matter what.
TMPDIR_SMOKE="$(mktemp -d -t tal-smoke.XXXXXX)"
HS_LOG="$TMPDIR_SMOKE/handshake.log"
ERR_LOG="$TMPDIR_SMOKE/err.log"
trap 'kill "${ENGINE_PID:-0}" 2>/dev/null || true; rm -rf "$TMPDIR_SMOKE"' EXIT

echo "── Spawning engine sidecar (cwd=$REPO_ROOT)…"
( cd "$REPO_ROOT" && "$ENGINE_PY" -m engine ) >"$HS_LOG" 2>"$ERR_LOG" &
ENGINE_PID=$!

# Wait up to 8s for the handshake line to appear.
for _ in $(seq 1 16); do
  if [[ -s "$HS_LOG" ]]; then break; fi
  sleep 0.5
done

HANDSHAKE="$(head -1 "$HS_LOG" 2>/dev/null || true)"
if [[ -z "$HANDSHAKE" ]]; then
  echo "✗ engine never emitted a handshake; stderr tail:"
  tail -20 "$ERR_LOG"
  exit 2
fi

PORT="$(echo "$HANDSHAKE" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("port",""))')"
TOKEN="$(echo "$HANDSHAKE" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("token",""))')"

if [[ -z "$PORT" || -z "$TOKEN" ]]; then
  echo "✗ handshake malformed: $HANDSHAKE"
  exit 2
fi

BASE="http://127.0.0.1:$PORT"
WS_BASE="ws://127.0.0.1:$PORT"
PASS=0; FAIL=0

check() {
  local label="$1"
  local rc="$2"
  if [[ "$rc" -eq 0 ]]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label"
    FAIL=$((FAIL + 1))
  fi
}

echo "── Engine handshake: port=$PORT token=…${TOKEN: -8}"

# Health: 401 without bearer
echo "── /health"
status="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")"
[[ "$status" == "401" ]]
check "401 without bearer" $?

# Health: 200 with bearer + has data_provider field
body="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/health")"
echo "$body" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d.get("ok") is True and "data_provider" in d' >/dev/null
check "200 with bearer + has data_provider" $?

# CORS preflight
echo "── /analyze CORS preflight from http://localhost:5173"
status="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS \
  -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" \
  "$BASE/analyze")"
[[ "$status" == "200" ]]
check "CORS preflight returns 200" $?

# /analyze stub
echo "── /analyze"
body="$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -X POST -d "{\"ticker\":\"$TICKER\",\"trade_date\":\"$TRADE_DATE\"}" \
  "$BASE/analyze")"
echo "$body" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d.get("ok") is True and d["decision"]["stance"] == "neutral"' >/dev/null
check "/analyze returns HOLD stub" $?

# /data/summary real data
echo "── /data/summary?ticker=$TICKER&trade_date=$TRADE_DATE"
body="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/data/summary?ticker=$TICKER&trade_date=$TRADE_DATE")"
echo "$body" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["ticker"] and d["last_close"] > 0 and d["sessions"] >= 1' >/dev/null
check "real OHLCV summary returned" $?

# /data/summary 404 on bogus ticker
status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$BASE/data/summary?ticker=ZZZZZZZZ&trade_date=$TRADE_DATE")"
[[ "$status" == "404" ]]
check "404 on unknown ticker" $?

# /data/news
echo "── /data/news?ticker=$TICKER"
body="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/data/news?ticker=$TICKER&limit=3")"
echo "$body" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["ticker"] and isinstance(d["headlines"], list)' >/dev/null
check "news endpoint returns list" $?

# WS /stream
echo "── WS /stream?token=…"
node -e "
const { WebSocket } = globalThis;
const ws = new WebSocket('$WS_BASE/stream?token=$TOKEN');
let count = 0; let closeCode = -1; let phases = new Set(); let hasComplete = false; let hasSummary = false;
ws.addEventListener('open', () => ws.send(JSON.stringify({ ticker: '$TICKER', trade_date: '$TRADE_DATE' })));
ws.addEventListener('message', (e) => {
  count++;
  const ev = JSON.parse(e.data);
  if (ev.type === 'data.summary') hasSummary = true;
  if (ev.type === 'agent.message' && ev.phase) phases.add(ev.phase);
  if (ev.type === 'session.complete') hasComplete = true;
});
ws.addEventListener('close', (e) => {
  closeCode = e.code;
  console.log(JSON.stringify({ count, closeCode, phases: [...phases], hasSummary, hasComplete }));
});
setTimeout(() => { try { ws.close(); } catch(_){} }, 14000);
" > "$TMPDIR_SMOKE/ws.json" 2>"$TMPDIR_SMOKE/ws.err" || true

if [[ -s "$TMPDIR_SMOKE/ws.json" ]]; then
  python3 - <<PY
import json, sys
data = json.load(open("$TMPDIR_SMOKE/ws.json"))
ok = (
    data["count"] >= 16 and
    data["closeCode"] == 1000 and
    set(data["phases"]) >= {"analysts", "researchers", "trader", "risk"} and
    data["hasSummary"] and
    data["hasComplete"]
)
sys.exit(0 if ok else 1)
PY
  check "WS streams full debate, all 4 phases, clean close 1000" $?
  cat "$TMPDIR_SMOKE/ws.json"
else
  check "WS streams full debate, all 4 phases, clean close 1000" 1
  echo "    ws.err: $(cat "$TMPDIR_SMOKE/ws.err")"
fi

# Watchlist round-trip: clean state, add, duplicate-409, delete, missing-404.
echo "── /watchlist"
WL_TICKER="WLSMOKE"
# Best-effort cleanup in case the previous run left state behind.
curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/watchlist/$WL_TICKER"

status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST -d "{\"ticker\":\"$WL_TICKER\"}" "$BASE/watchlist")"
[[ "$status" == "200" ]]
check "POST /watchlist accepts a new ticker" $?

status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -X POST -d "{\"ticker\":\"$WL_TICKER\"}" "$BASE/watchlist")"
[[ "$status" == "409" ]]
check "POST /watchlist returns 409 on duplicate" $?

body="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/watchlist")"
echo "$body" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); rows=d['watchlist']; assert any(r['ticker']=='$WL_TICKER' for r in rows)" >/dev/null
check "GET /watchlist contains the ticker we added" $?

status="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  -H "Authorization: Bearer $TOKEN" "$BASE/watchlist/$WL_TICKER")"
[[ "$status" == "200" ]]
check "DELETE /watchlist/{ticker} returns 200" $?

status="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE \
  -H "Authorization: Bearer $TOKEN" "$BASE/watchlist/$WL_TICKER")"
[[ "$status" == "404" ]]
check "second DELETE returns 404" $?

# Sessions endpoints — exercised after the WS stream above wrote a row.
echo "── /sessions"
body="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions")"
echo "$body" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert isinstance(d.get("sessions"), list) and len(d["sessions"]) >= 1' >/dev/null
check "/sessions list returns at least the session we just wrote" $?

# Round-trip: get id, fetch detail, delete, verify 404.
SID="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["sessions"][0]["id"])' 2>/dev/null || true)"
if [[ -n "$SID" ]]; then
  body="$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID")"
  echo "$body" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert isinstance(d.get("events"), list) and len(d["events"]) >= 1' >/dev/null
  check "/sessions/{id} returns full detail with events list" $?

  status="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID")"
  [[ "$status" == "200" ]]
  check "DELETE /sessions/{id} returns 200" $?

  status="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/sessions/$SID")"
  [[ "$status" == "404" ]]
  check "deleted session returns 404 on subsequent fetch" $?
else
  check "/sessions/{id} round-trip" 1
fi

echo ""
echo "── Result: $PASS passed, $FAIL failed"
exit $((FAIL > 0))
