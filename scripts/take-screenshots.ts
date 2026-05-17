#!/usr/bin/env npx tsx
/**
 * Automated screenshot capture for all DarkRide frontend pages.
 *
 * Starts a Vite dev server, mocks the WebSocket API with realistic data,
 * visits every page, and saves screenshots at configurable resolutions
 * and color schemes.
 *
 * Usage:
 *   npx tsx scripts/take-screenshots.ts [options]
 *
 * Options:
 *   --width N                    Viewport width (default: 1920)
 *   --height N                   Viewport height (default: 1080)
 *   --dark                       Use dark color scheme
 *   --light                      Use light color scheme (default)
 *   --both                       Capture both light and dark
 *   --output DIR                 Output directory (default: screenshots/)
 *   --page NAME                  Only screenshot a specific page
 *   --port N                     Vite dev server port (default: 5199)
 *   --help                       Show help
 */

import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, copyFileSync, existsSync, readFileSync } from 'fs';
import { resolve as pathResolve, join } from 'path';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  width: number;
  height: number;
  theme: 'light' | 'dark' | 'both';
  output: string;
  page?: string;
  port: number;
  mobile: boolean;
  coreOnly: boolean;
}

/**
 * Plugins hidden when --core-only is passed, so their nav items don't
 * leak into screenshot sidebars. By default, kitchen-sink and
 * github-monitor (demo plugins shipped publicly) are hidden so they don't
 * clutter marketing shots — additional plugins can be hidden by setting
 * DARKRIDE_SCREENSHOT_HIDE_PLUGINS to a comma-separated list.
 */
const HIDDEN_PLUGINS = [
  'kitchen-sink',
  'github-monitor',
  ...(process.env.DARKRIDE_SCREENSHOT_HIDE_PLUGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
];

/**
 * Pages skipped under --core-only. Defaults to empty; set
 * DARKRIDE_SCREENSHOT_SKIP_PAGES to a comma-separated list to exclude
 * plugin-contributed pages from marketing screenshots.
 */
const SKIPPED_PAGES = new Set(
  process.env.DARKRIDE_SCREENSHOT_SKIP_PAGES?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
);

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    width: 1920,
    height: 1080,
    theme: 'light',
    output: 'screenshots',
    port: 5199,
    mobile: false,
    coreOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--width':  opts.width = parseInt(args[++i], 10); break;
      case '--height': opts.height = parseInt(args[++i], 10); break;
      case '--dark':   opts.theme = 'dark'; break;
      case '--light':  opts.theme = 'light'; break;
      case '--both':   opts.theme = 'both'; break;
      case '--output': opts.output = args[++i]; break;
      case '--page':   opts.page = args[++i]; break;
      case '--port':   opts.port = parseInt(args[++i], 10); break;
      case '--mobile': opts.mobile = true; opts.width = 390; opts.height = 844; break;
      case '--core-only': opts.coreOnly = true; break;
      case '--help':
        console.log(`Usage: npx tsx scripts/take-screenshots.ts [options]

  --width N                    Viewport width (default: 1920)
  --height N                   Viewport height (default: 1080)
  --dark                       Use dark color scheme
  --light                      Use light color scheme (default)
  --both                       Capture both light and dark
  --output DIR                 Output directory (default: screenshots/)
  --page NAME                  Only screenshot a specific page
  --port N                     Vite dev server port (default: 5199)
  --mobile                     Use mobile viewport (390x844, iPhone 14)
  --core-only                  Hide plugins from the sidebar during capture
                               (${HIDDEN_PLUGINS.join(', ')}).
                               Use for public-repo / marketing screenshots.
  --help                       Show this help

Page names: ${PAGES.map(p => p.name).join(', ')}`);
        process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Plugin hide/restore
// ---------------------------------------------------------------------------

/**
 * Temporarily rename plugin directories listed in HIDDEN_PLUGINS to .hidden so
 * they're not picked up by Vite's import.meta.glob in frontend/plugins.ts.
 * Returns a restore function that puts them back.
 */
function hideOptionalPlugins(): () => void {
  const renamed: Array<{ from: string; to: string }> = [];
  const { renameSync } = require('fs');
  for (const name of HIDDEN_PLUGINS) {
    const from = pathResolve(process.cwd(), 'plugins', name);
    const to = pathResolve(process.cwd(), 'plugins', `.${name}.hidden`);
    if (existsSync(from)) {
      renameSync(from, to);
      renamed.push({ from, to });
      console.log(`  Hidden: plugins/${name}`);
    }
  }
  return () => {
    for (const { from, to } of renamed) {
      try { renameSync(to, from); } catch {}
    }
  };
}

// ---------------------------------------------------------------------------
// Vite dev server lifecycle
// ---------------------------------------------------------------------------

function startVite(port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(
      isWindows ? 'npx' : pathResolve('node_modules/.bin/vite'),
      isWindows ? ['vite', '--port', String(port), '--strictPort'] : ['--port', String(port), '--strictPort'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], shell: isWindows },
    );

    let started = false;
    const timer = setTimeout(() => {
      if (!started) { child.kill(); reject(new Error('Vite failed to start within 30s')); }
    }, 30_000);

    function check(data: Buffer) {
      const text = data.toString();
      if (text.includes('Local:') && !started) {
        started = true;
        clearTimeout(timer);
        // Short delay to let Vite fully initialize
        setTimeout(() => resolve(child), 500);
      }
      if (text.includes('EADDRINUSE') && !started) {
        clearTimeout(timer);
        child.kill();
        reject(new Error(`Port ${port} already in use`));
      }
    }

    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      if (!started) { clearTimeout(timer); reject(new Error(`Vite exited with code ${code}`)); }
    });
  });
}

function stopVite(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed) { resolve(); return; }
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

// ---------------------------------------------------------------------------
// Page definitions
// ---------------------------------------------------------------------------

interface PageDef {
  name: string;
  path: string;
  setup?: (page: Page) => Promise<void>;
}

