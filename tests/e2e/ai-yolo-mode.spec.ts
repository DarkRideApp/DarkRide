/**
 * AI chat YOLO mode E2E
 *
 * With YOLO mode on, tools that normally ask run without a prompt. The server holds the state per conversation, so it
 * survives a reload, and New Chat turns it off. Drives real chat runs through provider, agent, WebSocket and the chat
 * drawer against a local stub of the Anthropic Messages API on 127.0.0.1.
 *
 * Every run calls delete_intercept_rule on a rule that does not exist, so running it changes nothing. The stub records
 * what each call returned, which tells a tool that ran from one the user refused.
 *
 * Run: npx playwright test tests/e2e/ai-yolo-mode.spec.ts --retries=2
 */

import { test, expect } from '@playwright/test';
import { waitForBackend, apiLogin, ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers/auth';
import { addStubModel, createToolCallStub, openFreshChat, removeStubFixtures, sendChat } from './helpers/ai-tool-stub';

const NAMES = { providerName: 'E2E YOLO Stub', modelName: 'E2E YOLO' };
// A model id no other AI spec uses: the usage-monitor spec attributes runs to itself by model id and start time.
const MODEL_ID = 'claude-opus-4-5';
const GATED_TOOL = 'delete_intercept_rule';
const replyFor = (turn: number) => `Stub reply for YOLO mode run ${turn}.`;
const stub = createToolCallStub({ modelId: MODEL_ID, toolName: GATED_TOOL, toolInput: { id: 999999 }, replyFor });

test.describe('AI chat YOLO mode', () => {
  test.beforeAll(async ({ browser }) => {
    await stub.start();
    const ctx = await browser.newContext();
    await waitForBackend((await ctx.newPage()).request);
    await ctx.close();
    // A crashed earlier run may have left rows behind.
    await removeStubFixtures(browser, NAMES);
  });

  test.afterAll(async ({ browser }) => {
    try {
      await removeStubFixtures(browser, NAMES);
    } finally {
      await stub.stop();
    }
  });

  test('runs every tool without asking, survives a reload, and New Chat turns it off', async ({ page, browser }) => {
    test.setTimeout(240_000);
    stub.requests.length = 0;

    const api = await browser.newContext();
    try {
      const csrf = await apiLogin(api.request, ADMIN_USERNAME, ADMIN_PASSWORD);
      await addStubModel(api.request, csrf, NAMES, { port: stub.port, modelId: MODEL_ID });

      // Own page context, so other specs' chats are untouched.
      await openFreshChat(page, '/ui/automations');

      const card = page.getByTestId('ai-chat-confirm');
      const toggle = page.getByTestId('ai-chat-yolo-toggle');
      const badge = page.getByTestId('ai-chat-yolo-badge');
      const dialog = page.getByRole('dialog');
      // Find replies by their text: a conversation reloaded from the database numbers its messages differently.
      const chat = page.getByTestId('ai-chat-messages');
      const lastToolResult = () => stub.requests.at(-1)?.toolResult;

      // ── Off by default. Switching on asks first, and says what it unlocks ──
      await expect(badge).toHaveCount(0);
      await toggle.click();
      await expect(dialog).toContainText('ADB shell');
      await page.getByTestId('ai-chat-yolo-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(badge).toBeVisible();

      // ── A new chat starts in YOLO: the tool runs and nobody is asked. A prompt would hold the run, so a reply
      //    inside this wait means nobody was asked ──
      await sendChat(page, 'Delete intercept rule 999999');
      await expect(chat).toContainText(replyFor(1), { timeout: 30_000 });
      await expect(card).toHaveCount(0);
      expect(lastToolResult()).toContain('Rule not found');
      await expect(badge).toBeVisible();

      // ── The same conversation stays in YOLO ──
      await sendChat(page, 'Delete intercept rule 999998');
      await expect(chat).toContainText(replyFor(2), { timeout: 30_000 });
      await expect(card).toHaveCount(0);

      // ── The server holds it: after a reload the restored conversation is still in YOLO ──
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.getByTestId('ai-chat-fab').click();
      await expect(chat).toContainText(replyFor(2), { timeout: 15_000 });
      await expect(badge).toBeVisible({ timeout: 15_000 });
      await sendChat(page, 'Delete intercept rule 999997');
      await expect(chat).toContainText(replyFor(3), { timeout: 30_000 });
      await expect(card).toHaveCount(0);

      // ── Switching off needs no dialog, and the next call asks again ──
      await toggle.click();
      await expect(dialog).toHaveCount(0);
      await expect(badge).toHaveCount(0);
      await sendChat(page, 'Delete intercept rule 999996');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('ai-chat-confirm-deny').click();
      await expect(chat).toContainText(replyFor(4), { timeout: 30_000 });
      expect(lastToolResult()).toContain('denied by user');

      // ── New Chat turns it off, so the first call of the next chat asks ──
      await toggle.click();
      await page.getByTestId('ai-chat-yolo-confirm').click();
      await expect(badge).toBeVisible();
      await page.getByTestId('ai-chat-new-btn').click();
      await expect(badge).toHaveCount(0);
      await sendChat(page, 'Delete intercept rule 999995');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('ai-chat-confirm-deny').click();
      await expect(chat).toContainText(replyFor(5), { timeout: 30_000 });
      expect(lastToolResult()).toContain('denied by user');
    } finally {
      await api.close();
    }
  });
});
