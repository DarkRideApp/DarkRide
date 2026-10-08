/**
 * AI provider registry E2E
 *
 * Adds an OpenAI-compatible provider through Settings > AI, tests its connection
 * against a local stub server on 127.0.0.1, checks that the form follows the provider type,
 * and adds a model on it chosen from the models the stub reports.
 *
 * No real API key is used: the key is a literal placeholder and every request the backend
 * makes for this provider lands on the stub started below.
 *
 * Run: npx playwright test tests/e2e/ai-provider-registry.spec.ts --retries=2
 */

import { test, expect, type Browser } from '@playwright/test';
import http from 'http';
import type { AddressInfo } from 'net';
import { loginAsAdmin, waitForBackend, apiLogin, API_BASE, ADMIN_USERNAME, ADMIN_PASSWORD } from './helpers/auth';

const PROVIDER_NAME = 'E2E Stub';
const MODEL_NAME = 'E2E Stub Model';
const PLACEHOLDER_KEY = 'sk-test-placeholder';

let server: http.Server;
let port = 0;
const seen: Array<{ method: string; url: string; auth?: string }> = [];

/**
 * Remove anything this spec created: models first, then the provider (the provider DELETE
 * answers 409 while a model still references it). Deletes need the session cookie plus the
 * CSRF header, or they return 403 and the rows leak into later specs. Safe when nothing exists.
 */
async function cleanup(browser: Browser): Promise<void> {
  const ctx = await browser.newContext();
  try {
    const csrf = await apiLogin(ctx.request, ADMIN_USERNAME, ADMIN_PASSWORD);
    const headers = { 'X-CSRF-Token': csrf };

    const modelsRes = await ctx.request.get(`${API_BASE}/v1/ai/models`);
    expect(modelsRes.ok()).toBe(true);
    const models: Array<{ id: number; name: string; providerName: string | null }> = (await modelsRes.json()).data ?? [];
    for (const m of models) {
      if (m.providerName === PROVIDER_NAME || m.name === MODEL_NAME) {
        const del = await ctx.request.delete(`${API_BASE}/v1/ai/models/${m.id}`, { headers });
        expect(del.ok(), `delete model ${m.id}: ${del.status()}`).toBe(true);
      }
    }

    const providersRes = await ctx.request.get(`${API_BASE}/v1/ai/providers`);
    expect(providersRes.ok()).toBe(true);
    const providers: Array<{ id: number; name: string }> = (await providersRes.json()).data ?? [];
    for (const p of providers) {
      if (p.name === PROVIDER_NAME) {
        const del = await ctx.request.delete(`${API_BASE}/v1/ai/providers/${p.id}`, { headers });
        expect(del.ok(), `delete provider ${p.id}: ${del.status()}`).toBe(true);
      }
    }
  } finally {
    await ctx.close();
  }
}

