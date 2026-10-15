#!/bin/bash
# Keeps one issue in step with the nightly emulator workflow: opened on the first
# failed night, commented on while it keeps failing, closed when a night passes.
#
# Env: RESULT (success | failure | anything else is ignored), REPO (owner/name),
#      RUN_URL (link to the workflow run). Needs `gh` with GH_TOKEN and issues: write.
set -euo pipefail

LABEL="nightly-emulator"
TITLE="Nightly emulator workflow is failing"

open_issue=$(gh issue list --repo "$REPO" --label "$LABEL" --state open --json number --jq '.[0].number // empty')

case "${RESULT:-}" in
  failure)
    if [ -n "$open_issue" ]; then
      gh issue comment "$open_issue" --repo "$REPO" --body "Failed again: $RUN_URL"
    else
      gh label create "$LABEL" --repo "$REPO" --color d93f0b --description "Scheduled emulator capture run" 2>/dev/null || true
      gh issue create --repo "$REPO" --title "$TITLE" --label "$LABEL" --body "@cubehouse The scheduled emulator capture workflow failed: $RUN_URL

This issue gets a comment for every further failed night and closes itself when a scheduled run passes."
    fi
    ;;
  success)
    if [ -n "$open_issue" ]; then
      gh issue close "$open_issue" --repo "$REPO" --comment "Passed: $RUN_URL"
    fi
    ;;
  *)
    echo "Nothing to report for result '${RESULT:-}'"
    ;;
esac
