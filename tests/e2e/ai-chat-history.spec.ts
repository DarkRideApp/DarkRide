/**
 * AI chat history E2E
 *
 * A chat can be found again from any page: the History list shows where it started, opens it, and links back to that
 * page. A reload in the middle of a reply loses nothing. Drives real chat runs through provider, agent, WebSocket and
 * the chat drawer against a local stub of the Anthropic Messages API on 127.0.0.1.
 *
 * Every run calls list_frida_scripts, a read-only tool that asks for no confirmation.
 *
 * Run: npx playwright test tests/e2e/ai-chat-history.spec.ts --retries=2
 */

import { test, expect, type Page } from '@playwright/test';
import { waitForBackend, apiLogin, ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers/auth';
import { addStubModel, createToolCallStub, openFreshChat, removeStubFixtures, sendChat } from './helpers/ai-tool-stub';

const NAMES = { providerName: 'E2E History Stub', modelName: 'E2E History' };
// A model id no other AI spec uses: the usage-monitor spec attributes runs to itself by model id and start time.
const MODEL_ID = 'claude-sonnet-4-5';
const replyFor = (turn: number) => `Stub reply for history run ${turn}.`;
const stub = createToolCallStub({ modelId: MODEL_ID, toolName: 'list_frida_scripts', toolInput: {}, replyFor });

// Two pages with page contexts no other AI spec chats on.
const CREDENTIALS = '/ui/settings/credentials';
const FRIDA = '/ui/frida';

async function openChatOn(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('ai-chat-fab').click();
  await expect(page.getByTestId('ai-chat-panel')).toBeVisible({ timeout: 10_000 });
}

test.describe('AI chat history', () => {
  test.beforeAll(async ({ browser }) => {
    await stub.start();
    const ctx = await browser.newContext();
    await waitForBackend((await ctx.newPage()).request);
    await ctx.close();
    await removeStubFixtures(browser, NAMES);
  });

  test.afterAll(async ({ browser }) => {
    try {
      await removeStubFixtures(browser, NAMES);
    } finally {
      await stub.stop();
    }
  });

  test('finds a chat from another page, survives a reload mid-reply, and deletes a chat', async ({ page, browser }) => {
    test.setTimeout(300_000);
    stub.requests.length = 0;
    // The database outlives a retry, so every chat of this run carries a tag and the list is searched by it.
    const tag = `hist${Date.now().toString(36)}`;

    const api = await browser.newContext();
    try {
      const csrf = await apiLogin(api.request, ADMIN_USERNAME, ADMIN_PASSWORD);
      await addStubModel(api.request, csrf, NAMES, { port: stub.port, modelId: MODEL_ID });

      const chat = page.getByTestId('ai-chat-messages');
      const search = page.getByTestId('ai-chat-history-search');
      const items = page.locator('[data-testid^="ai-chat-history-item-"]');
      const openHistory = async (query: string) => {
        await page.getByTestId('ai-chat-history-toggle').click();
        await search.fill(query);
      };
      const closeHistory = () => page.getByTestId('ai-chat-history-toggle').click();

      // ── Two chats, on two pages ──
      await openFreshChat(page, CREDENTIALS);
      await sendChat(page, `${tag} alpha`);
      await expect(chat).toContainText(replyFor(1), { timeout: 30_000 });

      await openChatOn(page, FRIDA);
      await page.getByTestId('ai-chat-new-btn').click();
      await sendChat(page, `${tag} beta`);
      await expect(chat).toContainText(replyFor(2), { timeout: 30_000 });

      // ── History lists both, newest first, and "This page" narrows to the chats of this page ──
      await openHistory(tag);
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toContainText(`${tag} beta`);
      await expect(items.nth(1)).toContainText(`${tag} alpha`);
      await page.getByTestId('ai-chat-history-scope-page').click();
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText(`${tag} beta`);
      await page.getByTestId('ai-chat-history-scope-all').click();
      await expect(items).toHaveCount(2);

      // ── Searching narrows the list ──
      await search.fill(`${tag} alpha`);
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText(`${tag} alpha`);

      // ── Opening a chat from another page shows it, says where it started, and links back ──
      await items.first().click();
      await expect(chat).toContainText(replyFor(1), { timeout: 15_000 });
      await expect(chat).not.toContainText(replyFor(2));
      await expect(page.getByTestId('ai-chat-origin-bar')).toBeVisible();
      await page.getByTestId('ai-chat-origin-go').click();
      await expect(page).toHaveURL(/\/ui\/settings\/credentials/);

      // ── A reload keeps the chat that was open on this page ──
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.getByTestId('ai-chat-fab').click();
      await expect(chat).toContainText(replyFor(1), { timeout: 15_000 });

      // ── A chat opened from history is the one its page shows afterwards, though a newer chat exists there ──
      await openChatOn(page, FRIDA);
      await expect(chat).toContainText(replyFor(1), { timeout: 15_000 });
      await expect(chat).not.toContainText(replyFor(2));
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.getByTestId('ai-chat-fab').click();
      await expect(chat).toContainText(replyFor(1), { timeout: 15_000 });
      await expect(chat).not.toContainText(replyFor(2));

      // ── A reload in the middle of a reply loses nothing ──
      await page.getByTestId('ai-chat-new-btn').click();
      const before = stub.requests.length;
      stub.delayNext(60_000);
      await sendChat(page, `${tag} gamma`);
      await expect.poll(() => stub.requests.length, { timeout: 30_000 }).toBeGreaterThan(before);
      await page.reload();
      await page.waitForLoadState('networkidle');
      await page.getByTestId('ai-chat-fab').click();
      await expect(chat).toContainText(`${tag} gamma`, { timeout: 15_000 });
      await expect(page.getByTestId('ai-chat-unfinished-notice')).toBeVisible();

      await openHistory(`${tag} gamma`);
      await expect(items).toHaveCount(1);
      await expect(items.first()).toContainText('Unfinished');
      await closeHistory();

      // ── Saying continue carries on, and the chat is no longer unfinished ──
      await sendChat(page, 'continue');
      await expect(chat).toContainText(replyFor(4), { timeout: 30_000 });
      await expect(page.getByTestId('ai-chat-unfinished-notice')).toHaveCount(0);
      await openHistory(`${tag} gamma`);
      await expect(items).toHaveCount(1);
      await expect(items.first()).not.toContainText('Unfinished');

      // ── Deleting asks first, then removes the chat ──
      await search.fill(`${tag} beta`);
      await expect(items).toHaveCount(1);
      const row = page.locator('.ai-chat-history-row').first();
      await row.getByRole('button', { name: 'Delete chat' }).click();
      await page.getByTestId('ai-chat-history-delete-cancel').click();
      await expect(items).toHaveCount(1);
      await row.getByRole('button', { name: 'Delete chat' }).click();
      await page.getByTestId('ai-chat-history-delete-confirm').click();
      await expect(items).toHaveCount(0);
      await search.fill(tag);
      await expect(items).toHaveCount(2);
    } finally {
      await api.close();
    }
  });
});
