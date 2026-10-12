# AI tool confirmation

When you chat with the AI, 13 tools ask before they run. This page says which ones, what each button does, and what the prompt does not cover.

## What you see

A flagged tool stops the chat and shows a **Confirmation Required** card with the tool name and its arguments.

| Button | Effect |
|---|---|
| **Deny** | This call does not run. The model is told you refused. |
| **Allow** | This call runs. The next call to the same tool asks again. |
| **Allow for this conversation** | This call runs, and so does every later call to the same tool in the same conversation, without asking. |

An unanswered card is denied after 60 seconds. Cancelling the request or closing the page denies it at once, and a card that was already settled closes.

"Allow for this conversation" is per tool and per user, and it covers the tool whatever its arguments. Approving `run_adb_command` once lets the model run any later ADB command in that conversation. It does not approve `update_setting`, and nobody else who opens the same conversation inherits it. A denial is never remembered.

Approvals are kept in server memory with no expiry. They survive a page reload and a reconnect, so a conversation you reopen later is still approved, and they are forgotten when the backend restarts. At most 500 conversations are remembered; the least recently used one is dropped first. Starting a new chat starts over.

## Which tools ask

| Area | Tools |
|---|---|
| Automations | `create_automation`, `update_automation_code`, `patch_automation_code`, `update_automation_config` |
| Intercept rules | `create_intercept_rule`, `update_intercept_rule`, `delete_intercept_rule` |
| Plugins and settings | `enable_plugin`, `disable_plugin`, `update_setting` |
| Code on a device | `run_adb_command`, `run_frida_script`, `run_frida_and_collect` |

Every other tool runs without asking. That includes tools that change state:

- `inspect_runtime_classes` and `inspect_class_methods` spawn the app under Frida and stop the Frida server afterwards. They write no data, but they restart the app on the device.
- `start_capture`, `run_automation`, `cancel_automation_run`, `trigger_apk_analysis` (which re-runs the AI review) and `fetch_app_from_source` start or stop your own jobs.
- `toggle_intercept_rule`, `set_app_source`, `create_frida_script`, `update_frida_script`, `patch_frida_script` and `append_frida_hook` edit configuration and scripts.

## What the prompt does not cover

The prompt exists only in the interactive chat. These paths never ask, whatever a tool's flag says:

- **Automation scripts.** A script calls any tool through its global `tools` object, and nothing in a script asks. Allowing `create_automation` or `update_automation_code` for a conversation, then running the automation, lets that script call `run_adb_command` and the rest.
- **Unattended runs.** APK analysis and APK diff run in silent mode with no one to ask. The automatic runs use a service identity with its own scopes. The **AI Analysis** button runs under the scopes of the user who clicked it. Both can call every tool except the seven marked `allowUnattended: false` (`run_automation`, `trigger_apk_analysis`, `run_frida_script`, `run_adb_command`, `run_frida_and_collect`, `inspect_runtime_classes`, `inspect_class_methods`). That leaves 10 of the 13 asking tools reachable without a prompt.
- **Plugin agents.** A plugin chooses its own mode and has no confirmation callback.
- **The Claude CLI provider**, which reaches tools through MCP and runs with `--permission-mode bypassPermissions`.
- **MCP clients and `POST /v1/tools/:name`**, which call the tool registry directly.

Confirmation is a check on what the chat model does for you, not a permission.

## Changing the list

A tool asks when its registration in `backend/services/ai-tool-definitions.ts` sets `requiresConfirmation: true`. The list is pinned by `confirmation policy` in `backend/services/ai-tool-definitions.test.ts`, so adding or removing a flag fails that test until the lists in it are changed to match. Treat an edit to those lists as a policy decision. The test covers the tools registered there, not tools that plugins register.

The approval store is in `backend/websocket/ai-chat-handlers.ts`, and the card is in `frontend/components/ai/AiChatPanel.tsx`. `tests/e2e/ai-tool-confirm.spec.ts` runs Allow for this conversation and Deny through the chat drawer against a stubbed model API.
