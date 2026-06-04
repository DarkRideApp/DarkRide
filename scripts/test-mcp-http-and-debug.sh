#!/usr/bin/env bash
# Reproducer for the MCP-pending-at-init race (since fixed by removing
# --tools '' from ClaudeCliProvider on 2026-06-04). Two variants:
#   E. HTTP MCP — same transport AI Review uses (HTTP to DarkRide's /mcp).
#      Spins up a throwaway local HTTP MCP server so this doesn't depend on
#      DarkRide running. Reproduces the PRE-FIX behavior with --tools ''.
#   F. stdio MCP with --mcp-debug — runs the stdio variant with claude's
#      debug logging on, to see what the CLI is doing with the MCP server
#      before/during init. Also PRE-FIX behavior.
#
# These are kept as historical / regression repros — useful if a future CLI
# change re-introduces the race, or if a new automation path accidentally
# brings --tools '' back.
#
# Usage:  sudo -u darkride -s -- bash /tmp/test-mcp-http-and-debug.sh

set -u
DIR=$(mktemp -d) || { echo "[fatal] mktemp -d failed" >&2; exit 1; }
OUT_BASE=/tmp/claude-race
mkdir -p "$OUT_BASE"

# Track child PIDs we start so we always reap them, even on error
HTTP_SERVER_PID=
cleanup() {
  if [ -n "$HTTP_SERVER_PID" ] && kill -0 "$HTTP_SERVER_PID" 2>/dev/null; then
    kill "$HTTP_SERVER_PID" 2>/dev/null || true
    wait "$HTTP_SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$DIR"
}
trap cleanup EXIT

# ── HTTP MCP server (single-shot JSON-RPC over HTTP POST /mcp) ───────────
cat > "$DIR/http-mcp.js" <<'JS'
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end('not found'); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let m;
    try { m = JSON.parse(body); } catch { res.writeHead(400); res.end('bad json'); return; }
    const log = (...a) => process.stderr.write('[http-mcp] ' + a.join(' ') + '\n');
    log('method=' + (m.method || '?') + ' id=' + JSON.stringify(m.id));
    let result;
    if (m.method === 'initialize') {
      result = {
        protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'selftest-http', version: '1.0.0' },
      };
    } else if (m.method === 'tools/list') {
      result = { tools: [{ name: 'ping', description: 'Returns pong.', inputSchema: { type: 'object', properties: {} } }] };
    } else if (m.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'pong' }] };
    } else if (m.method && m.method.indexOf('notifications/') === 0) {
      res.writeHead(204); res.end(); return;
    } else if (m.id !== undefined) {
      result = {};
    }
    if (m.id !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    } else {
      res.writeHead(204); res.end();
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
JS

# ── stdio MCP (same as before) ────────────────────────────────────────────
cat > "$DIR/ping-mcp.js" <<'JS'
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{continue}
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'selftest',version:'1.0.0'}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'ping',description:'Returns pong.',inputSchema:{type:'object',properties:{}}}]}});
else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'pong'}]}});
else if(m.method&&m.method.indexOf('notifications/')===0){}
else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{}});}});
function send(o){process.stdout.write(JSON.stringify(o)+'\n')}
JS

cat > "$DIR/settings.json" <<'JSON'
{}
JSON

cat > "$DIR/parse.py" <<'PY'
import sys, json
events=[]
init=None
turns=[]
result=None
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: e=json.loads(line)
    except: continue
    et=e.get("type"); st=e.get("subtype")
    if et=="system":
        events.append(et+":"+(st or "?"))
        if st=="init": init=e
    elif et=="assistant":
        events.append("assistant")
        for b in (e.get("message",{}).get("content") or []):
            t=b.get("type")
            if   t=="text":     turns.append(("TEXT", (b.get("text") or "")[:160]))
            elif t=="tool_use": turns.append(("TOOL_USE", b.get("name")))
            elif t=="thinking": turns.append(("THINK", (b.get("thinking") or "")[:120]))
    elif et=="result":
        events.append("result")
        result=e

print(" event order:", " → ".join(events[:25]) + (" …" if len(events) > 25 else ""))
if init:
    print(" init.mcp_servers:", json.dumps(init.get("mcp_servers")))
    print(" init.tools count:", len(init.get("tools") or []))
    print(" apiKeySource:", init.get("apiKeySource"))
else:
    print(" [no init]")
print(" turns:")
for row in turns:
    print("   "+row[0]+":", *row[1:])
if not turns: print("   [none]")
if result:
    print(" result: is_error=%s num_turns=%s" % (result.get("is_error"), result.get("num_turns")))