test.describe('AI provider registry', () => {
  test.beforeAll(async ({ browser }) => {
    // Minimal OpenAI-compatible server: only the model listing is needed for this flow.
    server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model-1', object: 'model' }, { id: 'stub-model-2', object: 'model' }] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    const ctx = await browser.newContext();
    await waitForBackend((await ctx.newPage()).request);
    await ctx.close();

    // A crashed earlier run may have left rows behind.
    await cleanup(browser);
  });

  test.afterAll(async ({ browser }) => {
    try {
      await cleanup(browser);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('add an OpenAI-compatible provider, test its connection, and add a model on it', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/ai');
    await page.waitForLoadState('networkidle');

    // ── Add the provider ──
    await page.getByTestId('add-ai-provider-btn').click();
    const addDialog = page.getByRole('dialog');
    await expect(addDialog.getByRole('heading', { name: 'Add AI Provider' })).toBeVisible({ timeout: 5_000 });

    await addDialog.getByTestId('provider-name-input').fill(PROVIDER_NAME);
    await addDialog.getByTestId('provider-type-select').selectOption('openai-compatible');
    await expect(addDialog.getByTestId('provider-base-url-input')).toBeVisible();
    await expect(addDialog.getByText('(required)')).toBeVisible();
    // Base URL is required for this type, so Add stays disabled until it is filled.
    await expect(addDialog.getByTestId('save-provider-btn')).toBeDisabled();

    await addDialog.getByTestId('provider-base-url-input').fill(`http://127.0.0.1:${port}`);
    await addDialog.getByTestId('provider-api-key-input').fill(PLACEHOLDER_KEY);
    await expect(addDialog.getByTestId('save-provider-btn')).toBeEnabled();
    await expect(addDialog.getByTestId('save-provider-btn')).toHaveText('Add');
    await addDialog.getByTestId('save-provider-btn').click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });

    const row = page.locator('[data-testid^="ai-provider-row-"]').filter({ hasText: PROVIDER_NAME });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row.getByText('OpenAI-compatible', { exact: true })).toBeVisible();

    // ── Reopen it (Test Connection only renders when editing) and test ──
    await row.getByRole('button', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog.getByRole('heading', { name: 'Edit AI Provider' })).toBeVisible({ timeout: 5_000 });
    // The base URL is stored normalised with the type's default path.
    await expect(editDialog.getByTestId('provider-base-url-input')).toHaveValue(`http://127.0.0.1:${port}/v1`);
    await expect(editDialog.getByText('A key is saved')).toBeVisible();

    await editDialog.getByTestId('test-provider-btn').click();
    await expect(editDialog.getByText('Connected to 2 models')).toBeVisible({ timeout: 15_000 });
    expect(seen.some((s) => s.method === 'GET' && s.url === '/v1/models' && s.auth === `Bearer ${PLACEHOLDER_KEY}`)).toBe(true);

    // Ollama has no key field: switching the type in the edit form hides it, keeps the
    // optional Base URL, and warns that the saved key would be cleared.
    await editDialog.getByTestId('provider-type-select').selectOption('ollama');
    await expect(editDialog.getByTestId('provider-api-key-input')).toHaveCount(0);
    await expect(editDialog.getByTestId('provider-base-url-input')).toBeVisible();
    await expect(editDialog.getByTestId('provider-key-clear-notice')).toBeVisible();

    // Close without saving; the provider keeps its type.
    await editDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(row.getByText('OpenAI-compatible', { exact: true })).toBeVisible();

    // ── Add a model on it, choosing from the models the stub reports ──
    await page.getByTestId('add-ai-model-btn').click();
    const modelDialog = page.getByRole('dialog');
    await expect(modelDialog.getByRole('heading', { name: 'Add AI Model' })).toBeVisible({ timeout: 5_000 });

    await modelDialog.getByTestId('model-name-input').fill(MODEL_NAME);
    const providerValue = await modelDialog
      .locator('[data-testid="model-provider-select"] option', { hasText: PROVIDER_NAME })
      .first()
      .getAttribute('value');
    expect(providerValue).toBeTruthy();
    await modelDialog.getByTestId('model-provider-select').selectOption(providerValue!);

    // OpenAI-compatible has no default model, so a model must be chosen before Add enables.
    const modelSelect = modelDialog.getByTestId('model-model-select');
    await expect(modelSelect.locator('option', { hasText: 'stub-model-2' })).toHaveCount(1, { timeout: 10_000 });
    await expect(modelDialog.getByTestId('save-model-btn')).toBeDisabled();
    await modelSelect.selectOption('stub-model-1');
    await expect(modelDialog.getByTestId('save-model-btn')).toBeEnabled();
    await modelDialog.getByTestId('save-model-btn').click();
    await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });

    const modelRow = page.locator('[data-testid^="ai-model-row-"]').filter({ hasText: MODEL_NAME });
    await expect(modelRow).toBeVisible({ timeout: 10_000 });
    await expect(modelRow.getByText(`${PROVIDER_NAME} / stub-model-1`, { exact: true })).toBeVisible();
  });
});
