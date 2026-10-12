/**
 * AI tool confirmation E2E
 *
 * A tool that changes configuration asks the user before it runs. "Allow for this conversation" must stop the prompt
 * for that tool for the rest of that conversation, and for no other conversation. Drives real chat runs through
 * provider, agent, WebSocket and the chat drawer against a local stub of the Anthropic Messages API on 127.0.0.1.
 *
 * Every run calls delete_intercept_rule on a rule that does not exist, so running it changes nothing. The stub records
 * what each call returned, which tells a tool that ran from one the user refused.
 *
 * Run: npx playwright test tests/e2e/ai-tool-confirm.spec.ts --retries=2
 */

import { test, expect } from '@playwright/test';
import { waitForBackend, apiLogin, ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers/auth';
import { addStubModel, createToolCallStub, openFreshChat, removeStubFixtures, sendChat } from './helpers/ai-tool-stub';

const NAMES = { providerName: 'E2E Tool Confirm Stub', modelName: 'E2E Tool Confirm' };
// A model id no other AI spec uses: the usage-monitor spec attributes runs to itself by model id and start time.
const MODEL_ID = 'claude-opus-4-6';
const GATED_TOOL = 'delete_intercept_rule';
const replyFor = (turn: number) => `Stub reply for tool confirmation run ${turn}.`;
const stub = createToolCallStub({ modelId: MODEL_ID, toolName: GATED_TOOL, toolInput: { id: 999999 }, replyFor });

test.describe('AI tool confirmation', () => {
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

  test('Allow for this conversation silences the prompt for that tool in that conversation only', async ({ page, browser }) => {
    test.setTimeout(180_000);
    stub.requests.length = 0;

    const api = await browser.newContext();
    try {
      const csrf = await apiLogin(api.request, ADMIN_USERNAME, ADMIN_PASSWORD);
      await addStubModel(api.request, csrf, NAMES, { port: stub.port, modelId: MODEL_ID });

      // Own page context, so other specs' dashboard chat is untouched. Not /ui/traffic: it redirects to /ui/network, which chats as dashboard.
      await openFreshChat(page, '/ui/devices');

      const card = page.getByTestId('ai-chat-confirm');
      // Find replies by their text: a conversation reloaded from the database numbers its messages differently.
      const chat = page.getByTestId('ai-chat-messages');

      // ── First call in a conversation: the user is asked, and allows it for the conversation ──
      await sendChat(page, 'Delete intercept rule 999999');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText(GATED_TOOL);
      await page.getByTestId('ai-chat-confirm-allow-conversation').click();
      await expect(card).toHaveCount(0);
      await expect(chat).toContainText(replyFor(1), { timeout: 30_000 });
      // The tool ran once the user allowed it.
      expect(stub.requests.at(-1)?.toolResult).toContain('Rule not found');

      // ── Same conversation, same tool: a prompt would hold the run, so a reply inside this wait means nobody was asked ──
      await sendChat(page, 'Delete intercept rule 999998');
      await expect(chat).toContainText(replyFor(2), { timeout: 30_000 });
      await expect(card).toHaveCount(0);
      expect(stub.requests.at(-1)?.toolResult).toContain('Rule not found');

      // ── A new conversation starts over: the user is asked again, and a denial stops the tool ──
      await page.getByTestId('ai-chat-new-btn').click();
      await sendChat(page, 'Delete intercept rule 999997');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('ai-chat-confirm-deny').click();
      await expect(card).toHaveCount(0);
      await expect(chat).toContainText(replyFor(3), { timeout: 30_000 });
      expect(stub.requests.at(-1)?.toolResult).toContain('denied by user');
    } finally {
      await api.close();
    }
  });
});
