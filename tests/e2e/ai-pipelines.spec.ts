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
    await page.getByRole('button', { name: 'Create' }).click();

    // Creating navigates straight into the new pipeline's own editor route.
    await expect(page).toHaveURL(/\/ui\/pipelines\/\d+$/);
    await expect(page.getByText('E2E Editor Pipeline')).toBeVisible();

    // Add a Trigger node via the searchable node picker, configure + rename it.
    await page.getByRole('button', { name: '+ Add node' }).click();
    await page.getByRole('option', { name: /^Trigger/ }).click();
    const triggerPanel = page.getByRole('dialog');
    await expect(triggerPanel).toBeVisible();
    await triggerPanel.getByLabel('Starts from').selectOption('__custom__');
    await triggerPanel.getByPlaceholder('custom expand function name').fill('e2e/expand');
    await triggerPanel.getByLabel('Node name').fill('E2E Trigger');
    await page.getByRole('button', { name: /close/i }).click();
    await expect(page.locator('.react-flow__node').getByText('E2E Trigger', { exact: true })).toBeVisible();

    // Add an AgentCall node via the picker, filtering by a search term to prove it actually filters.
    await page.getByRole('button', { name: '+ Add node' }).click();
    await page.getByLabel('Search node kinds').fill('agent');
    await page.getByRole('option', { name: /^Agent Call/ }).click();
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
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/ui\/pipelines\/\d+$/);

    await page.getByRole('button', { name: '+ Add node' }).click();
    await page.getByRole('option', { name: /^Agent Call/ }).click();
    await page.getByRole('button', { name: /close/i }).click();
    await page.getByRole('button', { name: '+ Add node' }).click();
    await page.getByRole('option', { name: /^Report/ }).click();
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

  test('a failing run shows the real error on the failed node, and explains the skipped node points upstream', async ({ page }) => {
    await loginAsAdmin(page);
    await waitForBackend(page.request);
    await page.goto('/ui/pipelines');
    await expect(page.getByTestId('pipelines-table')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '+ New Pipeline' }).click();
    await page.getByLabel('New pipeline name').fill('E2E Failing Run Pipeline');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/ui\/pipelines\/\d+$/);

    // A real registered expand function (apk-analysis/apk-context) that genuinely throws without
    // a versionId — the whole point of this test is exercising the backend's real error message,
    // not a mocked one.
    await page.getByRole('button', { name: '+ Add node' }).click();
    await page.getByRole('option', { name: /^Trigger/ }).click();
    const triggerPanel = page.getByRole('dialog');
    await expect(triggerPanel).toBeVisible();
    await triggerPanel.getByLabel('Starts from').selectOption('apk-analysis/apk-context');
    // Regression guard for the bug Cube hit live: picking a known function must fill in its real
    // Run Parameters, not leave the editor showing nothing while the function silently requires
    // a versionId underneath.
    await expect(triggerPanel.getByTestId('trigger-input-field-row').getByPlaceholder('name')).toHaveValue('versionId');
    await page.getByRole('button', { name: /close/i }).click();

    await page.getByRole('button', { name: '+ Add node' }).click();
    await page.getByRole('option', { name: /^Agent Call/ }).click();
    await page.getByRole('button', { name: /close/i }).click();

    const triggerNode = page.locator('.react-flow__node[data-id^="trigger-"]').first();
    const agentNode = page.locator('.react-flow__node[data-id^="agent-"]').first();
    const triggerBox = (await triggerNode.boundingBox())!;
    const agentBox = (await agentNode.boundingBox())!;
    await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height);
    await page.mouse.down();
    await page.mouse.move(agentBox.x + agentBox.width / 2, agentBox.y, { steps: 10 });
    await page.mouse.up();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await page.getByRole('button', { name: 'Save Draft' }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status')).toHaveText(/^Published\.$/);

    // No run parameters declared on this Trigger, so Run invokes apk-analysis/apk-context with an
    // empty input — it throws because it requires a numeric versionId.
    await triggerNode.click();
    await triggerPanel.getByRole('button', { name: /^run$/i }).click();
    await expect(page.getByRole('status')).toHaveText(/finished: failed/i, { timeout: 15_000 });

    // The failed Trigger: a hover title with the real thrown message, and the same text in its
    // own side panel's "Last run" block.
    await expect(triggerNode.locator('.ai-jobs-node-content')).toHaveAttribute('title', /requires a numeric "versionId"/);
    await expect(triggerPanel.getByTestId('node-run-status')).toContainText(/requires a numeric "versionId"/);
    await page.getByRole('button', { name: /close/i }).click();

    // The downstream AgentCall never ran — it explains itself as an upstream failure, not its own.
    await expect(agentNode.locator('.ai-jobs-node-content')).toHaveAttribute('title', 'Skipped — an upstream node failed.');
    await agentNode.click();
    const agentPanel = page.getByRole('dialog');
    await expect(agentPanel.getByTestId('node-run-status')).toContainText('Skipped — an upstream node failed.');
  });

  test('picking a typed event as a Trigger\'s source fills its output schema and removes the Run form', async ({ page }) => {
    await loginAsAdmin(page);
    await waitForBackend(page.request);
    await page.goto('/ui/pipelines');
    await expect(page.getByTestId('pipelines-table')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: '+ New Pipeline' }).click();
    await page.getByLabel('New pipeline name').fill('E2E Event Trigger Pipeline');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/ui\/pipelines\/\d+$/);

    await page.getByRole('button', { name: '+ Add node' }).click();
    await page.getByRole('option', { name: /^Trigger/ }).click();
    const triggerPanel = page.getByRole('dialog');
    await expect(triggerPanel).toBeVisible();

    await triggerPanel.getByLabel('Starts from').selectOption('apk:analyzed');

    // Output schema auto-filled from the real, boot-registered apk:analyzed event schema — proves
    // the hook-catalog endpoint, not a mock, actually served this. Read-only: an event-sourced
    // Trigger's schema is defined by the event, not something to author in the UI.
    const outputRows = triggerPanel.getByTestId('schema-field-row-readonly');
    await expect(outputRows.first()).toContainText('apkVersionId');
    await expect(triggerPanel.getByTestId('schema-field-row')).toHaveCount(0);
    await expect(triggerPanel.getByRole('button', { name: /remove output field/i })).toHaveCount(0);
    await expect(triggerPanel.getByRole('button', { name: /add output field/i })).toHaveCount(0);

    // No Run form for an event-sourced Trigger — nothing to click, the dispatcher starts these.
    await expect(triggerPanel.getByText(/fires automatically when "apk:analyzed"/i)).toBeVisible();
    await expect(triggerPanel.getByRole('button', { name: /^run$/i })).toHaveCount(0);
  });
});
