# AI chat history

Every AI chat is saved, and the **History** button in the chat header lists them. Use it to find a chat started on another page, to pick one up after a reload or a lost connection, or to delete one.

## The History list

| Control | Effect |
|---|---|
| **History** button | Switches the chat panel between the conversation and the list. |
| Search box | Matches the chat title and the text of its messages, tool output included. |
| **All pages** / **This page** | **This page** shows only chats started on the page you are on. |
| A row | Opens that chat. Each row shows the title, where it started, when it was last used, and an **Unfinished** badge when the last reply did not complete. |
| **Go there** | Appears above an opened chat that was started on another page. It takes you to that page. |
| Bin icon | Asks for confirmation, then deletes the chat. |

The list shows 30 chats at a time; **Load more** adds the next 30. Chats started by automated runs (APK analysis, APK diff summaries) are not listed.

The chat panel also remembers, for each page, the chat you last had open there. After a reload it reopens that chat. If you never opened one on that page, it reopens the most recent chat for the page.

## Reload or lost connection

Your message is saved when you press send, before the model is called, so a reload, a crash or a dropped connection never loses it. The run itself stops when the connection closes. A confirmation card that is still open is denied, and a tool call that is already running is not interrupted.

What is kept: your message and every turn that finished. What is lost: the text of the reply that was being written. The chat is marked **Unfinished**. Open it from History, or reload and let the panel restore it, read the notice above the input, and send "continue". The model is told the previous reply was interrupted, and a tool call that never returned is closed with an "Interrupted" result so the provider accepts the next request.

A chat also counts as unfinished when you cancel it, when the model request fails, and when it stops at the turn limit.

## Who sees what

You see your own chats, plus chats saved before ownership existed (they have no owner, so every user sees them, and they have no **Go there** link). You cannot list, search, open or delete another user's chat, and sending to another user's conversation id starts a new chat instead. Listing needs the `core.ai:chat` scope.

## How long chats are kept

A chat is deleted when it has not been used for 90 days. Set `AI_CONVERSATION_PRUNE_DAYS` to change that. Conversations started by automated runs follow `PRUNE_DAYS` (default 7), as before. The daily Database Pruning job at 03:00 does both. Deleting a chat from the list removes it at once.

## REST API

All routes need `core.ai:chat`, and only reach conversations the caller can see.

| Route | Returns |
|---|---|
| `GET /v1/ai/conversations?limit=&offset=&q=&pageContext=&contextId=` | `{ conversations, hasMore }`, newest activity first. `limit` defaults to 30, maximum 100. |
| `GET /v1/ai/conversations/:id` | One conversation with its messages, or 404. |
| `DELETE /v1/ai/conversations/:id` | `{ success: true }`, or 404. |
| `GET /v1/ai/conversations/latest?pageContext=&contextId=` | The newest conversation for a page context, as before. |

Each conversation carries `originPath` (the app path it was started from, or null) and `unfinished`. The WebSocket `ai:message` takes an optional `originPath` for a new chat. The server keeps it only if it is an app path starting with `/ui`.

## Upgrading

A migration adds the owner, origin, unfinished and automated columns to `ai_conversations`, so the backend needs a restart. Existing APK diff conversations are marked automated. Chats from before the upgrade stay visible to every user, and they will now live for 90 days instead of 7 from their last use.

The code is in `backend/services/ai-conversation-store.ts` (saving), `backend/api/ai-chat.ts` (routes), `frontend/components/ai/AiChatHistory.tsx` (the list) and `frontend/components/ai/AiChatPanel.tsx`. `tests/e2e/ai-chat-history.spec.ts` runs the flows above through the chat drawer against a stubbed model API.
