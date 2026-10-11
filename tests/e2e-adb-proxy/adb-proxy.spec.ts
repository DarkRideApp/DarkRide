import { test, expect, type Locator } from '@playwright/test';
import { loginAsAdmin, waitForBackend } from '../e2e/helpers/auth';
import { fingerprintOf } from '../../backend/services/adb-proxy/adb-key';
import { A_CNXN, MAX_DATA } from '../../backend/services/adb-proxy/packet';
import { makeTestAdbKey } from '../../backend/services/adb-proxy/testing/test-keys';
import { WireClient } from '../../backend/services/adb-proxy/testing/wire-client';

const SERIAL = 'FAKE-E2E-1';
const PORT = 16500;
const LAST_PORT = 16509;
// A busy machine can take longer than the wire client's 2 s default to answer.
const WAIT_MS = 5000;
const runner = makeTestAdbKey('e2e@runner');

async function boxOf(locator: Locator, what: string) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${what} is not rendered, so it has no bounding box`);
  return box;
}

test.describe.configure({ mode: 'serial' });

test.describe('ADB proxy', () => {
  // A connection with an unapproved key stays pending server-side, so every raw client is closed when its test ends.
  const clients: WireClient[] = [];
  const connect = async (): Promise<WireClient> => {
    const client = await WireClient.connect(PORT);
    clients.push(client);
    return client;
  };

  test.beforeAll(async ({ request }) => {
    await waitForBackend(request);
  });

  test.afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  test('an admin turns the proxy on and the attached device gets a port', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    await expect(page.getByRole('heading', { name: 'ADB Proxy' })).toBeVisible();
    const row = page.getByTestId(`adb-proxy-device-${SERIAL}`);
    await expect(row).toBeVisible({ timeout: 60_000 });

    await page.getByLabel('Bind address').fill('127.0.0.1');
    await page.getByLabel('First port').fill(String(PORT));
    await page.getByLabel('Last port').fill(String(LAST_PORT));
    const save = page.getByTestId('adb-proxy-save-network');
    await save.click();
    await expect(save).toHaveText('Saved');
    await page.getByRole('switch', { name: 'ADB proxy' }).click();

    await expect(page.getByRole('switch', { name: 'ADB proxy' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Enabled', { exact: true })).toBeVisible();
    await expect(row.getByText('Listening')).toBeVisible();
    await expect(row).toContainText('adb connect');
    await expect(row).toContainText(`:${PORT}`);
  });

  test('a new machine shows up live and works after an admin approves it', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    await expect(page.getByTestId('adb-proxy-pending')).toContainText('No machines are waiting for approval.');

    const waiting = await connect();
    await waiting.offerKey(runner, WAIT_MS);

    const request = page.getByTestId('adb-proxy-request');
    await expect(request).toContainText('e2e@runner');
    await expect(request).toContainText(fingerprintOf(runner.blob));
    await expect(page.getByTestId('adb-proxy-pending-badge')).toHaveText('1');

    await request.getByRole('button', { name: 'Approve' }).click();
    expect((await waiting.next(WAIT_MS)).command).toBe(A_CNXN);
    await expect(request).toHaveCount(0);
    await expect(page.getByTestId('adb-proxy-approved')).toContainText('e2e@runner');
    waiting.close();

    const session = await connect();
    expect((await session.authenticate(runner, MAX_DATA, WAIT_MS)).command).toBe(A_CNXN);
    const { localId } = await session.open('shell:echo e2e', 1, WAIT_MS);
    expect((await session.collectStream(1, localId, 'close', WAIT_MS)).toString()).toContain('ran: echo e2e');
    await expect(page.getByTestId('adb-proxy-connections')).toContainText('e2e@runner');
    session.close();
  });

  test('revoking drops a live session, blocks the key, and forgetting lets it ask again', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    const live = await connect();
    expect((await live.authenticate(runner, MAX_DATA, WAIT_MS)).command).toBe(A_CNXN);

    await page.getByTestId('adb-proxy-approved').getByRole('button', { name: 'Revoke' }).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    expect(await live.waitClosed(WAIT_MS)).toBe(true);
    await expect(page.getByTestId('adb-proxy-approved')).toContainText('No machines have been approved yet.');

    await page.getByText(/Denied and revoked \(1\)/).click();
    const blocked = page.getByTestId('adb-proxy-blocked');
    await expect(blocked).toContainText('e2e@runner');

    const refused = await connect();
    await refused.offerKey(runner, WAIT_MS);
    expect(await refused.waitClosed(WAIT_MS)).toBe(true);

    await blocked.getByRole('button', { name: 'Forget' }).click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(blocked).toHaveCount(0);
    const retry = await connect();
    await retry.offerKey(runner, WAIT_MS);
    await expect(page.getByTestId('adb-proxy-request')).toContainText('e2e@runner');
    retry.close();
    await expect(page.getByTestId('adb-proxy-request')).toHaveCount(0);
  });

  // The pending budget is 3 new requests per address per minute and this spec uses all 3 (tests 2, 3 and 4), so the
  // narrow-screen check shares this one. A fourth request needs the budget raised in the test environment or the request
  // moved to another run. Serial retries only help a test 1 warm-up failure: a retry replays the earlier requests inside
  // the same minute, and a retried test 1 would switch the proxy off again.
  test('an admin can deny a request on a narrow screen, where the table scrolls sideways', async ({ page }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 600, height: 900 });
    await page.goto('/ui/settings/adb-proxy');
    const stranger = makeTestAdbKey('stranger@box');
    const waiting = await connect();
    await waiting.offerKey(stranger, WAIT_MS);

    const card = page.getByTestId('adb-proxy-pending');
    await expect(card).toContainText('stranger@box');
    await expect(card).toHaveCSS('overflow-x', 'auto');
    await card.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const deny = card.getByRole('button', { name: 'Deny' });
    const button = await boxOf(deny, 'the Deny button');
    const bounds = await boxOf(card, 'the pending card');
    expect(button.x).toBeGreaterThanOrEqual(bounds.x);
    expect(button.x + button.width).toBeLessThanOrEqual(bounds.x + bounds.width);

    await deny.click();
    expect(await waiting.waitClosed(WAIT_MS)).toBe(true);
    await page.getByText(/Denied and revoked \(1\)/).click();
    await expect(page.getByTestId('adb-proxy-blocked')).toContainText('stranger@box');
  });

  test('turning the proxy off closes the port', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/ui/settings/adb-proxy');
    await page.getByRole('switch', { name: 'ADB proxy' }).click();
    await expect(page.getByText('Disabled', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('switch', { name: 'ADB proxy' })).toHaveAttribute('aria-checked', 'false');
    await expect(WireClient.connect(PORT)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