const PAGES: PageDef[] = [
  { name: 'dashboard',         path: '/ui/' },
  { name: 'devices',           path: '/ui/devices' },
  { name: 'automations',       path: '/ui/automations' },
  { name: 'sessions',          path: '/ui/sessions' },
  { name: 'proxies',           path: '/ui/proxies' },
  { name: 'http-requests',     path: '/ui/proxied-requests' },
  { name: 'traffic',           path: '/ui/traffic' },
  { name: 'selector-debugger', path: '/ui/selector-debugger' },
  { name: 'utils',             path: '/ui/utils' },
  { name: 'apks',              path: '/ui/apks' },
  { name: 'credentials',       path: '/ui/credentials' },
  { name: 'settings',          path: '/ui/settings' },
  {
    name: 'frida',
    path: '/ui/frida',
    setup: async (page: Page) => {
      // Wait for device dropdown to populate from mock API
      await page.waitForFunction(
        () => document.querySelector('select.form-input option[value="pixel7_abc123"]') !== null,
        { timeout: 5000 },
      );
      // Select the device
      await page.selectOption('select.form-input', 'pixel7_abc123');
      await page.waitForTimeout(500);
      // Send a mock device frame (JPEG) so the canvas shows the phone screen
      if (mockWsRef && mockPhoneScreenJpgB64) {
        mockWsRef.send(JSON.stringify({
          type: 'device-frame',
          deviceId: 'pixel7_abc123',
          frame: mockPhoneScreenJpgB64,
        }));
      }
      // Wait for canvas render + Monaco editor init
      await page.waitForTimeout(2000);
    },
  },
  { name: 'request-builder',    path: '/ui/request-builder' },
  { name: 'cloud',              path: '/ui/cloud' },
  { name: 'api-catalogue',      path: '/ui/api-catalogue' },
  { name: 'api-explorer',       path: '/ui/api-catalogue/groups/1/explorer' },
  { name: 'jobs',               path: '/ui/jobs' },
  { name: 'automation-reviewer', path: '/ui/automations/1/history' },
  { name: 'session-timeline',   path: '/ui/automations/session/1' },
  { name: 'apk-analysis',      path: '/ui/apps/1/analysis/3' },
  {
    name: 'ai-on-apk-analysis',
    path: '/ui/apps/1/analysis/3',
    setup: async (page: Page) => {
      // Wait for the APK analysis page to render
      await page.waitForSelector('[data-testid="ai-chat-fab"]', { timeout: 8000 });
      // Open the AI drawer by clicking the FAB
      await page.click('[data-testid="ai-chat-fab"]');
      // Wait for the drawer to open
      await page.waitForSelector('[data-testid="ai-chat-drawer"]', { timeout: 5000 });
      await page.waitForTimeout(400);
      // Click the first suggested prompt ("Summarize this APK and its security findings")
      await page.waitForSelector('[data-testid="ai-chat-suggestion-0"]', { timeout: 3000 });
      await page.click('[data-testid="ai-chat-suggestion-0"]');
      // Allow the user message to appear
      await page.waitForTimeout(300);
      // The WS mock will now respond with synthetic AI streaming events:
      //   ai:tool-start → ai:tool-result → ai:token → ai:done
      // Those events are dispatched from the WS mock handler.
      // Wait for at least one ToolCallCard to appear
      await page.waitForSelector('[data-testid="tool-call-card"]', { timeout: 10000 });
      // Wait for streaming to complete (ai:done fires, status indicator disappears)
      await page.waitForSelector('[data-testid="ai-chat-streaming"]', { hidden: true, timeout: 15000 });
      // Let the UI settle
      await page.waitForTimeout(600);
    },
  },
  { name: 'device-view',       path: '/ui/devices/pixel7_abc123' },
  { name: 'automation-editor', path: '/ui/automations/1/edit' },
  {
    name: 'live-log',
    path: '/ui/',
    setup: async (page: Page) => {
      // Wait for dashboard content, then open the live log panel
      await page.waitForSelector('.page-header', { timeout: 10000 });
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('livelog:open', { detail: {} }));
      });
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'device-capture',
    path: '/ui/devices/pixel7_abc123/capture',
    setup: async (page: Page) => {
      // Wait for the capture-tab start form to render (device fetch + WS connect happens
      // after navigation, so allow generous time on slower CI machines).
      await page.waitForSelector('[data-testid="capture-tab-start-form"]', { timeout: 15000 });
      await page.waitForSelector('[data-testid="btn-start-capture"]', { timeout: 5000 });
      await page.click('[data-testid="btn-start-capture"]');
      // Wait for capture view to render with traffic panel
      await page.waitForSelector('[data-testid="capture-live-traffic"]', { timeout: 10000 });
      // Send mock traffic entries via the stored WS reference
      if (mockWsRef) {
        const captureTraffic = [
          { id: 100, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'GET',
            requestUrl: 'https://api.example.com/v2/user/profile', requestHeaders: '{"Accept":"application/json"}',
            requestBody: null, responseStatus: 200, responseBody: '{"name":"Alice","email":"alice@example.com"}',
            type: 'http', capturedAt: NOW },
          { id: 101, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'POST',
            requestUrl: 'https://api.example.com/v2/analytics/event', requestHeaders: '{"Content-Type":"application/json"}',
            requestBody: '{"event":"page_view","page":"home"}', responseStatus: 201, responseBody: '{"ok":true}',
            type: 'http', capturedAt: NOW },
          { id: 102, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'GET',
            requestUrl: 'https://cdn.example.com/images/avatar.png', requestHeaders: null,
            requestBody: null, responseStatus: 200, responseBody: null,
            type: 'http', capturedAt: NOW },
          { id: 103, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'PUT',
            requestUrl: 'https://api.example.com/v2/settings/preferences', requestHeaders: '{"Content-Type":"application/json"}',
            requestBody: '{"theme":"dark","notifications":true}', responseStatus: 200, responseBody: '{"updated":true}',
            type: 'http', capturedAt: NOW },
          { id: 104, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'GET',
            requestUrl: 'https://api.example.com/v2/feed?page=1&limit=20', requestHeaders: '{"Accept":"application/json"}',
            requestBody: null, responseStatus: 200, responseBody: '{"items":[{"id":1,"title":"Hello World"}]}',
            type: 'http', capturedAt: NOW },
          { id: 105, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'DELETE',
            requestUrl: 'https://api.example.com/v2/notifications/read', requestHeaders: null,
            requestBody: null, responseStatus: 204, responseBody: null,
            type: 'http', capturedAt: NOW },
        ];
        for (const entry of captureTraffic) {
          mockWsRef.send(JSON.stringify({ type: 'traffic-entry', entry }));
        }
        // Push a device-frame so the phone canvas shows the mock phone screen
        // (otherwise the canvas stays black until the next screenshot poll).
        if (mockPhoneScreenJpgB64) {
          mockWsRef.send(JSON.stringify({
            type: 'device-frame',
            deviceId: 'pixel7_abc123',
            frame: mockPhoneScreenJpgB64,
          }));
        }
      }
      // Wait for the next screenshot poll cycle (2s interval) to re-render
      // the canvas with correct sizing for the capture mode layout
      await page.waitForTimeout(2500);
    },
  },
  {
    name: 'capture-traffic-detail',
    path: '/ui/devices/pixel7_abc123/capture',
    setup: async (page: Page) => {
      // Start capture mode (allow time for WS + device data to settle).
      await page.waitForSelector('[data-testid="capture-tab-start-form"]', { timeout: 15000 });
      await page.waitForSelector('[data-testid="btn-start-capture"]', { timeout: 5000 });
      await page.click('[data-testid="btn-start-capture"]');
      await page.waitForSelector('[data-testid="capture-live-traffic"]', { timeout: 10000 });
      // Send mock traffic entries via the stored WS reference
      if (mockWsRef) {
        const captureTraffic = [
          { id: 200, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'GET',
            requestUrl: 'https://api.example.com/v2/user/profile', requestHeaders: '{"Accept":"application/json","Authorization":"Bearer tok_abc123"}',
            requestBody: null, responseStatus: 200, responseBody: '{"id":42,"name":"Alice","email":"alice@example.com","role":"admin"}',
            type: 'http', capturedAt: NOW },
          { id: 201, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'POST',
            requestUrl: 'https://api.example.com/v2/analytics/event', requestHeaders: '{"Content-Type":"application/json"}',
            requestBody: '{"event":"page_view","page":"home"}', responseStatus: 201, responseBody: '{"ok":true}',
            type: 'http', capturedAt: NOW },
          { id: 202, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'GET',
            requestUrl: 'https://cdn.example.com/images/avatar.png', requestHeaders: null,
            requestBody: null, responseStatus: 200, responseBody: null,
            type: 'http', capturedAt: NOW },
          { id: 203, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'PUT',
            requestUrl: 'https://api.example.com/v2/settings/preferences', requestHeaders: '{"Content-Type":"application/json"}',
            requestBody: '{"theme":"dark","notifications":true}', responseStatus: 200, responseBody: '{"updated":true}',
            type: 'http', capturedAt: NOW },
          { id: 204, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'GET',
            requestUrl: 'https://api.example.com/v2/feed?page=1&limit=20', requestHeaders: '{"Accept":"application/json"}',
            requestBody: null, responseStatus: 200, responseBody: '{"items":[{"id":1,"title":"Hello World"}]}',
            type: 'http', capturedAt: NOW },
          { id: 205, sessionId: 10, deviceId: 'pixel7_abc123', requestMethod: 'DELETE',
            requestUrl: 'https://api.example.com/v2/notifications/read', requestHeaders: null,
            requestBody: null, responseStatus: 204, responseBody: null,
            type: 'http', capturedAt: NOW },
        ];
        for (const entry of captureTraffic) {
          mockWsRef.send(JSON.stringify({ type: 'traffic-entry', entry }));
        }
      }
      // Wait for entries to render
      await page.waitForTimeout(2500);
      // Click the first traffic entry (GET /v2/user/profile) to open its detail panel
      await page.waitForSelector('[data-testid="traffic-row-compact-200"]', { timeout: 5000 });
      await page.click('[data-testid="traffic-row-compact-200"]');
      // Wait for the detail panel to expand
      await page.waitForSelector('[data-testid="traffic-row-expanded-200"]', { timeout: 5000 });
      await page.waitForTimeout(400);
    },
  },
];


// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

// Dynamic timestamps so devices pass the "seen within 2 min" online check
const NOW = new Date().toISOString();
const HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();
const DAY_AGO = new Date(Date.now() - 86_400_000).toISOString();
// Numeric epoch timestamps for components that expect milliseconds (e.g. Jobs page)
const NOW_MS = Date.now();
const HOUR_AGO_MS = Date.now() - 3_600_000;
const DAY_AGO_MS = Date.now() - 86_400_000;

const MOCK_DEVICES = [
  {
    id: 'pixel7_abc123',
    name: 'Pixel 7 Pro',
    isRooted: true,
    setupVersion: 1,
    bridgePort: 9301,
    lastSeen: NOW,
    isOnline: true,
    isBusy: false,
    batteryLevel: 87,
    androidVersion: '14',
    model: 'Pixel 7 Pro',
    manufacturer: 'Google',
  },
  {
    id: 'samsung_def456',
    name: 'Galaxy S24',
    isRooted: true,
    setupVersion: 1,
    bridgePort: 9302,
    lastSeen: HOUR_AGO,
    isOnline: true,
    isBusy: true,
    batteryLevel: 42,
    androidVersion: '15',
    model: 'SM-S921B',
    manufacturer: 'Samsung',
  },
  {
    id: 'oneplus_ghi789',
    name: 'OnePlus 12',
    isRooted: false,
    setupVersion: 1,
    bridgePort: null,
    lastSeen: DAY_AGO,
    isOnline: false,
    isBusy: false,
    batteryLevel: 15,
    androidVersion: '14',
    model: 'CPH2583',
    manufacturer: 'OnePlus',
  },
];

const EDITOR_CODE = `export default async function automation(device: DeviceAPI) {
  // Intercept and modify the API response to simulate daily reward availability
  device.http.hookResponse({ url: /https:\/\/api\.game\.com\/rewards/ }, async (res) => {
    if (!res.body) return;

    // Fake response to simulate daily reward availability
    res.body = JSON.stringify({
      ...JSON.parse(res.body),
      dailyReward: {
        available: true,
        amount: 10000000000
      }
    });
  });

  // Launch the game and collect daily login bonus
  await device.startApp('com.example.game');
  await device.waitFor({ text: 'Home' }, 15000);

  // Navigate to rewards section
  await device.click({ text: 'Rewards' });
  await device.waitFor({ text: 'Daily Login' }, 5000);

  // Claim the reward if available
  if (await device.exists({ text: 'Claim' })) {
    await device.click({ text: 'Claim' });
    await device.waitFor({ text: 'Reward Collected!' }, 5000);
    await device.screenshot('reward-claimed');
    console.log('Daily reward claimed successfully');
  } else {
    console.log('Daily reward already claimed');
  }

  // Return to home
  await device.pressKey('BACK');
  await device.sleep(1000);
}
`;

const MOCK_AUTOMATIONS = [
  {
    id: 1, name: 'Daily Login Bonus', code: EDITOR_CODE,
    passcode: '', requiresHttpsCapture: false, timeoutMs: 120000,
    isRule: false, isCaptureRule: false, priority: 0, enabled: true,
    schedule: '{"type":"cron","expressions":["0 8 * * *"]}',
    deviceFilter: null, createdAt: DAY_AGO, updatedAt: NOW,
  },
  {
    id: 2, name: 'Screenshot All Apps', code: '// Take screenshots\n',
    passcode: '', requiresHttpsCapture: false, timeoutMs: 60000,
    isRule: false, isCaptureRule: false, priority: 0, enabled: true,
    schedule: null, deviceFilter: null, createdAt: DAY_AGO, updatedAt: DAY_AGO,
  },
  {
    id: 3, name: 'Block Ads Rule', code: '// Block ad domains\n',
    passcode: '', requiresHttpsCapture: true, timeoutMs: 0,
    isRule: true, isCaptureRule: true, priority: 10, enabled: true,
    schedule: null, deviceFilter: null, createdAt: DAY_AGO, updatedAt: DAY_AGO,
  },
  {
    id: 4, name: 'Log API Calls', code: '// Log API traffic\n',
    passcode: '', requiresHttpsCapture: true, timeoutMs: 0,
    isRule: true, isCaptureRule: false, priority: 5, enabled: false,
    schedule: null, deviceFilter: null, createdAt: DAY_AGO, updatedAt: DAY_AGO,
  },
  {
    id: 5, name: 'Scrape Store Listings', code: '// Scrape listings\n',
    passcode: '', requiresHttpsCapture: false, timeoutMs: 180000,
    isRule: false, isCaptureRule: false, priority: 0, enabled: true,
    schedule: '{"type":"cron","expressions":["0 */6 * * *"]}',
    deviceFilter: null, createdAt: DAY_AGO, updatedAt: DAY_AGO,
  },
];

