#!/usr/bin/env bash
# Drill into the MCP-pending-at-init race with four side-by-side variants.
# Saves the raw stream of each variant so we can inspect event ordering
# (does init fire before/after the hook? before/after MCP connects?).
#
# Read-only: uses temp files, the darkride user's existing OAuth login.
#
# Usage:  sudo -u darkride -s -- bash /tmp/test-mcp-race-fix.sh

set -u
DIR=$(mktemp -d) || { echo "[fatal] mktemp -d failed" >&2; exit 1; }
OUT_BASE=/tmp/claude-race
mkdir -p "$OUT_BASE"
trap 'rm -rf "$DIR"' EXIT

# stdio MCP server
cat > "$DIR/ping-mcp.js" <<'JS'
let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let m;try{m=JSON.parse(line)}catch{continue}
if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'selftest',version:'1.0.0'}}});
else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'ping',description:'Returns pong.',inputSchema:{type:'object',properties:{}}}]}});
else if(m.method==='tools/call')send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'pong'}]}});
else if(m.method&&m.method.indexOf('notifications/')===0){}
else if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{}});}});
function send(o){process.stdout.write(JSON.stringify(o)+'\n')}
JS
cat > "$DIR/mcp.json" <<JSON
{"mcpServers":{"selftest":{"command":"node","args":["$DIR/ping-mcp.js"]}}}
JSON

cat > "$DIR/settings-no-hook.json"  <<'JSON'
{}
JSON
cat > "$DIR/settings-sleep1.json" <<'JSON'
{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"sleep 1"}]}]}}
JSON
cat > "$DIR/settings-sleep5.json" <<'JSON'
{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"sleep 5"}]}]}}
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
        events.append((et+":"+(st or "?")))
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

print(" event order:", " → ".join(events))
if init:
    print(" init.mcp_servers:", json.dumps(init.get("mcp_servers")))
    print(" init.tools count:", len(init.get("tools") or []))
    print(" init.tools sample:", (init.get("tools") or [])[:6])
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

run_variant() {
  local label="$1"; local settings="$2"; local extra_args="$3"; local outfile="$4"
  echo "=================================="
  echo "  $label"
  echo "=================================="
  echo "    args: --settings $(basename $settings) $extra_args"
  echo "Call the ping tool, then reply done." \
    | timeout 120 claude --print --output-format stream-json --verbose \
        --mcp-config "$DIR/mcp.json" --strict-mcp-config \
        --settings "$settings" \
        --permission-mode bypassPermissions \
        --model sonnet $extra_args \
        > "$outfile" 2>/dev/null
  python3 "$DIR/parse.py" < "$outfile"
  echo "    raw stream: $outfile"
  echo
}

# Variant matrix:
# (A) baseline:   --tools ''           no hook       → current DarkRide behavior
# (B) sleep1:     --tools ''           sleep 1 hook  → previous test
# (C) sleep5:     --tools ''           sleep 5 hook  → longer delay
# (D) no-tools-empty: NO --tools flag  no hook       → built-ins enabled, see if MCP still races
run_variant "A. baseline (no hook, --tools '')"                     "$DIR/settings-no-hook.json"  "--tools ''"  "$OUT_BASE/a.jsonl"
run_variant "B. sleep 1 hook + --tools ''"                          "$DIR/settings-sleep1.json"   "--tools ''"  "$OUT_BASE/b.jsonl"
run_variant "C. sleep 5 hook + --tools ''"                          "$DIR/settings-sleep5.json"   "--tools ''"  "$OUT_BASE/c.jsonl"
run_variant "D. no hook, NO --tools flag (built-ins enabled)"       "$DIR/settings-no-hook.json"  ""            "$OUT_BASE/d.jsonl"

echo "=================================="
echo "  WHAT EACH VARIANT TELLS US"
echo "=================================="
echo "A vs B:   did the sleep-1 hook actually delay init? Watch event order:"
echo "          if init fires BEFORE hook_response, the hook isn't gating init."
echo "B vs C:   if C still shows pending, the gating isn't a time problem and"
echo "          longer waits won't help."
echo "D:        if D shows mcp_servers=connected and built-ins listed, the CLI"
echo "          waits for MCP when there are SOME tools registered — and the"
echo "          '--tools \"\"' flag is what makes it skip the wait. That's the"
echo "          real fix: drop --tools '' from ClaudeCliProvider."
echo "          (If D also shows pending, MCP is just slow on this host.)"
