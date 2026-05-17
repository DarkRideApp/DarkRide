/**
 * Live integration tests for the file serving system.
 * These tests require the server running on port 3000.
 * When the server isn't running, all tests are skipped (not failed).
 *
 * Run with:
 *   1. Start server: npx tsx backend/index.ts
 *   2. Run tests: npx vitest run backend/services/__tests__/file-serving-live.test.ts
 */
import { describe, it, expect, type TaskContext } from 'vitest';

const BASE_URL = 'http://localhost:3000';

let _serverChecked = false;
let _serverAvailable = false;

async function requireServer(ctx: TaskContext) {
  if (!_serverChecked) {
    _serverChecked = true;
    try {
      const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      _serverAvailable = res.ok;
    } catch {
      _serverAvailable = false;
    }
  }
  if (!_serverAvailable) {
    ctx.skip();
  }
}

describe('File Serving (live server)', () => {

  // ── Kitchen Sink file storage ──

  it('kitchen sink: writes, reads, and verifies file round-trip', async (ctx) => {
    await requireServer(ctx);
    const res = await fetch(`${BASE_URL}/v1/kitchen-sink/file-test`, { method: 'POST' });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.match).toBe(true);
    expect(data.data.exists).toBe(true);
    expect(data.data.url).toBe('/v1/files/kitchen-sink/test/hello.txt');
  });

  it('kitchen sink: serves written file via framework endpoint', async (ctx) => {
    await requireServer(ctx);
    await fetch(`${BASE_URL}/v1/kitchen-sink/file-test`, { method: 'POST' });

    const res = await fetch(`${BASE_URL}/v1/files/kitchen-sink/test/hello.txt`);
    expect(res.status).toBe(200);

    const text = await res.text();
    expect(text).toContain('Kitchen sink file test');
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  // ── File serving endpoint ──

  it('returns 404 for nonexistent files', async (ctx) => {
    await requireServer(ctx);
    const res = await fetch(`${BASE_URL}/v1/files/kitchen-sink/nonexistent/file.txt`);
    expect(res.status).toBe(404);
  });

  it('rejects path traversal in file path', async (ctx) => {
    await requireServer(ctx);
    const res = await fetch(`${BASE_URL}/v1/files/kitchen-sink/../../../etc/passwd`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.text();
    expect(body).not.toContain('root:');
  });

  it('rejects encoded path traversal', async (ctx) => {
    await requireServer(ctx);
    const res = await fetch(`${BASE_URL}/v1/files/kitchen-sink/..%2F..%2F..%2Fetc%2Fpasswd`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  // ── Unified tools REST API ──

  it('tools: executes a registered tool', async (ctx) => {
    await requireServer(ctx);
    const res = await fetch(`${BASE_URL}/v1/tools/kitchen_sink_greet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'DarkRide' }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.message).toContain('DarkRide');
  });

  it('tools: returns 404 for unknown tools', async (ctx) => {
    await requireServer(ctx);
    const res = await fetch(`${BASE_URL}/v1/tools/nonexistent_tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it('tools: lists available tools including plugin tools', async (ctx) => {
    await requireServer(ctx);
    const res = await fetch(`${BASE_URL}/v1/tools`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    const names = data.data.map((t: any) => t.name);
    expect(names).toContain('kitchen_sink_greet');
  });

  // ── Plugin registry ──

  it('registry: returns loaded plugins with metadata', async (ctx) => {
    await requireServer(ctx);
    const res = await fetch(`${BASE_URL}/v1/plugins/registry`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);

    const ks = data.data.find((p: any) => p.name === 'kitchen-sink');
    expect(ks).toBeTruthy();
    expect(ks.nav.length).toBeGreaterThan(0);

    const maps = data.data.find((p: any) => p.name === 'maps');
    expect(maps).toBeTruthy();
  });
});
