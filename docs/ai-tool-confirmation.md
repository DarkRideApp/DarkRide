# AI tool confirmation

When you chat with the AI, some tools ask before they run. This page says which ones, what each button does, and what the prompt does not cover.

## What you see

A tool that changes configuration or runs code on a device or in an app stops the chat and shows a **Confirmation Required** card with the tool name and its arguments.

| Button | Effect |
|---|---|
| **Deny** | This call does not run. The model is told you refused. |
| **Allow** | This call runs. The next call to the same tool asks again. |
| **Allow for this conversation** | This call runs, and so does every later call to the same tool in the same conversation, without asking. |

An unanswered card is denied after 60 seconds, and cancelling the request or closing the page denies it at once.

"Allow for this conversation" is per tool and per user. Approving `run_adb_command` does not approve `update_setting`, and nobody else who opens the same conversation inherits it. A denial is never remembered.

Approvals are kept in server memory. They survive a page reload and a reconnect, and they are forgotten when the backend restarts. At most 500 conversations are remembered; the least recently used one is dropped first. Starting a new chat starts over.

## Which tools ask

These ask before each call, or once per conversation if you choose **Allow for this conversation**:

| Area | Tools |
|---|---|
| Automations | `create_automation`, `update_automation_code`, `patch_automation_code`, `update_automation_config` |
| Intercept rules | `create_intercept_rule`, `update_intercept_rule`, `delete_intercept_rule` |
| Plugins and settings | `enable_plugin`, `disable_plugin`, `update_setting` |
| Code on a device | `run_adb_command`, `run_frida_script`, `run_frida_and_collect` |

Everything else runs without asking. That includes the read-only runtime inspection tools (`inspect_runtime_classes`, `inspect_class_methods`) and the tools that start or stop your own jobs (`start_capture`, `run_automation`, `cancel_automation_run`, `trigger_apk_analysis`, `fetch_app_from_source`).

## What the prompt does not cover

The prompt exists only in the interactive chat. These paths never ask, whatever a tool's flag says:

- **Unattended runs**, such as APK analysis and APK diff. They run in silent mode with no one to ask. They are limited by the service identity's scopes and by the tools marked `allowUnattended: false` (`run_automation`, `trigger_apk_analysis`, `run_frida_script`, `run_adb_command`, `run_frida_and_collect`, `inspect_runtime_classes`, `inspect_class_methods`), which they cannot call.
- **The Claude CLI provider**, which reaches tools through MCP and runs with `--permission-mode bypassPermissions`.
- **MCP clients, `POST /v1/tools/:name` and automation scripts** (`ctx.tools`), which call the tool registry directly.

Confirmation is a check on what the chat model does for you, not a permission. Scopes are a separate check: the registry enforces a tool's required scope only when the caller passes the user's scopes. The chat and the MCP server do. `POST /v1/tools/:name` and `ctx.tools` call the registry without them.

## Changing the list

A tool asks when its registration in `backend/services/ai-tool-definitions.ts` sets `requiresConfirmation: true`. The list is pinned by `confirmation policy` in `backend/services/ai-tool-definitions.test.ts`, so adding or removing a flag fails that test until the policy lists in it are changed to match. Treat an edit to those lists as a policy decision.

The approval store is in `backend/websocket/ai-chat-handlers.ts`, and the card is in `frontend/components/ai/AiChatPanel.tsx`. `tests/e2e/ai-tool-confirm.spec.ts` drives the whole flow against a stubbed model API.
