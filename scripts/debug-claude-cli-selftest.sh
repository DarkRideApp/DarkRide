#!/usr/bin/env bash
# Reproduce the PRE-FIX ClaudeCliProvider.testToolUse() outside of DarkRide
# (stdio MCP "ping" server + --tools '' + ping prompt) as the darkride
# service user, and print every signal the eval function looks at.
#
# This is a historical reproducer of the broken setup that motivated the
# 2026-06-04 fix: testToolUse no longer uses an MCP server or --tools ''
# in current code. Keep this around because the buggy setup is exactly what
# unblocked the diagnosis — run it to confirm the original race still
# reproduces if anything in the CLI changes in the future.
#
# Read-only: makes a temp dir, runs claude once, persists the raw stream to
# /tmp/claude-selftest-out.jsonl so it can be re-parsed without re-running.
# Does not touch the DarkRide install directory.
#
# Usage:  sudo -u darkride -s -- bash /tmp/debug-claude-cli-selftest.sh
set -u

DIR=$(mktemp -d) || { echo "[fatal] mktemp -d failed — /tmp not writable as $(id -un)?" >&2; exit 1; }
OUT=/tmp/claude-selftest-out.jsonl
ERR=/tmp/claude-selftest-err.log
trap 'rm -rf "$DIR"' EXIT

cat > "$DIR/ping-mcp.js" <<'JS'
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{continue}
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:(m.params&&m.params.protocolVersion)||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'selftest',version:'1.0.0'}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'ping',description:'Returns pong. Call to verify tool access.',inputSchema:{type:'object',properties:{}}}]}});
else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'pong'}]}});
else if(m.method&&m.method.indexOf('notifications/')===0){}
else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{}});}});
function send(o){process.stdout.write(JSON.stringify(o)+'\n')}
JS

cat > "$DIR/mcp.json" <<JSON
{"mcpServers":{"selftest":{"command":"node","args":["$DIR/ping-mcp.js"]}}}
JSON

# Parser as a real file — avoids the stdin/heredoc collision the first version had.
cat > "$DIR/parse.py" <<'PY'
import sys, json
init=None
turns=[]
result=None
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: e=json.loads(line)
    except: continue
    if e.get("type")=="system" and e.get("subtype")=="init":
        init=e
    elif e.get("type")=="assistant":
        for b in (e.get("message",{}).get("content") or []):
            t=b.get("type")
            if   t=="text":     turns.append(("TEXT", (b.get("text") or "")[:600]))
            elif t=="tool_use": turns.append(("TOOL_USE", b.get("name"), b.get("input") or {}))
            elif t=="thinking": turns.append(("THINK", (b.get("thinking") or "")[:300]))
    elif e.get("type")=="result":
        result=e

print("--- init ---")
if init:
    print(json.dumps({
        "tools": init.get("tools"),
        "mcp_servers": init.get("mcp_servers"),
        "model": init.get("model"),
        "version": init.get("claude_code_version"),
        "apiKeySource": init.get("apiKeySource"),
        "permissionMode": init.get("permissionMode"),
    }, indent=2))
else:
    print("[no init event in stream]")

print("--- assistant turns ---")
if not turns:
    print("[no assistant turns]")
for row in turns:
    print(row[0]+":", *row[1:])

print("--- result ---")
if result:
    print(json.dumps({
        "subtype": result.get("subtype"),
        "is_error": result.get("is_error"),
        "num_turns": result.get("num_turns"),
        "duration_ms": result.get("duration_ms"),
        "result_excerpt": (result.get("result") or "")[:300],
        "permission_denials": result.get("permission_denials"),
    }, indent=2))
else:
    print("[no result event]")
PY

echo "=== ENV ==="
echo "user: $(id -un)  home: $HOME  pwd: $(pwd)"
echo "node: $(command -v node || echo MISSING)  $(node -v 2>/dev/null)"
echo "claude: $(command -v claude || echo MISSING)  $(claude --version 2>/dev/null)"

echo
echo "=== Stand-alone MCP server sanity ==="
( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'; sleep 1 ) \
  | timeout 5 node "$DIR/ping-mcp.js" 2>&1 | head -3
echo "[stand-alone exit=${PIPESTATUS[1]}]"

echo
echo "=== Self-test via claude CLI (up to 90s) ==="
echo 'Call the ping tool to verify tool access, then reply "done".' \
  | timeout 90 claude --print --output-format stream-json --verbose \
      --mcp-config "$DIR/mcp.json" --strict-mcp-config \
      --permission-mode bypassPermissions \
      --model sonnet --tools '' \
  > "$OUT" 2> "$ERR"
RC=$?
echo "exit=$RC  bytes_out=$(wc -c < "$OUT")  bytes_err=$(wc -c < "$ERR")"
echo "(raw stream persisted at $OUT, stderr at $ERR — safe to inspect / share)"

echo
echo "=== Stderr ==="
sed -n '1,40p' "$ERR"

echo
echo "=== Parsed ==="
python3 "$DIR/parse.py" < "$OUT"
