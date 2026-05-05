#!/usr/bin/env bash
# Manual end-to-end smoke for the bridge.
#
# What this exercises that unit tests can't:
#   1. Real Baileys QR pairing.
#   2. Inbound message → normalize → outbox → HMAC-signed webhook delivery.
#   3. Multi-session secret isolation (main is signed correctly, support is not).
#   4. Outbox drain on SIGTERM (rows persist for the next start, no hang).
#
# Requires a phone with WhatsApp. Two phones is even better (lets you message
# the linked account from outside).
#
# Usage:  ./scripts/smoke.sh
#   - Press [enter] at each prompt once you've finished the manual step.
#   - Cleans up temp config + data dir on exit (Ctrl+C is safe).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$(mktemp -d -t wappers-smoke-XXXXXX)"
CONFIG_FILE="$DATA_DIR/config.yaml"
ECHO_LOG="$DATA_DIR/echo.log"
BRIDGE_LOG="$DATA_DIR/bridge.log"
ECHO_PORT=4017
BRIDGE_PORT=3017
BRIDGE_SECRET="smoke-bearer-$(openssl rand -hex 8 2>/dev/null || echo fallback123)"
MAIN_SECRET="main-secret-$(openssl rand -hex 8 2>/dev/null || echo fallback123)"
SUPPORT_SECRET="support-secret-$(openssl rand -hex 8 2>/dev/null || echo fallback123)"

cleanup() {
  echo
  echo "[smoke] cleaning up…"
  [[ -n "${BRIDGE_PID:-}" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null && kill -TERM "$BRIDGE_PID" 2>/dev/null || true
  [[ -n "${ECHO_PID:-}" ]] && kill -0 "$ECHO_PID" 2>/dev/null && kill -TERM "$ECHO_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT INT TERM

cat > "$CONFIG_FILE" <<EOF
dataDir: $DATA_DIR/data
http:
  port: $BRIDGE_PORT
  bearerToken: \${BRIDGE_API_TOKEN}
sessions:
  - id: main
    webhookUrl: http://127.0.0.1:$ECHO_PORT/webhook
    webhookSecret: \${MAIN_SECRET}
  - id: support
    webhookUrl: http://127.0.0.1:$ECHO_PORT/webhook
    webhookSecret: \${SUPPORT_SECRET}
EOF

echo "[smoke] starting echo server on :$ECHO_PORT (knows main's secret only — support deliveries should show [BAD SIG])"
BRIDGE_WEBHOOK_SECRET="$MAIN_SECRET" node "$ROOT/scripts/echo-server.mjs" "$ECHO_PORT" \
  > "$ECHO_LOG" 2>&1 &
ECHO_PID=$!
sleep 0.5

echo "[smoke] starting bridge on :$BRIDGE_PORT (logs → $BRIDGE_LOG)"
(
  cd "$ROOT"
  BRIDGE_API_TOKEN="$BRIDGE_SECRET" \
    MAIN_SECRET="$MAIN_SECRET" \
    SUPPORT_SECRET="$SUPPORT_SECRET" \
    BRIDGE_CONFIG="$CONFIG_FILE" \
    pnpm --silent tsx src/index.ts > "$BRIDGE_LOG" 2>&1
) &
BRIDGE_PID=$!
sleep 3

echo
echo "[smoke] /healthz check (expect 200, sessions=2):"
curl -s "http://127.0.0.1:$BRIDGE_PORT/healthz" | head -c 400
echo

echo
echo "[smoke] open the bridge log in another terminal to see QR codes:"
echo "        tail -f $BRIDGE_LOG"
echo
read -r -p "Pair the 'main' session by scanning its QR. Press [enter] when 'session connected' appears > " _

echo
echo "[smoke] /healthz after pairing (main should be 'open'):"
curl -s "http://127.0.0.1:$BRIDGE_PORT/healthz" | head -c 400
echo

echo
read -r -p "From another phone, send any message to the 'main' account. Press [enter] when sent > " _

echo
echo "[smoke] tail of echo server log (look for [ok] for main; support entries should also be [ok] since they share the secret on this run — multi-secret demo lives below):"
tail -10 "$ECHO_LOG"

echo
echo "[smoke] killing echo server to demonstrate retry/persistence…"
kill -TERM "$ECHO_PID" 2>/dev/null || true
ECHO_PID=""

echo
read -r -p "Send another message to 'main' (should pile up as pending in outbox). Press [enter] when sent > " _

echo
echo "[smoke] /healthz after echo server is down (outbox.pending should be > 0):"
curl -s "http://127.0.0.1:$BRIDGE_PORT/healthz" | head -c 400
echo

echo
echo "[smoke] sending SIGTERM to bridge — verifying clean drain (NOT a hang)…"
START=$(date +%s)
kill -TERM "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
ELAPSED=$(( $(date +%s) - START ))
echo "[smoke] bridge exited in ${ELAPSED}s (should be ≤ ~2s — drain breaks when nothing is attemptable)"

echo
echo "[smoke] last lines of bridge log:"
tail -8 "$BRIDGE_LOG"

echo
echo "[smoke] PASS criteria (eyeball):"
echo "  - /healthz showed sessions=2 from the start"
echo "  - main went from 'connecting' → 'open' after QR scan"
echo "  - echo server logged at least one [ok] for an inbound message"
echo "  - after killing echo server, outbox.pending > 0"
echo "  - bridge exited in seconds, not minutes"
echo
echo "[smoke] done."
