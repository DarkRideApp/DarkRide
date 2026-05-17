import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerPluginConsentEndpoints } from './plugin-consent';
import { PluginManager } from '../plugins/plugin-manager';
import { ServiceUserManager } from '../auth/service-user-manager';
import { createTestDb } from '../test-utils/create-test-db';
import * as schema from '../db/schema';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { definePlugin } from '@darkrideapp/plugin-sdk';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../auth/service-user-manager', () => ({
  ServiceUserManager: vi.fn().mockImplementation(() => ({
    removePluginServiceUser: vi.fn(),
    ensurePluginServiceUser: vi.fn(),
    findByPlugin: vi.fn().mockReturnValue(null),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function createApp(
  db: BetterSQLite3Database<typeof schema>,
  pluginManager: PluginManager,
) {
  clearEndpoints();
  registerPluginConsentEndpoints(db as any, pluginManager);
  const app = express();
  app.use(express.json());
  // Inject a fake authUser with core.plugins:manage so scope checks pass
  app.use((req, _res, next) => {
    (req as any).authUser = {
      userId: 1,
      effectiveScopes: new Set(['core.plugins:manage']),
    };
    next();
  });
  app.use(getApiRouter());
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Plugin consent API', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let pluginManager: PluginManager;
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();

    db = createTestDb();
    pluginManager = new PluginManager();
    pluginManager.setServiceUserManager(new ServiceUserManager(db as any));

    pluginManager.loadPlugin(
      definePlugin({
        name: 'demo',
        version: '1.0.0',
        aiScopes: ['core.apk:read'],
        register: () => {},
      }),
    );

    // Seed a plugin_state row in the disabled / unconsented initial state
    db.insert(schema.pluginState).values({
      name: 'demo',
      enabled: false,
      installedVia: 'npm',
      installedAt: new Date(),
      updatedAt: new Date(),
    } as any).run();

    app = createApp(db, pluginManager);
  });

  // ─── GET /v1/plugins/:name/scope-status ────────────────────────────────────

  it('GET scope-status returns unconsented + manifest scopes with metadata', async () => {
    const res = await request(app).get('/v1/plugins/demo/scope-status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plugin: 'demo',
      enabled: false,
      manifestScopes: ['core.apk:read'],
      approvedScopes: null,
      state: 'unconsented',
    });
    // added[] should carry scope metadata
    expect(res.body.added).toHaveLength(1);
    expect(res.body.added[0]).toMatchObject({
      key: 'core.apk:read',
      metadata: expect.objectContaining({ label: expect.any(String) }),
    });
  });

  it('GET scope-status returns 404 for unknown plugin', async () => {
    const res = await request(app).get('/v1/plugins/ghost/scope-status');
    expect(res.status).toBe(404);
  });

  // ─── POST /v1/plugins/:name/approve-scopes ─────────────────────────────────

  it('POST approve-scopes with subset-of-manifest succeeds', async () => {
    const res = await request(app)
      .post('/v1/plugins/demo/approve-scopes')
      .send({ approvedScopes: ['core.apk:read'] });

    expect(res.status).toBe(200);
    expect(res.body.approvedScopes).toEqual(['core.apk:read']);
    expect(res.body.state).toBe('ok');

    // Verify persisted state
    const after = await request(app).get('/v1/plugins/demo/scope-status');
    expect(after.body.approvedScopes).toEqual(['core.apk:read']);
    expect(after.body.enabled).toBe(true);
  });

  it('POST approve-scopes rejects scopes outside the manifest', async () => {
    const res = await request(app)
      .post('/v1/plugins/demo/approve-scopes')
      .send({ approvedScopes: ['core.devices:shell'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not in manifest/i);
  });

  // ─── POST /v1/plugins/:name/deny-scopes ────────────────────────────────────

  it('POST deny-scopes disables plugin and clears approval', async () => {
    // First approve so there is something to deny
    await request(app)
      .post('/v1/plugins/demo/approve-scopes')
      .send({ approvedScopes: ['core.apk:read'] });

    const res = await request(app).post('/v1/plugins/demo/deny-scopes');
    expect(res.status).toBe(200);

    const state = await request(app).get('/v1/plugins/demo/scope-status');
    expect(state.body.enabled).toBe(false);
    expect(state.body.approvedScopes).toBeNull();
    expect(state.body.state).toBe('unconsented');
  });
});