PY

# ──── Variant E: HTTP MCP ─────────────────────────────────────────────────
echo "=================================="
echo "  E. HTTP MCP (same transport DarkRide AI Review uses)"
echo "=================================="

# Start HTTP MCP server in the background, wait for it to print its port.
PORT_FILE="$DIR/port.txt"
HTTP_SERVER_LOG="$DIR/http-server.log"
( node "$DIR/http-mcp.js" 2> "$HTTP_SERVER_LOG" ; echo "[http-mcp exited]" >> "$HTTP_SERVER_LOG" ) > "$PORT_FILE" &
HTTP_SERVER_PID=$!

# Wait up to 5s for PORT line
for i in $(seq 1 50); do
  if grep -q '^PORT=' "$PORT_FILE" 2>/dev/null; then break; fi
  sleep 0.1
done
PORT=$(grep '^PORT=' "$PORT_FILE" 2>/dev/null | head -1 | sed 's/PORT=//')
if [ -z "${PORT:-}" ]; then
  echo "[fatal] HTTP MCP server didn't print a port. Log:"
  cat "$HTTP_SERVER_LOG"
  exit 1
fi
echo "  (HTTP MCP server listening on 127.0.0.1:$PORT, pid=$HTTP_SERVER_PID)"
echo

# Quick sanity probe — can we even talk to it?
echo "  Direct probe (curl initialize):"
curl -sS --max-time 5 -X POST "http://127.0.0.1:$PORT/mcp" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' || echo "[probe failed]"
echo

cat > "$DIR/mcp-http.json" <<JSON
{"mcpServers":{"selftest":{"type":"http","url":"http://127.0.0.1:$PORT/mcp"}}}
JSON

echo "  Self-test with --tools '' (mirrors the PRE-FIX DarkRide sendMessage —"
echo "  current code no longer passes --tools '', see commit dropping it on 2026-06-04):"
echo "Call the ping tool, then reply done." \
  | timeout 90 claude --print --output-format stream-json --verbose \
      --mcp-config "$DIR/mcp-http.json" --strict-mcp-config \
      --settings "$DIR/settings.json" \
      --permission-mode bypassPermissions \
      --model sonnet --tools '' \
      > "$OUT_BASE/e.jsonl" 2> "$OUT_BASE/e.err"
python3 "$DIR/parse.py" < "$OUT_BASE/e.jsonl"
echo "  raw stream: $OUT_BASE/e.jsonl  ·  stderr: $OUT_BASE/e.err"
echo "  http server log:"
sed -n '1,40p' "$HTTP_SERVER_LOG" | sed 's/^/    /'
echo

# ──── Variant F: stdio MCP with --mcp-debug ───────────────────────────────
echo "=================================="
echo "  F. stdio MCP with --mcp-debug"
echo "=================================="

cat > "$DIR/mcp-stdio.json" <<JSON
{"mcpServers":{"selftest":{"command":"node","args":["$DIR/ping-mcp.js"]}}}
JSON

echo "Call the ping tool, then reply done." \
  | timeout 90 claude --print --output-format stream-json --verbose \
      --mcp-config "$DIR/mcp-stdio.json" --strict-mcp-config \
      --settings "$DIR/settings.json" \
      --mcp-debug \
      --permission-mode bypassPermissions \
      --model sonnet --tools '' \
      > "$OUT_BASE/f.jsonl" 2> "$OUT_BASE/f.err"
python3 "$DIR/parse.py" < "$OUT_BASE/f.jsonl"
echo "  raw stream: $OUT_BASE/f.jsonl  ·  stderr: $OUT_BASE/f.err"
echo "  mcp-debug stderr (top 60 lines):"
sed -n '1,60p' "$OUT_BASE/f.err" | sed 's/^/    /'
echo

echo "=================================="
echo "  WHAT EACH VARIANT TELLS US"
echo "=================================="
echo "E:  if HTTP MCP shows 'connected' and TOOL_USE: mcp__selftest__ping, then"
echo "    AI Review's failure is NOT the MCP race — it's something else, and we"
echo "    should look at DarkRide's actual /mcp endpoint / system prompt."
echo "    If E also shows 'pending', HTTP and stdio share the same race and the"
echo "    fix is broader (drop --tools '' in sendMessage, or push upstream)."
echo "F:  the --mcp-debug stderr is the smoking gun for stdio — it tells us"
echo "    whether the CLI's MCP client sent initialize, got a response, errored,"
echo "    or just gave up. If it shows clear init success but status stays"
echo "    'pending' anyway, that's a CLI bug."
