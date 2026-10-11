/**
 * AI Job Pipelines E2E Test
 *
 * Exercises the list page and the canvas/panel editor for the real, boot-seeded
 * `apk-analysis` pipeline (seeded unconditionally by `seedApkAnalysisPipeline` at
 * backend boot — see backend/index.ts). The first test is read-only against the
 * shared e2e server: it never publishes a pipeline version or triggers a real
 * run, so it uses the shared webServer (same pattern as navigation.spec.ts), not
 * an isolated DB+Vite instance.
 *
 * Run: npx playwright test tests/e2e/ai-pipelines.spec.ts
 */

import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from './helpers/auth';

test.describe('AI job pipelines', () => {
  test('list page shows the seeded pipeline by its real name; its editor shows real prompt and Report content', async ({ page }) => {
    await loginAsAdmin(page);
    await waitForBackend(page.request);
    await page.goto('/ui/pipelines');

    const row = page.getByTestId('pipelines-table').getByText('APK Analysis', { exact: true });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // Every node still renders its own id as metadata text (Canvas.tsx's NodeLabel), even
    // though its label is now the primary line.
    await expect(page.getByText('agent-overview', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('report', { exact: true })).toBeVisible();

    // Run lives in the Trigger's own side panel now, scoped to that Trigger — not a toolbar
    // picker that assumes every pipeline is APK analysis. Its input form is generated from the
    // Trigger's declared inputSchema ('versionId', an 'apk-version' field, renders as a picker
    // over recent APK versions), without ever clicking Run — a real run costs a live model call
    // and risks the cyber-classifier refusal this project exists to route around, which belongs
    // in a periodic eval, not this gate-tested spec.
    await page.getByText('Full Analysis', { exact: true }).click();
    const triggerPanel = page.getByRole('dialog', { name: 'trigger-full details' });
    await expect(triggerPanel).toBeVisible();
    const versionPicker = triggerPanel.getByLabel('versionId');
    await expect(versionPicker).toBeVisible();

    const reuseToggle = triggerPanel.getByRole('checkbox', { name: 'Reuse unchanged nodes' });
    await expect(reuseToggle).not.toBeChecked();
    await reuseToggle.check();
    await expect(reuseToggle).toBeChecked();
    await reuseToggle.uncheck();
    await expect(reuseToggle).not.toBeChecked();
    await page.getByRole('button', { name: /close/i }).click();

    // Click the agent-overview AgentCall node, confirm the prompt editor opens with real content.
    await page.getByText('agent-overview', { exact: true }).click();
    const promptBox = page.getByRole('textbox', { name: 'Instruction template' });
    await expect(promptBox).toHaveValue(/Analyze \{\{trigger\.appName\}\}/);

    // Insert a variable chip, confirm it lands in the textarea.
    await page.getByRole('button', { name: /trigger\.appName/i }).click();
    await expect(promptBox).toHaveValue(/\{\{trigger\.appName\}\}.*\{\{trigger\.appName\}\}/s);

    // Close this panel before opening the next one, rather than assume the Report node is
    // reachable underneath whatever's currently open.
    await page.getByRole('button', { name: /close/i }).click();

    // Click the Report node, confirm its ordered section list shows all seven, in order. Each
    // row's title lives in an editable <input> — an input's value is not part of its
    // textContent, so assert the value directly.
    await page.getByText('report', { exact: true }).click();
    const sectionRows = page.getByTestId('report-section-row');
    await expect(sectionRows).toHaveCount(7);
    await expect(sectionRows.nth(6).locator('input')).toHaveValue('Bypass Script');
  });

  test('creating a pipeline, adding nodes, renaming, drag-connecting them, and publishing works end to end', async ({ page }) => {
    await loginAsAdmin(page);
    await waitForBackend(page.request);
    await page.goto('/ui/pipelines');
    await expect(page.getByTestId('pipelines-table')).toBeVisible({ timeout: 15_000 });

    // A brand-new pipeline, unrelated to the seeded apk-analysis one — additive against the
    // shared e2e DB, so it can't affect this file's read-only test above or any other spec.
    await page.getByRole('button', { name: '+ New Pipeline' }).click();
    await page.getByLabel('New pipeline name').fill('E2E Editor Pipeline');
    await page.getByLabel('New pipeline job kind').fill('e2e-editor-test');
    await page.getByRole('button', { name: 'Create' }).click();

    // Creating navigates straight into the new pipeline's own editor route.
    await expect(page).toHaveURL(/\/ui\/pipelines\/\d+$/);
    await expect(page.getByText('E2E Editor Pipeline')).toBeVisible();

    // Add a Trigger node in one step (no separate "Add node" button) and configure + rename it.
    await page.getByLabel('Add node').selectOption('Trigger');
    const triggerPanel = page.getByRole('dialog');
    await expect(triggerPanel).toBeVisible();
    await triggerPanel.getByLabel('Expand function').fill('e2e/expand');
    await triggerPanel.getByLabel('Node name').fill('E2E Trigger');
    await page.getByRole('button', { name: /close/i }).click();
    await expect(page.locator('.react-flow__node').getByText('E2E Trigger', { exact: true })).toBeVisible();

    // Add an AgentCall node.
    await page.getByLabel('Add node').selectOption('AgentCall');
    await page.getByRole('button', { name: /close/i }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    // Drag-connect the Trigger's bottom handle to the AgentCall's top handle — real pointer
    // events against the real canvas, not a simulated event dispatch.
    const triggerNode = page.locator('.react-flow__node[data-id^="trigger-"]').first();
    const agentNode = page.locator('.react-flow__node[data-id^="agent-"]').first();
    const triggerBox = (await triggerNode.boundingBox())!;
    const agentBox = (await agentNode.boundingBox())!;
    await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height);
    await page.mouse.down();
    await page.mouse.move(agentBox.x + agentBox.width / 2, agentBox.y, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    // Unsaved changes show up as a plain-language indicator, not a silent in-memory edit.
    await expect(page.getByText('Unsaved changes…')).toBeVisible();

    // Save, then publish — a graph with its one Trigger properly connected to its one AgentCall
    // passes validateGraph, so this must succeed against the real backend, not a mock.
    await page.getByRole('button', { name: 'Save Draft' }).click();
    await expect(page.getByRole('status')).toHaveText(/draft saved/i);
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Published\.$/);

    // Delete the AgentCall node via the side panel, confirm the canvas and edge both reflect it.
    await agentNode.click();
    await page.getByRole('button', { name: /delete node/i }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  });

  test('wiring a Report section is done by dragging onto its own named pin, not a side-panel dropdown', async ({ page }) => {
    await loginAsAdmin(page);
    await waitForBackend(page.request);
    await page.goto('/ui/pipelines');
    await expect(page.getByTestId('pipelines-table')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '+ New Pipeline' }).click();
    await page.getByLabel('New pipeline name').fill('E2E Pin Wiring Pipeline');
    await page.getByLabel('New pipeline job kind').fill('e2e-pin-test');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/ui\/pipelines\/\d+$/);

    await page.getByLabel('Add node').selectOption('AgentCall');
    await page.getByRole('button', { name: /close/i }).click();
    await page.getByLabel('Add node').selectOption('Report');
    const reportPanel = page.getByRole('dialog');
    await expect(reportPanel).toBeVisible();
    await reportPanel.getByRole('button', { name: /add section/i }).click();
    await reportPanel.locator('input[placeholder="Section title"]').fill('Overview');
    // Not wired yet — the only way to wire it from here on is to drag a connection on the canvas.
    await expect(reportPanel.getByText(/not wired yet/i)).toBeVisible();
    await page.getByRole('button', { name: /close/i }).click();

    // Scoped to .react-flow__node specifically — a Report-section edge's own id (e.g.
    // "report-1-section-0") also starts with "report-", so an unscoped `[data-id^="report-"]`
    // ambiguously matches both the node and its own incoming edge.
    const agentNode = page.locator('.react-flow__node[data-id^="agent-"]').first();
    const reportNode = page.locator('.react-flow__node[data-id^="report-"]').first();
    const agentOutHandle = agentNode.locator('[data-handleid="out"]');
    const sectionHandle = reportNode.locator('[data-handleid="section-0"]');
    await expect(agentOutHandle).toBeVisible();
    await expect(sectionHandle).toBeVisible();
    const agentBox = (await agentOutHandle.boundingBox())!;
    const sectionBox = (await sectionHandle.boundingBox())!;
    await page.mouse.move(agentBox.x + agentBox.width / 2, agentBox.y + agentBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sectionBox.x + sectionBox.width / 2, sectionBox.y + sectionBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await reportNode.click();
    const wiredPanel = page.getByRole('dialog');
    // A freshly added AgentCall defaults to its kind's display name ("Agent Call") as its label —
    // the wired-from text shows that name, confirming the section really did pick up the drag.
    await expect(wiredPanel.locator('.ai-jobs-wired-from')).toContainText('Wired from Agent Call');
  });
});
