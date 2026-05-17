#!/bin/bash
# Generate changelog.json from git history for production deployments
# where .git is not available. Run locally before deploying.
#
# Usage: scripts/generate-changelog.sh
#
# The Ansible deploy task runs this before rsync so the file is included
# in the deployment bundle. The backend reads it from process.cwd().

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$ROOT_DIR/changelog.json"
MAX_COMMITS=500

FIELD_SEP=$'\x1f'
RECORD_SEP=$'\x1e'
GIT_FORMAT="%H${FIELD_SEP}%h${FIELD_SEP}%s${FIELD_SEP}%b${FIELD_SEP}%an${FIELD_SEP}%aI${RECORD_SEP}"

cd "$ROOT_DIR"

total=$(git rev-list --count HEAD)
raw=$(git log --format="$GIT_FORMAT" -n "$MAX_COMMITS")

# Build JSON using python (available on all deploy hosts) for proper escaping
python3 -c "
import sys, json

FIELD_SEP = '\x1f'
RECORD_SEP = '\x1e'

raw = sys.stdin.read()
records = [r.strip() for r in raw.split(RECORD_SEP) if r.strip()]

commits = []
for record in records:
    fields = record.split(FIELD_SEP)
    commits.append({
        'hash': fields[0] if len(fields) > 0 else '',
        'shortHash': fields[1] if len(fields) > 1 else '',
        'title': fields[2] if len(fields) > 2 else '',
        'body': (fields[3] if len(fields) > 3 else '').strip(),
        'author': fields[4] if len(fields) > 4 else '',
        'date': fields[5] if len(fields) > 5 else '',
    })

json.dump({'total': $total, 'commits': commits}, sys.stdout, indent=2)
" <<< "$raw" > "$OUT"

count=$(python3 -c "import json; print(len(json.load(open('$OUT'))['commits']))")
echo "Generated changelog.json with $count commits ($total total)"
