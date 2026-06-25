#!/usr/bin/env bash
# stage0-probe.sh — MCP round-trip probe for Stage 0 (loopback or bridge).
#
# Usage:
#   ./stage0-probe.sh <endpoint> <token> [session_file]
#
#   endpoint      http://127.0.0.1:12315/mcp   (Step 1e, host loopback)
#                 http://192.168.100.1:12315/mcp (Step 3, over the bridge)
#   token         Bearer token from the header API-icon -> Tokens dialog
#   session_file  where to cache the Mcp-Session-Id (default: ./stage0-sid)
#
# Env overrides:
#   PROBE_KW      searchBlocks term (default: stage0probe-kiwi). A block
#                 containing this exact text must exist in the throwaway graph
#                 for the keyword leg to return a hit (see "Risks and fallbacks"
#                 in stage0-network-de-risk.md: an empty blocks:[] proves the
#                 call path but NOT the keyword leg).
#   PAGE_UUID     a real page uuid from listPages, for the upsertNodes dry-run.
#                 If unset the dry-run still runs with a placeholder page-id and
#                 may fail validation — set it for a meaningful dry-run.
#   MAX_TIME      per-request SSE cap in seconds (default: 10). curl exit 28
#                 means "stream cut off", NOT failure — the body printed before
#                 the cap is the real response.
#
# Idempotent: reuses a cached SID if it still drives tools/call; otherwise
# DELETEs the stale session (if known) and re-initializes. This works around
# the one-shot-initialize server fragility (mcp_server.cljs:26-40 — a second
# initialize against the same running server throws "Already connected to a
# transport" and the curl hangs). See "Risks and fallbacks" in
# stage0-network-de-risk.md.
set -euo pipefail

EP="${1:?usage: $0 <endpoint> <token> [session_file]}"
TOKEN="${2:?token required}"
SID_FILE="${3:-./stage0-sid}"
PROBE_KW="${PROBE_KW:-stage0probe-kiwi}"
PAGE_UUID="${PAGE_UUID:-}"
MAX_TIME="${MAX_TIME:-10}"

AUTH=(-H "Authorization: Bearer $TOKEN"
      -H "Content-Type: application/json"
      -H "Accept: application/json, text/event-stream")

# --- session helpers -------------------------------------------------------

get_sid()   { [[ -f "$SID_FILE" ]] && cat "$SID_FILE" || true; }
store_sid() { printf '%s' "$1" > "$SID_FILE"; }

# Is the SID still live? A cheap listPages tells us; suppress all output.
sid_live() {
  local sid="$1"
  [[ -n "$sid" ]] || return 1
  curl -sS --max-time "$MAX_TIME" -X POST "$EP" \
    "${AUTH[@]}" -H "Mcp-Session-Id: $sid" \
    --data @- >/dev/null 2>&1 <<'JSON' || return 1
{"jsonrpc":"2.0","id":99,"method":"tools/call",
 "params":{"name":"listPages","arguments":{}}}
JSON
}

# DELETE a session so the server's shared Protocol._transport is freed for a
# fresh initialize (handle-delete-request, mcp_server.cljs:60 -> .close).
close_sid() {
  local sid="$1"
  [[ -n "$sid" ]] || return 0
  curl -sS -X DELETE "$EP" -H "Mcp-Session-Id: $sid" >/dev/null 2>&1 || true
}

# One initialize mints one session. -i exposes the Mcp-Session-Id header,
# which rides on the SSE response headers (bare curl -sS hides it).
# Feed the body via printf | curl --data @- so the heredoc/payload reaches curl,
# not the grep/awk/tr pipeline stages.
init_sid() {
  local body='{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"protocolVersion":"2025-03-26","capabilities":{},
           "clientInfo":{"name":"probe","version":"0"}}}'
  printf '%s' "$body" \
    | curl -sS -i --max-time "$MAX_TIME" -X POST "$EP" \
        "${AUTH[@]}" --data @- \
    | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r'
}

# --- acquire a live session ------------------------------------------------

SID="$(get_sid)"
if ! sid_live "$SID"; then
  echo ">> cached SID missing or stale; closing (if any) and re-initializing"
  close_sid "$SID"
  SID="$(init_sid)"
  if [[ -z "$SID" ]]; then
    echo "!! initialize returned no Mcp-Session-Id." >&2
    echo "   Check: token correct? endpoint reachable? server logs show" >&2
    echo "   'Initialize sessionId <uuid>' (mcp_server.cljs:37)?" >&2
    exit 1
  fi
  store_sid "$SID"
fi
echo "SID=$SID"

call() {  # call <<'JSON' ... JSON  (reads payload from stdin)
  curl -sS --max-time "$MAX_TIME" -X POST "$EP" \
    "${AUTH[@]}" -H "Mcp-Session-Id: $SID" --data @-
}

# --- the four round-trips --------------------------------------------------

echo; echo "== 1) initialize =="
echo "   (done above — SID=$SID. One initialize per server lifetime;"
echo "    the script reuses it on re-runs instead of re-initializing.)"

echo; echo "== 2) listPages =="
call <<'JSON'
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"listPages","arguments":{}}}
JSON

echo; echo "== 3) searchBlocks (searchTerm=\"$PROBE_KW\") =="
echo "   Expects a block containing \"$PROBE_KW\" in the throwaway graph."
echo "   If blocks:[] comes back, add such a block and re-run — the call path"
echo "   is proven, but the keyword leg is not until a hit returns with :block/uuid."
call <<JSON
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"searchBlocks","arguments":{"searchTerm":"$PROBE_KW"}}}
JSON

echo; echo "== 4) upsertNodes dry-run =="
if [[ -z "$PAGE_UUID" ]]; then
  echo "   (PAGE_UUID not set — running with a placeholder page-id; set PAGE_UUID"
  echo "    to a real page uuid from listPages for a meaningful dry-run.)"
fi
PAGE_ID="${PAGE_UUID:-<page-uuid-from-listPages>}"
call <<JSON
{"jsonrpc":"2.0","id":4,"method":"tools/call",
 "params":{"name":"upsertNodes","arguments":{
   "dry-run": true,
   "operations":[{"operation":"add","entityType":"block",
     "data":{"page-id":"$PAGE_ID","title":"stage0 dry-run block"}}]}}}
JSON
echo

# --- exit notes ------------------------------------------------------------
echo "Done. Exit 28 from any call just means the SSE stream was capped at"
echo "${MAX_TIME}s — the body printed above is the real response. If any call"
echo "printed no body before the cap, THAT is a real failure worth debugging."