const MOCK_SESSIONS = [
  {
    id: 1, automationId: 1, deviceId: 'pixel7_abc123', name: 'Daily Login Bonus',
    isPinned: false, status: 'success', triggerType: 'schedule',
    logs: null, startedAt: HOUR_AGO, completedAt: NOW,
  },
  {
    id: 2, automationId: 2, deviceId: 'samsung_def456', name: 'Screenshot All Apps',
    isPinned: false, status: 'running', triggerType: 'manual',
    logs: null, startedAt: NOW, completedAt: null,
  },
  {
    id: 3, automationId: 3, deviceId: 'pixel7_abc123', name: 'Collect Game Rewards',
    isPinned: true, status: 'success', triggerType: 'schedule',
    logs: null, startedAt: HOUR_AGO, completedAt: HOUR_AGO,
  },
  {
    id: 4, automationId: 4, deviceId: 'oneplus_ghi789', name: 'Tap Through Tutorial',
    isPinned: false, status: 'failed', triggerType: 'manual',
    logs: null, startedAt: DAY_AGO, completedAt: DAY_AGO,
  },
  {
    id: 5, automationId: 1, deviceId: 'samsung_def456', name: 'Daily Login Bonus',
    isPinned: false, status: 'success', triggerType: 'schedule',
    logs: null, startedAt: DAY_AGO, completedAt: DAY_AGO,
  },
  {
    id: 6, automationId: 5, deviceId: 'pixel7_abc123', name: 'Scrape Store Listings',
    isPinned: false, status: 'success', triggerType: 'api',
    logs: null, startedAt: DAY_AGO, completedAt: DAY_AGO,
  },
  {
    id: 7, automationId: 2, deviceId: 'pixel7_abc123', name: 'Screenshot All Apps',
    isPinned: false, status: 'cancelled', triggerType: 'manual',
    logs: null, startedAt: DAY_AGO, completedAt: DAY_AGO,
  },
  {
    id: 8, automationId: 1, deviceId: 'oneplus_ghi789', name: 'Daily Login Bonus',
    isPinned: false, status: 'success', triggerType: 'schedule',
    logs: null, startedAt: DAY_AGO, completedAt: DAY_AGO,
  },
];

const MOCK_PROXIES = [
  {
    id: 1, url: 'http://proxy-us-east.example.com:8080',
    username: 'user1', password: '********',
    failureCount: 0, enabled: true, createdAt: DAY_AGO,
  },
  {
    id: 2, url: 'http://proxy-eu-west.example.com:8080',
    username: 'user2', password: '********',
    failureCount: 3, enabled: true, createdAt: DAY_AGO,
  },
];

const MOCK_CREDENTIALS = [
  {
    id: 1, appId: 'com.example.social', username: 'alice@example.com',
    password: '********', customFields: null,
    createdAt: DAY_AGO, updatedAt: DAY_AGO, lastUsedAt: HOUR_AGO,
  },
  {
    id: 2, appId: 'com.example.social', username: 'bob@example.com',
    password: '********', customFields: null,
    createdAt: DAY_AGO, updatedAt: DAY_AGO, lastUsedAt: DAY_AGO,
  },
  {
    id: 3, appId: 'com.example.game', username: 'player1',
    password: '********', customFields: { server: 'us-west' },
    createdAt: DAY_AGO, updatedAt: DAY_AGO, lastUsedAt: null,
  },
];

const MOCK_TRAFFIC: any[] = [
  {
    id: 1, sessionId: 1, deviceId: 'pixel7_abc123',
    requestMethod: 'GET', requestUrl: 'https://api.example.com/v2/user/profile',
    requestHeaders: '{"Accept":"application/json","Authorization":"Bearer tok_****"}',
    requestBody: null,
    responseStatus: 200, responseBody: '{"id":42,"name":"Alice","role":"admin"}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: NOW,
  },
  {
    id: 2, sessionId: 1, deviceId: 'pixel7_abc123',
    requestMethod: 'POST', requestUrl: 'https://api.example.com/v2/events',
    requestHeaders: '{"Content-Type":"application/json"}',
    requestBody: '{"event":"login","timestamp":1775719835}',
    responseStatus: 201, responseBody: '{"ok":true,"eventId":"evt_abc123"}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: NOW,
  },
  {
    id: 3, sessionId: null, deviceId: 'pixel7_abc123',
    requestMethod: 'GET', requestUrl: 'wss://realtime.example.com/feed?channel=updates',
    requestHeaders: '{"Upgrade":"websocket","Sec-WebSocket-Protocol":"mqtt"}',
    requestBody: null,
    responseStatus: 101, responseBody: null,
    type: 'websocket', wsCloseCode: null, wsCloseReason: null, wsMessageCount: 142,
    capturedAt: NOW,
  },
  {
    id: 4, sessionId: 2, deviceId: 'samsung_def456',
    requestMethod: 'GET', requestUrl: 'https://cdn.example.com/assets/config.json',
    requestHeaders: null, requestBody: null,
    responseStatus: 304, responseBody: null,
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: NOW,
  },
  {
    id: 5, sessionId: 1, deviceId: 'pixel7_abc123',
    requestMethod: 'GET', requestUrl: 'https://api.example.com/v2/feed?limit=20&offset=0',
    requestHeaders: '{"Accept":"application/json"}', requestBody: null,
    responseStatus: 200, responseBody: '{"items":[{"id":1,"title":"Morning news"}]}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: NOW,
  },
  {
    id: 6, sessionId: 1, deviceId: 'pixel7_abc123',
    requestMethod: 'PUT', requestUrl: 'https://api.example.com/v2/settings/theme',
    requestHeaders: '{"Content-Type":"application/json"}',
    requestBody: '{"theme":"dark","accent":"blue"}',
    responseStatus: 200, responseBody: '{"updated":true}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: HOUR_AGO,
  },
  {
    id: 7, sessionId: null, deviceId: 'samsung_def456',
    requestMethod: 'POST', requestUrl: 'https://analytics.example.com/batch',
    requestHeaders: '{"Content-Type":"application/json"}',
    requestBody: '{"events":[{"type":"tap","target":"home_btn"}]}',
    responseStatus: 202, responseBody: '{"accepted":1}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: HOUR_AGO,
  },
  {
    id: 8, sessionId: 1, deviceId: 'pixel7_abc123',
    requestMethod: 'GET', requestUrl: 'https://api.example.com/v2/notifications',
    requestHeaders: '{"Accept":"application/json"}', requestBody: null,
    responseStatus: 200, responseBody: '{"unread":3,"items":[]}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: HOUR_AGO,
  },
  {
    id: 9, sessionId: 1, deviceId: 'pixel7_abc123',
    requestMethod: 'DELETE', requestUrl: 'https://api.example.com/v2/notifications/47',
    requestHeaders: null, requestBody: null,
    responseStatus: 204, responseBody: null,
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: HOUR_AGO,
  },
  {
    id: 10, sessionId: null, deviceId: 'pixel7_abc123',
    requestMethod: 'GET', requestUrl: 'https://api.example.com/v2/search?q=hello',
    requestHeaders: '{"Accept":"application/json"}', requestBody: null,
    responseStatus: 429, responseBody: '{"error":"rate_limited"}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: HOUR_AGO,
  },
  {
    id: 11, sessionId: 1, deviceId: 'pixel7_abc123',
    requestMethod: 'PUT', requestUrl: 'https://api.example.com/v2/settings',
    requestHeaders: '{"Content-Type":"application/json"}',
    requestBody: '{"locale":"en-GB"}',
    responseStatus: 403, responseBody: '{"error":"forbidden"}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: DAY_AGO,
  },
  {
    id: 12, sessionId: null, deviceId: 'oneplus_ghi789',
    requestMethod: 'POST', requestUrl: 'https://api.example.com/v2/auth/refresh',
    requestHeaders: '{"Content-Type":"application/json"}',
    requestBody: '{"refresh_token":"****"}',
    responseStatus: 200, responseBody: '{"access_token":"****","expires_in":3600}',
    type: 'http', wsCloseCode: null, wsCloseReason: null, wsMessageCount: null,
    capturedAt: DAY_AGO,
  },
];

const MOCK_TRACKED_APPS = [
  {
    id: 1, packageName: 'com.example.social', appName: 'ExampleSocial',
    createdAt: DAY_AGO, versionCount: 3,
    latestVersion: {
      id: 3, trackedAppId: 1, versionCode: 2024012000, versionName: '24.1.20',
      filename: '2024012000_24.1.20.apk', fileSize: 48_500_000,
      deviceId: 'pixel7_abc123', downloadedAt: NOW,
    },
  },
  {
    id: 2, packageName: 'com.example.game', appName: 'Fun Game',
    createdAt: DAY_AGO, versionCount: 1,
    latestVersion: {
      id: 4, trackedAppId: 2, versionCode: 100, versionName: '1.0.0',
      filename: '100_1.0.0.apk', fileSize: 125_000_000,
      deviceId: 'samsung_def456', downloadedAt: DAY_AGO,
    },
  },
  {
    id: 3, packageName: 'com.android.chrome', appName: 'Chrome',
    createdAt: DAY_AGO, versionCount: 2,
    latestVersion: {
      id: 6, trackedAppId: 3, versionCode: 633019934, versionName: '133.0.6917.134',
      filename: '633019934_133.0.6917.134.apk', fileSize: 210_300_000,
      deviceId: 'pixel7_abc123', downloadedAt: HOUR_AGO,
    },
  },
  {
    id: 4, packageName: 'com.spotify.music', appName: 'Spotify',
    createdAt: DAY_AGO, versionCount: 1,
    latestVersion: {
      id: 7, trackedAppId: 4, versionCode: 8912050, versionName: '8.9.12',
      filename: '8912050_8.9.12.apk', fileSize: 67_800_000,
      deviceId: 'pixel7_abc123', downloadedAt: HOUR_AGO,
    },
  },
];

