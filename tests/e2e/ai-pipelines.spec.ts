/**
 * AI Job Pipelines E2E Test
 *
 * Exercises the canvas/panel UI for the real, boot-seeded `apk-analysis` pipeline
 * (seeded unconditionally by `seedApkAnalysisPipeline` at backend boot — see
 * backend/index.ts). Read-only against the shared e2e server: it never publishes
 * a pipeline version or triggers a real run, so it uses the shared webServer
 * (same pattern as navigation.spec.ts), not an isolated DB+Vite instance.
 *
 * Run: npx playwright test tests/e2e/ai-pipelines.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('AI job pipelines', () => {
  test('canvas renders the real Astérix pipeline; prompt editor and Report sections show real content', async ({ page }) => {
    await loginAsAdmin(page);
    await waitForBackend(page.request);
    await page.goto('/ui/pipelines');

    // Every node renders its own id as part of its label (Canvas.tsx's NodeLabel).
    await expect(page.getByText('agent-overview', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('report', { exact: true })).toBeVisible();

    // Click the agent-overview AgentCall node, confirm the prompt editor opens with real content.
    await page.getByText('agent-overview', { exact: true }).click();
    await expect(page.getByRole('textbox')).toHaveValue(/Analyze \{\{trigger\.appName\}\}/);

    // Insert a variable chip, confirm it lands in the textarea.
    await page.getByRole('button', { name: /trigger\.appName/i }).click();
    await expect(page.getByRole('textbox')).toHaveValue(/\{\{trigger\.appName\}\}.*\{\{trigger\.appName\}\}/s);

    // Close this panel before opening the next one, rather than assume the Report node is
    // reachable underneath whatever's currently open.
    await page.getByRole('button', { name: /close/i }).click();

    // Click the Report node, confirm its ordered section list shows all seven, in order.
    await page.getByText('report', { exact: true }).click();
    const sectionRows = page.getByTestId('report-section-row');
    await expect(sectionRows).toHaveCount(7);
    await expect(sectionRows.nth(6)).toContainText('Bypass Script');
  });
});