const MOCK_RECENT_DOWNLOADS = [
  {
    id: 6, trackedAppId: 3, versionCode: 633019934, versionName: '133.0.6917.134',
    filename: '633019934_133.0.6917.134.apk', fileSize: 210_300_000,
    deviceId: 'pixel7_abc123', downloadedAt: HOUR_AGO,
    packageName: 'com.android.chrome', appName: 'Chrome',
  },
  {
    id: 7, trackedAppId: 4, versionCode: 8912050, versionName: '8.9.12',
    filename: '8912050_8.9.12.apk', fileSize: 67_800_000,
    deviceId: 'pixel7_abc123', downloadedAt: HOUR_AGO,
    packageName: 'com.spotify.music', appName: 'Spotify',
  },
  {
    id: 3, trackedAppId: 1, versionCode: 2024012000, versionName: '24.1.20',
    filename: '2024012000_24.1.20.apk', fileSize: 48_500_000,
    deviceId: 'pixel7_abc123', downloadedAt: NOW,
    packageName: 'com.example.social', appName: 'ExampleSocial',
  },
  {
    id: 2, trackedAppId: 1, versionCode: 2024011500, versionName: '24.1.15',
    filename: '2024011500_24.1.15.apk', fileSize: 47_200_000,
    deviceId: 'samsung_def456', downloadedAt: DAY_AGO,
    packageName: 'com.example.social', appName: 'ExampleSocial',
  },
  {
    id: 4, trackedAppId: 2, versionCode: 100, versionName: '1.0.0',
    filename: '100_1.0.0.apk', fileSize: 125_000_000,
    deviceId: 'samsung_def456', downloadedAt: DAY_AGO,
    packageName: 'com.example.game', appName: 'Fun Game',
  },
  {
    id: 5, trackedAppId: 3, versionCode: 632015000, versionName: '132.0.6834.163',
    filename: '632015000_132.0.6834.163.apk', fileSize: 208_100_000,
    deviceId: 'pixel7_abc123', downloadedAt: DAY_AGO,
    packageName: 'com.android.chrome', appName: 'Chrome',
  },
];

const MOCK_INJECTED_APKS = [
  {
    id: 1, packageName: 'com.example.game', versionCode: 100,
    fridaVersion: '16.6.6', createdAt: HOUR_AGO,
  },
];

const MOCK_ANALYSIS_OVERVIEW = {
  appName: 'ExampleSocial',
  packageName: 'com.example.social',
  versionCode: 2024012000,
  versionName: '24.1.20',
  manifest: {
    package: 'com.example.social',
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.CAMERA',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.VIBRATE',
      'android.permission.WAKE_LOCK',
      'com.google.android.c2dm.permission.RECEIVE',
    ],
    activities: [
      'com.example.social.MainActivity',
      'com.example.social.LoginActivity',
      'com.example.social.ProfileActivity',
      'com.example.social.SettingsActivity',
      'com.example.social.ChatActivity',
      'com.example.social.MediaViewerActivity',
    ],
    services: [
      'com.example.social.SyncService',
      'com.example.social.MessagingService',
      'com.example.social.LocationService',
    ],
    receivers: [
      'com.example.social.BootReceiver',
      'com.example.social.PushReceiver',
    ],
    providers: [
      'com.example.social.DataProvider',
      'androidx.core.content.FileProvider',
    ],
    min_sdk: 24,
    target_sdk: 34,
    stage_timings: JSON.stringify({
      metadata: { start: 1708000000000, end: 1708000002300 },
      decompile: { start: 1708000002300, end: 1708000274500 },
      store: { start: 1708000274500, end: 1708000281200 },
      scan: { start: 1708000281200, end: 1708000295800 },
    }),
    total_duration_ms: '295800',
  },
  findingCounts: { critical: 3, high: 12, medium: 28, low: 15, info: 7 },
  findingsByCategory: { secret: 8, url: 6, crypto: 11, network: 14, certificate: 3, permission: 5 },
  fileCount: 1847,
  totalSize: 48_500_000,
  sourceCounts: { jadx: 1623, apktool: 224 },
};

const MOCK_ANALYSIS_FINDINGS = [
  { id: 1, filePath: 'sources/com/example/social/api/ApiClient.java', fileSource: 'jadx', ruleId: 'hardcoded-secret', severity: 'critical', title: 'Hardcoded API Key', description: 'API key found hardcoded in source code', lineNumber: 42, matchedText: 'AIzaSyD-FAKE_KEY_FOR_DEMO_1234567890', category: 'secret' },
  { id: 2, filePath: 'sources/com/example/social/auth/AuthManager.java', fileSource: 'jadx', ruleId: 'hardcoded-secret', severity: 'critical', title: 'Hardcoded Secret', description: 'Secret token found in source', lineNumber: 87, matchedText: 'sk_live_FAKE_SECRET_TOKEN_demo', category: 'secret' },
  { id: 3, filePath: 'sources/com/example/social/network/TlsConfig.java', fileSource: 'jadx', ruleId: 'weak-tls', severity: 'critical', title: 'Weak TLS Configuration', description: 'TLS 1.0/1.1 is enabled', lineNumber: 23, matchedText: 'TLSv1', category: 'crypto' },
  { id: 4, filePath: 'sources/com/example/social/network/HttpClient.java', fileSource: 'jadx', ruleId: 'cleartext-traffic', severity: 'high', title: 'Cleartext HTTP Traffic', description: 'HTTP URL used instead of HTTPS', lineNumber: 156, matchedText: 'http://api.example.com/v1/', category: 'network' },
  { id: 5, filePath: 'sources/com/example/social/crypto/CryptoHelper.java', fileSource: 'jadx', ruleId: 'weak-cipher', severity: 'high', title: 'Weak Cipher Algorithm', description: 'DES cipher is insecure', lineNumber: 34, matchedText: 'DES/ECB/PKCS5Padding', category: 'crypto' },
  { id: 6, filePath: 'sources/com/example/social/data/SharedPrefs.java', fileSource: 'jadx', ruleId: 'world-readable', severity: 'high', title: 'World-Readable SharedPreferences', description: 'SharedPreferences created with MODE_WORLD_READABLE', lineNumber: 19, matchedText: 'MODE_WORLD_READABLE', category: 'crypto' },
  { id: 7, filePath: 'res/xml/network_security_config.xml', fileSource: 'apktool', ruleId: 'trust-all-certs', severity: 'high', title: 'Trust All Certificates', description: 'Network security config allows user certificates', lineNumber: 5, matchedText: '<certificates src="user" />', category: 'certificate' },
  { id: 8, filePath: 'sources/com/example/social/util/Logger.java', fileSource: 'jadx', ruleId: 'debug-logging', severity: 'medium', title: 'Debug Logging Enabled', description: 'Verbose logging may leak sensitive data', lineNumber: 12, matchedText: 'Log.d(TAG, "Token: " + token)', category: 'network' },
  { id: 9, filePath: 'sources/com/example/social/location/LocationTracker.java', fileSource: 'jadx', ruleId: 'fine-location', severity: 'medium', title: 'Fine Location Access', description: 'App requests precise GPS location', lineNumber: 45, matchedText: 'ACCESS_FINE_LOCATION', category: 'permission' },
  { id: 10, filePath: 'sources/com/example/social/push/PushHandler.java', fileSource: 'jadx', ruleId: 'exported-component', severity: 'medium', title: 'Exported Broadcast Receiver', description: 'Receiver is exported without permission', lineNumber: 8, matchedText: 'exported="true"', category: 'network' },
  { id: 11, filePath: 'sources/com/example/social/db/DatabaseHelper.java', fileSource: 'jadx', ruleId: 'sql-injection', severity: 'high', title: 'Potential SQL Injection', description: 'Raw SQL query with string concatenation', lineNumber: 67, matchedText: '"SELECT * FROM users WHERE id=" + userId', category: 'crypto' },
  { id: 12, filePath: 'sources/com/example/social/webview/WebViewActivity.java', fileSource: 'jadx', ruleId: 'js-interface', severity: 'high', title: 'JavaScript Interface Exposed', description: 'addJavascriptInterface may be exploited on older Android', lineNumber: 31, matchedText: 'addJavascriptInterface', category: 'network' },
];

const MOCK_ANALYSIS_STRINGS = {
  urls: [
    { url: 'https://api.example.com/v2/auth/login', domain: 'api.example.com', filePath: 'sources/com/example/social/api/ApiClient.java', fileSource: 'jadx', lineNumber: 15 },
    { url: 'https://cdn.example.com/assets/', domain: 'cdn.example.com', filePath: 'sources/com/example/social/media/MediaLoader.java', fileSource: 'jadx', lineNumber: 23 },
    { url: 'https://analytics.example.com/track', domain: 'analytics.example.com', filePath: 'sources/com/example/social/tracking/Analytics.java', fileSource: 'jadx', lineNumber: 8 },
    { url: 'https://push.example.com/register', domain: 'push.example.com', filePath: 'sources/com/example/social/push/PushManager.java', fileSource: 'jadx', lineNumber: 44 },
    { url: 'http://debug.example.com/logs', domain: 'debug.example.com', filePath: 'sources/com/example/social/util/Logger.java', fileSource: 'jadx', lineNumber: 56 },
    { url: 'https://graph.facebook.com/v18.0/', domain: 'graph.facebook.com', filePath: 'sources/com/example/social/auth/FacebookAuth.java', fileSource: 'jadx', lineNumber: 12 },
    { url: 'https://firebaseinstallations.googleapis.com/', domain: 'firebaseinstallations.googleapis.com', filePath: 'sources/com/google/firebase/installations/FirebaseInstallations.java', fileSource: 'jadx', lineNumber: 89 },
  ],
  strings: [
    { value: 'AIzaSyD-FAKE_KEY_FOR_DEMO_1234567890', type: 'api-key', filePath: 'sources/com/example/social/api/ApiClient.java', fileSource: 'jadx', lineNumber: 42 },
    { value: 'sk_live_FAKE_SECRET_TOKEN_demo_value', type: 'secret', filePath: 'sources/com/example/social/auth/AuthManager.java', fileSource: 'jadx', lineNumber: 87 },
    { value: 'dGhpcyBpcyBhIGZha2UgYmFzZTY0IHNlY3JldA==', type: 'base64-secret', filePath: 'sources/com/example/social/crypto/CryptoHelper.java', fileSource: 'jadx', lineNumber: 19 },
    { value: '192.168.1.100', type: 'ip-address', filePath: 'sources/com/example/social/network/DebugConfig.java', fileSource: 'jadx', lineNumber: 7 },
    { value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw', type: 'token', filePath: 'sources/com/example/social/auth/TokenStore.java', fileSource: 'jadx', lineNumber: 33 },
    { value: '-----BEGIN RSA PRIVATE KEY-----', type: 'private-key', filePath: 'res/raw/debug_key.pem', fileSource: 'apktool', lineNumber: 1 },
  ],
};

const MOCK_BLOCKED_DOMAINS = [
  { id: 1, domain: 'ads.doubleclick.net', createdAt: DAY_AGO },
  { id: 2, domain: 'tracker.facebook.com', createdAt: DAY_AGO },
  { id: 3, domain: 'analytics.tiktok.com', createdAt: DAY_AGO },
];

const MOCK_HIDDEN_DOMAINS = [
  { id: 1, domain: 'connectivitycheck.gstatic.com', createdAt: DAY_AGO },
  { id: 2, domain: 'time.android.com', createdAt: DAY_AGO },
];

const MOCK_FRIDA_SCRIPTS = [
  {
    id: 1, name: 'Root Detection Bypass', targetApp: 'com.example.game',
    code: `Java.perform(function() {\n  var RootCheck = Java.use('com.example.RootDetector');\n  RootCheck.isRooted.implementation = function() {\n    console.log('[DarkRide] Bypassing root check');\n    return false;\n  };\n});`,
    createdAt: DAY_AGO, updatedAt: NOW,
  },
  {
    id: 2, name: 'SSL Pinning Bypass', targetApp: null,
    code: `// Generic SSL pinning bypass\nJava.perform(function() {\n  // ...\n});`,
    createdAt: DAY_AGO, updatedAt: DAY_AGO,
  },
  {
    id: 3, name: 'API Response Logger', targetApp: 'com.example.social',
    code: `// Log all OkHttp responses\nJava.perform(function() {\n  // ...\n});`,
    createdAt: DAY_AGO, updatedAt: DAY_AGO,
  },
];

const MOCK_FRIDA_RELEASES = [
  { version: '16.6.6', releaseDate: '2025-02-01', isDownloaded: true, fileSize: 42_500_000 },
  { version: '16.6.5', releaseDate: '2025-01-15', isDownloaded: true, fileSize: 42_200_000 },
  { version: '16.6.4', releaseDate: '2024-12-20', isDownloaded: false, fileSize: null },
  { version: '16.6.3', releaseDate: '2024-12-01', isDownloaded: false, fileSize: null },
];

const MOCK_FRIDA_APPS = [
  { name: 'Chrome', identifier: 'com.android.chrome', pid: 1234 },
  { name: 'ExampleSocial', identifier: 'com.example.social', pid: 5678 },
  { name: 'Fun Game', identifier: 'com.example.game', pid: null },
  { name: 'Settings', identifier: 'com.android.settings', pid: 901 },
  { name: 'YouTube', identifier: 'com.google.android.youtube', pid: 2345 },
];

const MOCK_SETTINGS = [
  { key: 'nordvpn_username', value: 'user@example.com' },
  { key: 'nordvpn_password', value: '********' },
  { key: 'frida_default_version', value: '16.6.6' },
  { key: 'frida_last_sync', value: NOW },
];

const MOCK_PROXIED_HISTORY = [
  {
    id: 'req-001', url: 'https://httpbin.org/get', method: 'GET',
    status: 'completed', createdAt: HOUR_AGO, completedAt: NOW,
    result: { status: 200, body: '{"origin":"1.2.3.4"}' }, error: null,
  },
  {
    id: 'req-002', url: 'https://httpbin.org/post', method: 'POST',
    status: 'failed', createdAt: HOUR_AGO, completedAt: HOUR_AGO,
    result: null, error: 'Connection timeout',
  },
];

const MOCK_CLOUD_STATUS = {
  configured: true,
  localCacheUsageMb: 1240,
  localCacheBudgetMb: 5000,
  filesTracked: 847,
  filesCloudOnly: 312,
  pendingUploads: 3,
  errors: [],
};

const MOCK_CLOUD_FILES = {
  prefixes: ['apks/', 'screenshots/', 'exports/'],
  files: [
    { key: 'config.json', size: 2048, lastModified: NOW },
    { key: 'device-registry.json', size: 4096, lastModified: HOUR_AGO },
  ],
};

const MOCK_API_CATALOGUE_ENDPOINTS = [
  { id: 1, method: 'GET', hostname: 'api.example.com', pathPattern: '/v2/user/profile', firstSeen: DAY_AGO, lastSeen: NOW, requestCount: 47, sampleResponseStatus: 200, groupId: 1, groupName: 'User API' },
  { id: 2, method: 'POST', hostname: 'api.example.com', pathPattern: '/v2/auth/login', firstSeen: DAY_AGO, lastSeen: HOUR_AGO, requestCount: 12, sampleResponseStatus: 200, groupId: 2, groupName: 'Auth' },
  { id: 3, method: 'GET', hostname: 'cdn.example.com', pathPattern: '/assets/*', firstSeen: DAY_AGO, lastSeen: NOW, requestCount: 230, sampleResponseStatus: 200, groupId: null, groupName: null },
  { id: 4, method: 'POST', hostname: 'analytics.example.com', pathPattern: '/v1/track', firstSeen: DAY_AGO, lastSeen: NOW, requestCount: 1580, sampleResponseStatus: 204, groupId: 3, groupName: 'Analytics' },
  { id: 5, method: 'PUT', hostname: 'api.example.com', pathPattern: '/v2/settings', firstSeen: HOUR_AGO, lastSeen: NOW, requestCount: 3, sampleResponseStatus: 200, groupId: 1, groupName: 'User API' },
  { id: 6, method: 'GET', hostname: 'api.example.com', pathPattern: '/v2/feed', firstSeen: DAY_AGO, lastSeen: NOW, requestCount: 89, sampleResponseStatus: 200, groupId: null, groupName: null },
  { id: 7, method: 'DELETE', hostname: 'api.example.com', pathPattern: '/v2/notifications/*', firstSeen: HOUR_AGO, lastSeen: HOUR_AGO, requestCount: 5, sampleResponseStatus: 204, groupId: null, groupName: null },
  { id: 8, method: 'POST', hostname: 'push.example.com', pathPattern: '/register', firstSeen: DAY_AGO, lastSeen: DAY_AGO, requestCount: 2, sampleResponseStatus: 201, groupId: null, groupName: null },
  { id: 9, method: 'GET', hostname: 'graph.facebook.com', pathPattern: '/v18.0/me', firstSeen: DAY_AGO, lastSeen: HOUR_AGO, requestCount: 8, sampleResponseStatus: 200, groupId: 2, groupName: 'Auth' },
  { id: 10, method: 'PATCH', hostname: 'api.example.com', pathPattern: '/v2/user/avatar', firstSeen: HOUR_AGO, lastSeen: NOW, requestCount: 1, sampleResponseStatus: 200, groupId: 1, groupName: 'User API' },
];

const MOCK_API_CATALOGUE_GROUPS = [
  { id: 1, name: 'User API', description: 'User profile and settings endpoints', createdAt: DAY_AGO, endpointCount: 3, patterns: [{ id: 1, groupId: 1, pattern: 'api.example.com/v2/user/*', patternType: 'wildcard' }] },
  { id: 2, name: 'Auth', description: 'Authentication and OAuth flows', createdAt: DAY_AGO, endpointCount: 2, patterns: [{ id: 2, groupId: 2, pattern: '*/auth/*', patternType: 'wildcard' }] },
  { id: 3, name: 'Analytics', description: 'Tracking and analytics events', createdAt: DAY_AGO, endpointCount: 1, patterns: [{ id: 3, groupId: 3, pattern: 'analytics.*', patternType: 'wildcard' }] },
];

const MOCK_JOBS = [
  { id: 'sync-frida', name: 'Sync Frida Releases', description: 'Check for new Frida server releases on GitHub', category: 'sync', schedule: '0 */6 * * *', defaultSchedule: '0 */6 * * *', canRunManually: true, enabled: true, lastRunAt: HOUR_AGO_MS, lastError: null, status: 'success' },
  { id: 'sync-apks', name: 'Sync APK Versions', description: 'Check tracked apps for new versions on connected devices', category: 'sync', schedule: '*/30 * * * *', defaultSchedule: '*/30 * * * *', canRunManually: true, enabled: true, lastRunAt: NOW_MS, lastError: null, status: 'running' },
  { id: 'prune-db', name: 'Prune Database', description: 'Remove old sessions, traffic entries, and orphaned screenshots', category: 'maintenance', schedule: '0 3 * * *', defaultSchedule: '0 3 * * *', canRunManually: true, enabled: true, lastRunAt: DAY_AGO_MS, lastError: null, status: 'success' },
  { id: 'cleanup-temp', name: 'Cleanup Temp Files', description: 'Remove temporary files from analysis and captures', category: 'maintenance', schedule: '0 4 * * *', defaultSchedule: '0 4 * * *', canRunManually: false, enabled: true, lastRunAt: DAY_AGO_MS, lastError: null, status: 'success' },
  { id: 'cloud-sync', name: 'Cloud Sync', description: 'Upload new files to cloud storage and download missing files', category: 'sync', schedule: '*/15 * * * *', defaultSchedule: '*/15 * * * *', canRunManually: true, enabled: false, lastRunAt: DAY_AGO_MS, lastError: 'Connection timeout after 30s', status: 'error' },
  { id: 'analysis-scan', name: 'APK Analysis Scan', description: 'Run security analysis on newly downloaded APKs', category: 'analysis', schedule: '0 */2 * * *', defaultSchedule: '0 */2 * * *', canRunManually: true, enabled: true, lastRunAt: HOUR_AGO_MS, lastError: null, status: 'success' },
];

const MOCK_SESSION_DETAIL = {
  session: {
    id: 1, automationId: 1, deviceId: 'pixel7_abc123', name: 'Daily Login Bonus',
    isPinned: false, status: 'success', triggerType: 'schedule',
    logs: JSON.stringify([
      { timestamp: HOUR_AGO, method: 'startApp', params: ['com.example.game'], durationMs: 1200, error: null, result: null },
      { timestamp: HOUR_AGO, method: 'waitFor', params: [{ text: 'Home' }, 15000], durationMs: 3400, error: null, result: true },
      { timestamp: HOUR_AGO, method: 'click', params: [{ text: 'Rewards' }], durationMs: 180, error: null, result: null },
      { timestamp: HOUR_AGO, method: 'waitFor', params: [{ text: 'Daily Login' }, 5000], durationMs: 850, error: null, result: true },
      { timestamp: HOUR_AGO, method: 'exists', params: [{ text: 'Claim' }], durationMs: 120, error: null, result: true },
      { timestamp: HOUR_AGO, method: 'click', params: [{ text: 'Claim' }], durationMs: 200, error: null, result: null },
      { timestamp: HOUR_AGO, method: 'waitFor', params: [{ text: 'Reward Collected!' }, 5000], durationMs: 1100, error: null, result: true },
      { timestamp: HOUR_AGO, method: 'screenshot', params: ['reward-claimed'], durationMs: 450, error: null, result: null, screenshotFilename: 'reward-claimed.png' },
      { timestamp: HOUR_AGO, method: 'console.log', params: ['Daily reward claimed successfully'], durationMs: 0, error: null, result: null },
      { timestamp: HOUR_AGO, method: 'pressKey', params: ['BACK'], durationMs: 150, error: null, result: null },
      { timestamp: HOUR_AGO, method: 'sleep', params: [1000], durationMs: 1000, error: null, result: null },
    ]),
    startedAt: HOUR_AGO, completedAt: NOW,
  },
  screenshots: [
    { filename: 'reward-claimed.png', name: 'reward-claimed', capturedAt: HOUR_AGO, domSnapshot: null },
  ],
};

const MOCK_INTERCEPT_RULES = [
  {
    id: 1, name: 'Force Admin Mode', enabled: true,
    matchHostname: '*.example.com', matchPath: '/v2/user/*', matchMethod: null,
    phase: 'response', actions: JSON.stringify([
      { type: 'json-patch', path: '$.data.isAdmin', value: true },
      { type: 'json-patch', path: '$.data.permissions.admin', value: true },
    ]),
    deviceFilter: null, priority: 0, sessionId: null,
    createdAt: DAY_AGO, updatedAt: NOW,
  },
  {
    id: 2, name: 'Fake Theme Park Location', enabled: true,
    matchHostname: 'api.themepark.com', matchPath: '/v1/location/*', matchMethod: null,
    phase: 'response', actions: JSON.stringify([
      { type: 'json-patch', path: '$.isInThemePark', value: true },
      { type: 'json-patch', path: '$.data.location.inPark', value: true },
    ]),
    deviceFilter: null, priority: 1, sessionId: null,
    createdAt: DAY_AGO, updatedAt: DAY_AGO,
  },
  {
    id: 3, name: 'Inject Debug Header', enabled: false,
    matchHostname: '*', matchPath: null, matchMethod: null,
    phase: 'request', actions: JSON.stringify([
      { type: 'header-set', name: 'X-Debug', value: 'true' },
    ]),
    deviceFilter: null, priority: 10, sessionId: null,
    createdAt: DAY_AGO, updatedAt: DAY_AGO,
  },
];

const MOCK_CLIENT_CERTS = [
  {
    id: 1, name: 'PortAventura',
    hostnames: JSON.stringify(['cms-v2.adventurelabs.xyz', 'api-v2.adventurelabs.xyz']),
    certPem: '-----BEGIN CERTIFICATE-----\nMIIBkTCB...\n-----END CERTIFICATE-----',
    keyPem: '-----BEGIN PRIVATE KEY-----\nMIIEvgIB...\n-----END PRIVATE KEY-----',
    enabled: true, sessionId: null, createdAt: DAY_AGO,
  },
];

// Parse query string helper
function parseQuery(path: string): Record<string, string> {
  const idx = path.indexOf('?');
  if (idx === -1) return {};
  const params: Record<string, string> = {};
  path.slice(idx + 1).split('&').forEach(kv => {
    const [k, v] = kv.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
  });
  return params;
}

// Route key is "METHOD /path" (without query string)
const MOCK_RESPONSES: Record<string, (fullPath: string) => any> = {
  'GET /v1/device/list': () => ({
    success: true,
    data: MOCK_DEVICES,
  }),

  'GET /v1/device/view': () => ({
    success: true,
    data: MOCK_DEVICES[0],
  }),

  'GET /v1/device/screenshot': () => ({
    success: true,
    data: mockPhoneScreenB64 ? { image: mockPhoneScreenB64 } : null,
  }),

  'GET /v1/capture/status': () => ({
    success: true,
    data: { capturing: false },
  }),

  'POST /v1/capture/start': () => ({
    success: true,
    data: { sessionId: 10 },
  }),

  'POST /v1/capture/stop': () => ({
    success: true,
    data: {},
  }),

  'GET /v1/automation/list': () => ({
    success: true,
    data: MOCK_AUTOMATIONS,
  }),

  'GET /v1/automation/queue/status': () => ({
    success: true,
    data: {
      queue: [],
      processingQueue: false,
      devices: [
        { id: 'pixel7_abc123', online: true, busy: false },
        { id: 'samsung_s23_def456', online: true, busy: true },
      ],
    },
  }),

  'GET /v1/automation/view': () => ({
    success: true,
    data: MOCK_AUTOMATIONS[0],
  }),

  'GET /v1/automation/types': () => ({
    success: true,
    data: `declare interface DeviceAPI {
  click(selector: Selector): Promise<void>;
  longClick(selector: Selector, durationMs?: number): Promise<void>;
  waitFor(selector: Selector, timeoutMs?: number): Promise<void>;
  waitForAndClick(selector: Selector, timeoutMs?: number): Promise<void>;
  exists(selector: Selector): Promise<boolean>;
  setText(selector: Selector, text: string): Promise<void>;
  getText(selector: Selector): Promise<string>;
  scroll(direction: 'up' | 'down', percent?: number): Promise<void>;
  scrollToElement(selector: Selector): Promise<void>;
  swipe(startX: number, startY: number, endX: number, endY: number, durationMs?: number): Promise<void>;
  tapAt(x: number, y: number): Promise<void>;
  pressKey(key: string): Promise<void>;
  startApp(packageName: string): Promise<void>;
  stopApp(packageName: string): Promise<void>;
  deviceInfo(): Promise<any>;
  getDOM(): Promise<any>;
  screenshot(label?: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  httpGet(url: string, headers?: Record<string, string>): Promise<any>;
  httpPost(url: string, body?: any, headers?: Record<string, string>): Promise<any>;
  getCredentials(appId: string): Promise<any>;
  pressButton(selector: Selector): Promise<void>;
  existsAny(selectors: Selector[]): Promise<number>;
  clickAny(selectors: Selector[]): Promise<number>;
  setProxy(mode: string, options?: any): Promise<void>;
  setTlsProfile(profile: string): Promise<void>;
  http: TrafficHookAPI;
}
declare interface Selector { text?: string; resourceId?: string; className?: string; description?: string; }
declare interface TrafficHookAPI { hook(filter: any, onReq?: any, onResp?: any): string; unhook(id: string): void; unhookAll(): void; }
declare const device: DeviceAPI;`,
  }),

  'GET /v1/automation/sessions': (fullPath: string) => {
    const q = parseQuery(fullPath);
    const limit = parseInt(q.limit || '50', 10);
    const offset = parseInt(q.offset || '0', 10);
    return {
      success: true,
      data: {
        items: MOCK_SESSIONS.slice(offset, offset + limit),
        total: MOCK_SESSIONS.length,
        limit,
        offset,
      },
    };
  },

  'GET /v1/proxy/list': () => ({
    success: true,
    data: MOCK_PROXIES,
  }),

  'GET /v1/credentials/list': () => ({
    success: true,
    data: MOCK_CREDENTIALS,
  }),

  'GET /v1/traffic/list': (fullPath: string) => {
    const q = parseQuery(fullPath);
    const limit = parseInt(q.limit || '50', 10);
    const offset = parseInt(q.offset || '0', 10);
    return {
      success: true,
      data: {
        items: MOCK_TRAFFIC.slice(offset, offset + limit),
        total: MOCK_TRAFFIC.length,
        limit,
        offset,
      },
    };
  },

  'GET /v1/apps/tracked': () => ({
    success: true,
    data: MOCK_TRACKED_APPS,
  }),

  'GET /v1/apps/recent': () => ({
    success: true,
    data: MOCK_RECENT_DOWNLOADS,
  }),

  'GET /v1/apps/analysis-jobs/recent': () => ({
    success: true,
    data: [
      { id: 1, status: 'completed', stage: null, packageName: 'com.example.game', appName: 'My Game', versionName: '2.3.1', completedAt: HOUR_AGO, createdAt: HOUR_AGO, trackedAppId: 1, apkVersionId: 3 },
      { id: 2, status: 'completed', stage: null, packageName: 'com.social.app', appName: 'Social App', versionName: '5.1.0', completedAt: DAY_AGO, createdAt: DAY_AGO, trackedAppId: 2, apkVersionId: 4 },
      { id: 3, status: 'running', stage: 'decompiling', packageName: 'com.shopping.market', appName: 'Market', versionName: '1.8.2', completedAt: null, createdAt: NOW, trackedAppId: 3, apkVersionId: 5 },
      { id: 4, status: 'failed', stage: null, packageName: 'com.news.reader', appName: 'News Reader', versionName: '3.0.0', completedAt: DAY_AGO, createdAt: DAY_AGO, trackedAppId: 4, apkVersionId: 6 },
    ],
  }),

  'GET /v1/frida/gadget/injected': () => ({
    success: true,
    data: MOCK_INJECTED_APKS,
  }),

  'GET /v1/proxied-request/history': () => ({
    success: true,
    data: MOCK_PROXIED_HISTORY,
  }),

  'GET /v1/proxied-request/status': () => ({
    success: true,
    data: { queueLength: 0, activeCount: 0 },
  }),

  'GET /v1/settings/list': () => ({
    success: true,
    data: MOCK_SETTINGS,
  }),

  'GET /v1/blocklist/list': () => ({
    success: true,
    data: MOCK_BLOCKED_DOMAINS,
  }),

  'GET /v1/hiddenlist/list': () => ({
    success: true,
    data: MOCK_HIDDEN_DOMAINS,
  }),

  'GET /v1/utils/info': () => ({
    success: true,
    data: { dbSizeBytes: 14_200_000 },
  }),

  'GET /v1/frida/scripts': () => ({
    success: true,
    data: MOCK_FRIDA_SCRIPTS,
  }),

  'GET /v1/frida/releases': () => ({
    success: true,
    data: MOCK_FRIDA_RELEASES,
  }),

  'GET /v1/frida/apps': () => ({
    success: true,
    data: MOCK_FRIDA_APPS,
  }),

  'GET /v1/apps/analysis': (fullPath: string) => {
    if (fullPath.includes('/overview')) {
      return { success: true, data: MOCK_ANALYSIS_OVERVIEW };
    }
    if (fullPath.includes('/findings')) {
      return { data: MOCK_ANALYSIS_FINDINGS, total: MOCK_ANALYSIS_FINDINGS.length };
    }
    if (fullPath.includes('/strings')) {
      return { data: MOCK_ANALYSIS_STRINGS };
    }
    if (fullPath.includes('/tree')) {
      return { data: { sources: ['jadx', 'apktool'], tree: [
        'sources/com/example/social/MainActivity.java',
        'sources/com/example/social/api/ApiClient.java',
        'sources/com/example/social/auth/AuthManager.java',
        'sources/com/example/social/auth/FacebookAuth.java',
        'sources/com/example/social/crypto/CryptoHelper.java',
        'sources/com/example/social/network/HttpClient.java',
        'sources/com/example/social/network/TlsConfig.java',
      ] } };
    }
    return { success: true, data: [] };
  },

  'GET /v1/settings/analysis_excluded_paths': () => ({
    success: true,
    data: { key: 'analysis_excluded_paths', value: JSON.stringify(['com.google.firebase', 'androidx']) },
  }),

  'GET /v1/apps/icon': () => ({
    success: false,
    error: 'not found',
  }),

  'GET /v1/cloud/status': () => ({
    success: true,
    data: MOCK_CLOUD_STATUS,
  }),

  'GET /v1/cloud/browse': () => ({
    success: true,
    data: MOCK_CLOUD_FILES,
  }),

  'GET /v1/api-catalogue/endpoints': (fullPath: string) => {
    const q = parseQuery(fullPath);
    const limit = parseInt(q.limit || '50', 10);
    const offset = parseInt(q.offset || '0', 10);
    const groupId = q.groupId ? parseInt(q.groupId, 10) : null;
    let items = MOCK_API_CATALOGUE_ENDPOINTS;
    if (groupId) {
      items = items.filter(ep => ep.groupId === groupId);
    }
    // If requesting a specific endpoint detail (path has /endpoints/{id})
    if (fullPath.match(/\/endpoints\/\d+$/)) {
      const id = parseInt(fullPath.match(/\/endpoints\/(\d+)$/)?.[1] || '0', 10);
      const ep = MOCK_API_CATALOGUE_ENDPOINTS.find(e => e.id === id);
      if (ep) {
        return {
          success: true,
          data: {
            ...ep,
            sampleRequestHeaders: '{"Accept":"application/json","Authorization":"Bearer tok_xxx"}',
            sampleRequestBody: ep.method === 'POST' || ep.method === 'PUT' || ep.method === 'PATCH' ? '{"key":"value"}' : null,
            sampleResponseHeaders: '{"Content-Type":"application/json","X-Request-Id":"abc123"}',
            sampleResponseBody: '{"success":true,"data":{"id":1,"name":"Example","isAdmin":false}}',
            queryParams: [
              { name: 'page', sampleValues: ['1', '2', '3'], occurrenceCount: 15 },
              { name: 'limit', sampleValues: ['10', '20', '50'], occurrenceCount: 12 },
              { name: 'sort', sampleValues: ['name', 'created_at', '-updated_at'], occurrenceCount: 8 },
              { name: 'filter', sampleValues: ['active', 'archived'], occurrenceCount: 5 },
            ],
          },
        };
      }
    }
    return {
      success: true,
      data: {
        items: items.slice(offset, offset + limit),
        total: items.length,
      },
    };
  },

  'GET /v1/api-catalogue/groups': () => ({
    success: true,
    data: MOCK_API_CATALOGUE_GROUPS,
  }),

  'GET /v1/jobs': () => ({
    success: true,
    data: MOCK_JOBS,
  }),

  'GET /v1/automation/session': (fullPath: string) => {
    // /v1/automation/session/{id} — session detail with logs
    if (fullPath.match(/\/v1\/automation\/session\/\d+$/)) {
      return { success: true, data: MOCK_SESSION_DETAIL };
    }
    return { success: true, data: { items: MOCK_SESSIONS, total: MOCK_SESSIONS.length } };
  },

  'GET /v1/intercept/rules': () => ({
    success: true,
    data: MOCK_INTERCEPT_RULES,
  }),

  'PATCH /v1/intercept/rules': () => ({ success: true, data: {} }),
  'POST /v1/intercept/rules': () => ({ success: true, data: { id: 99 } }),

  'GET /v1/certs': () => ({
    success: true,
    data: MOCK_CLIENT_CERTS.map(c => ({
      ...c,
      hostnames: JSON.parse(c.hostnames),
    })),
  }),

  'PATCH /v1/certs': () => ({ success: true, data: {} }),
  'POST /v1/certs': () => ({ success: true, data: { id: 99 } }),

  // AI chat — no prior conversation; the panel will show the empty/suggestions state
  'GET /v1/ai/conversations/latest': () => ({
    success: false,
    error: 'not found',
  }),
};

// ---------------------------------------------------------------------------
// Mock phone screen generator
// ---------------------------------------------------------------------------

let mockPhoneScreenB64: string | null = null;
let mockPhoneScreenJpgB64: string | null = null;

async function generateMockPhoneScreen(browser: Browser): Promise<{ png: string; jpg: string }> {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
  const pg = await ctx.newPage();

  // Prefer a real phone screenshot fixture if one is bundled. This keeps the
  // marketing capture (device-capture page) feeling authentic — the DarkRide
  // UI surrounding the phone re-renders with every script run, while the
  // phone screen content stays a real device capture rather than a synthetic
  // mockup. Drop a 1080x1920 PNG at scripts/fixtures/phone-screen.png to use it.
  const fixturePath = pathResolve(__dirname, 'fixtures', 'phone-screen.png');
  if (existsSync(fixturePath)) {
    const dataUrl = `data:image/png;base64,${readFileSync(fixturePath).toString('base64')}`;
    await pg.setContent(`<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1080px; height: 1920px; background: #000; overflow: hidden; }
  img { width: 1080px; height: 1920px; display: block; object-fit: cover; }
</style></head><body>
  <img src="${dataUrl}" />
</body></html>`);
    const pngBuf = await pg.screenshot({ type: 'png' });
    const jpgBuf = await pg.screenshot({ type: 'jpeg', quality: 85 });
    await ctx.close();
    return { png: pngBuf.toString('base64'), jpg: jpgBuf.toString('base64') };
  }

  await pg.setContent(`<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1080px; height: 1920px; background: linear-gradient(160deg, #1e3a5c, #2d6078, #25736e, #2d6078, #1e3a5c); font-family: 'Segoe UI', sans-serif; color: #fff; overflow: hidden; }
  .status-bar { display: flex; justify-content: space-between; padding: 12px 32px; font-size: 32px; font-weight: 500; }
  .search-bar { margin: 50px 48px 40px; background: rgba(255,255,255,0.12); border-radius: 48px; padding: 24px 36px; font-size: 30px; color: rgba(255,255,255,0.6); display: flex; align-items: center; gap: 16px; }
  .search-icon { font-size: 36px; }
  .app-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 48px 0; padding: 0 64px; }
  .app-item { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .app-icon { width: 120px; height: 120px; border-radius: 28px; display: flex; align-items: center; justify-content: center; font-size: 48px; font-weight: 700; }
  .app-name { font-size: 24px; color: rgba(255,255,255,0.85); }
  .dock { position: absolute; bottom: 0; left: 0; right: 0; padding: 36px 80px 48px; display: flex; justify-content: space-around; background: rgba(0,0,0,0.25); backdrop-filter: blur(20px); }
  .dock .app-icon { width: 108px; height: 108px; }
  .time-widget { text-align: center; margin: 60px 0 0; }
  .time-widget .time { font-size: 120px; font-weight: 200; letter-spacing: -4px; }
  .time-widget .date { font-size: 28px; color: rgba(255,255,255,0.7); margin-top: 8px; }
</style></head><body>
  <div class="status-bar">
    <span>9:41</span>
    <span style="display:flex;gap:12px;align-items:center">
      <span style="font-size:28px">LTE</span>
      <span>&#9632;&#9632;&#9632;&#9632;</span>
      <span>87%</span>
    </span>
  </div>
  <div class="time-widget">
    <div class="time">9:41</div>
    <div class="date">Saturday, February 15</div>
  </div>
  <div class="search-bar">
    <span class="search-icon">&#128269;</span>
    <span>Search apps & web</span>
  </div>
  <div class="app-grid">
    <div class="app-item"><div class="app-icon" style="background:#4285f4">G</div><div class="app-name">Chrome</div></div>
    <div class="app-item"><div class="app-icon" style="background:#34a853">&#9993;</div><div class="app-name">Messages</div></div>
    <div class="app-item"><div class="app-icon" style="background:#ea4335">&#9834;</div><div class="app-name">YouTube</div></div>
    <div class="app-item"><div class="app-icon" style="background:#fbbc05">&#9881;</div><div class="app-name">Settings</div></div>
    <div class="app-item"><div class="app-icon" style="background:#7c4dff">&#128247;</div><div class="app-name">Camera</div></div>
    <div class="app-item"><div class="app-icon" style="background:#00bcd4">&#128506;</div><div class="app-name">Maps</div></div>
    <div class="app-item"><div class="app-icon" style="background:#ff5722">&#127911;</div><div class="app-name">Podcasts</div></div>
    <div class="app-item"><div class="app-icon" style="background:#607d8b">&#128197;</div><div class="app-name">Calendar</div></div>
    <div class="app-item"><div class="app-icon" style="background:#e91e63">&#128249;</div><div class="app-name">Photos</div></div>
    <div class="app-item"><div class="app-icon" style="background:#3f51b5">&#127760;</div><div class="app-name">Files</div></div>
    <div class="app-item"><div class="app-icon" style="background:#009688">&#128274;</div><div class="app-name">Security</div></div>
    <div class="app-item"><div class="app-icon" style="background:#795548">&#127915;</div><div class="app-name">Clock</div></div>
    <div class="app-item"><div class="app-icon" style="background:#8bc34a">&#128176;</div><div class="app-name">Wallet</div></div>
    <div class="app-item"><div class="app-icon" style="background:#ff6f00">&#127918;</div><div class="app-name">Games</div></div>
    <div class="app-item"><div class="app-icon" style="background:#1565c0">&#9729;</div><div class="app-name">Weather</div></div>
    <div class="app-item"><div class="app-icon" style="background:#c62828">&#9993;</div><div class="app-name">Gmail</div></div>
  </div>
  <div class="dock">
    <div class="app-icon" style="background:#4caf50">&#128222;</div>
    <div class="app-icon" style="background:#2196f3">&#128172;</div>
    <div class="app-icon" style="background:#ff9800">&#128247;</div>
    <div class="app-icon" style="background:#9c27b0">&#127926;</div>
  </div>
</body></html>`);
  const pngBuf = await pg.screenshot({ type: 'png' });
  const jpgBuf = await pg.screenshot({ type: 'jpeg', quality: 85 });
  await ctx.close();
  return { png: pngBuf.toString('base64'), jpg: jpgBuf.toString('base64') };
}

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

let mockWsRef: any = null;

async function setupWsMock(page: Page) {
  // Mock HTTP fetch routes (used by pages that call fetch() directly instead of WebSocket)
  // AuthGuard polls /v1/auth/me on mount and blocks the entire app behind a "Loading..."
  // spinner until it returns a user. Mock as a fully-scoped admin so every page renders.
  await page.route('**/v1/auth/me', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        passwordMustChange: false,
        user: {
          id: 1,
          username: 'admin',
          displayName: 'Admin',
          email: null,
          scopes: ['core.admin:*'],
          providerId: 'core.local',
        },
        csrfToken: 'mock-csrf-token',
      }),
    });
  });

  await page.route('**/v1/cloud/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_CLOUD_STATUS }),
    });
  });
  await page.route('**/v1/cloud/browse**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_CLOUD_FILES }),
    });
  });

  // Mock HTTP fetch for plugins registry (used by AiChatDrawer before WS connects)
  await page.route('**/v1/plugins/registry', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  await page.routeWebSocket(/\/ws$/, (ws) => {
    mockWsRef = ws;
    // Tell frontend the server is ready so it shows the normal UI (not the startup screen)
    ws.send(JSON.stringify({ type: 'startup-progress', phase: 'ready', message: 'Server ready' }));
    ws.onMessage((msg) => {
      let parsed: any;
      try { parsed = JSON.parse(msg.toString()); } catch { return; }

      if (parsed.action === 'restapi') {
        // Strip query string to match route key, but pass full path to handler
        const basePath = parsed.path.split('?')[0];
        // Try exact match first, then strip trailing ID segments for parameterized routes
        let key = `${parsed.method} ${basePath}`;
        let handler = MOCK_RESPONSES[key];

        if (!handler) {
          // Try stripping trailing path segments until we find a match
          const segments = basePath.split('/');
          while (!handler && segments.length > 2) {
            segments.pop();
            key = `${parsed.method} ${segments.join('/')}`;
            handler = MOCK_RESPONSES[key];
          }
        }

        if (handler) {
          ws.send(JSON.stringify({
            type: 'restapi',
            id: parsed.id,
            status: 200,
            body: handler(parsed.path),
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'restapi',
            id: parsed.id,
            status: 200,
            body: { success: true, data: [] },
          }));
        }
      }

      // Handle AI chat messages — send a synthetic streaming response with tool calls
      if (parsed.action === 'ai:message') {
        // Small delay to simulate processing
        setTimeout(() => {
          const toolUseId = 'toolu_mock_apk_findings_01';

          // Tool call 1: get_apk_findings_summary
          ws.send(JSON.stringify({
            type: 'ai:tool-start',
            toolUseId,
            toolName: 'get_apk_findings_summary',
            input: { analysisId: 3 },
          }));

          setTimeout(() => {
            ws.send(JSON.stringify({
              type: 'ai:tool-result',
              toolUseId,
              result: JSON.stringify({
                critical: 3, high: 12, medium: 28, low: 15, info: 7,
                byCategory: { secret: 8, url: 6, crypto: 11, network: 14, certificate: 3, permission: 5 },
              }),
              durationMs: 312,
            }));

            const toolUseId2 = 'toolu_mock_search_findings_02';
            ws.send(JSON.stringify({
              type: 'ai:tool-start',
              toolUseId: toolUseId2,
              toolName: 'search_apk_findings',
              input: { analysisId: 3, query: 'hardcoded API key', severity: 'critical' },
            }));

            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'ai:tool-result',
                toolUseId: toolUseId2,
                result: JSON.stringify([
                  { id: 1, severity: 'critical', title: 'Hardcoded API Key', filePath: 'com/example/social/api/ApiClient.java', lineNumber: 42, matchedText: 'AIzaSyD-FAKE_KEY_FOR_DEMO_1234567890' },
                  { id: 2, severity: 'critical', title: 'Hardcoded Secret', filePath: 'com/example/social/auth/AuthManager.java', lineNumber: 87, matchedText: 'sk_live_FAKE_SECRET_TOKEN_demo' },
                ]),
                durationMs: 187,
              }));

              // Text response tokens
              const tokens = [
                '**ExampleSocial v24.1.20** has **65 security findings** across 5 categories:\n\n',
                '- 🔴 **3 Critical** — hardcoded secrets and weak TLS\n',
                '- 🟠 **12 High** — cleartext HTTP, SQL injection, exposed components\n',
                '- 🟡 **28 Medium** — debug logging, exported receivers\n\n',
                'The most urgent issues are two **hardcoded credentials** in `ApiClient.java` (line 42) ',
                'and `AuthManager.java` (line 87). These should be rotated immediately and moved to a secure vault.',
              ];

              let delay = 0;
              for (const token of tokens) {
                const t = token;
                delay += 80;
                setTimeout(() => {
                  ws.send(JSON.stringify({ type: 'ai:token', text: t }));
                }, delay);
              }

              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: 'ai:done',
                  conversationId: 42,
                  turnLimitReached: false,
                }));
              }, delay + 100);
            }, 200);
          }, 350);
        }, 150);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();
  const baseUrl = `http://localhost:${opts.port}`;

  const resolution = { width: opts.width, height: opts.height };

  // Determine themes
  const themes: Array<'light' | 'dark'> =
    opts.theme === 'both' ? ['light', 'dark'] : [opts.theme as 'light' | 'dark'];

  // Filter pages
  let pages = opts.page
    ? PAGES.filter(p => p.name === opts.page)
    : PAGES;

  // --core-only: skip plugin-contributed pages listed in SKIPPED_PAGES
  if (opts.coreOnly) {
    pages = pages.filter(p => !SKIPPED_PAGES.has(p.name));
  }

  if (pages.length === 0) {
    console.error(`Unknown page "${opts.page}". Available: ${PAGES.map(p => p.name).join(', ')}`);
    process.exit(1);
  }

  // Hide optional plugins from disk (Vite re-scans, sidebar is clean)
  let restorePlugins: (() => void) | null = null;
  if (opts.coreOnly) {
    console.log('Hiding optional plugins from disk...');
    restorePlugins = hideOptionalPlugins();
    console.log('');
  }

  const total = pages.length * themes.length;
  console.log(`Taking ${total} screenshots (${pages.length} pages × ${themes.length} themes @ ${resolution.width}x${resolution.height})\n`);

  // Start Vite
  console.log('Starting Vite dev server...');
  const vite = await startVite(opts.port);
  console.log(`Vite running on port ${opts.port}\n`);

  // Ensure output dir
  const outDir = pathResolve(process.cwd(), opts.output);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch();
  let count = 0;

  // Generate mock phone screen image
  console.log('Generating mock phone screen...');
  const mockScreens = await generateMockPhoneScreen(browser);
  mockPhoneScreenB64 = mockScreens.png;
  mockPhoneScreenJpgB64 = mockScreens.jpg;
  console.log(`Mock phone screen generated (PNG: ${Math.round(mockPhoneScreenB64.length / 1024)}KB, JPG: ${Math.round(mockPhoneScreenJpgB64.length / 1024)}KB)\n`);

  try {
    for (const theme of themes) {
      console.log(`[${theme}]`);

      const context = await browser.newContext({
        viewport: resolution,
        colorScheme: theme,
        isMobile: opts.mobile,
        hasTouch: opts.mobile,
      });
      const page = await context.newPage();
      await setupWsMock(page);

      const suffix = opts.mobile ? '-mobile' : '';
      for (const pageDef of pages) {
        const filename = `${pageDef.name}-${theme}${suffix}.png`;
        const filepath = pathResolve(outDir, filename);

        try {
          await page.goto(`${baseUrl}${pageDef.path}`, { waitUntil: 'networkidle' });
          // Let any transitions/animations settle
          await page.waitForTimeout(300);

          // Run page-specific setup (e.g. click buttons, inject data)
          if (pageDef.setup) {
            await pageDef.setup(page);
            await page.waitForTimeout(300);
          }

          await page.screenshot({ path: filepath, fullPage: false });
          count++;
          console.log(`  ✓ ${filename}`);
        } catch (err) {
          const msg = (err as Error).message?.split('\n')[0] || String(err);
          console.log(`  ✗ ${filename} — ${msg}`);
        }
      }

      await context.close();
    }

    console.log(`\nDone! ${count} screenshots saved to ${opts.output}/`);

    // Copy README screenshots to docs/screenshots/ so they're tracked in git
    const README_SCREENSHOTS = [
      'dashboard-dark.png',
      'device-view-dark.png',
      'automation-editor-dark.png',
      'traffic-dark.png',
      'sessions-dark.png',
      'frida-dark.png',
    ];
    const docsDir = pathResolve(process.cwd(), 'docs', 'screenshots');
    mkdirSync(docsDir, { recursive: true });
    let copied = 0;
    for (const file of README_SCREENSHOTS) {
      const src = join(outDir, file);
      if (existsSync(src)) {
        copyFileSync(src, join(docsDir, file));
        copied++;
      }
    }
    if (copied > 0) {
      console.log(`Copied ${copied} README screenshots to docs/screenshots/`);
    }
  } finally {
    await browser.close();
    await stopVite(vite);
    if (restorePlugins) {
      console.log('\nRestoring private plugins...');
      restorePlugins();
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
