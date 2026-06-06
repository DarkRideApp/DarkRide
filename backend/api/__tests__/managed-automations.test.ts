import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { automations } from '../../db/schema';
import { createTestDb } from '../../test-utils/create-test-db';
import { clearEndpoints, getApiRouter } from '../api-service';
import { registerManagedAutomationEndpoints } from '../managed-automations';
import type { AppDatabase } from '../../db/index';

function makeApp(db: AppDatabase) {
  clearEndpoints();
  registerManagedAutomationEndpoints(db);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

function seedManaged(db: AppDatabase, overrides: Partial<typeof automations.$inferInsert> = {}) {
  const now = new Date();
  db.insert(automations).values({
    name: 'Poller',
    code: 'v1\n',
    passcode: '',
    requiresDevice: false,
    enabled: true,
    managedBy: 'plugin-x',
    managedKey: 'poller',
    currentDefaultCode: 'v1\n',
    baseDefaultCode: null,
    isOverridden: false,
    allowUserOverride: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }).run();
  return db.select().from(automations).all().pop()!;
}

describe('managed-automations REST endpoints', () => {
  let db: AppDatabase;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    app = makeApp(db);
  });

  describe('GET /v1/managed-automations/:pluginKey/:scriptKey', () => {
    it('returns the effective view + drift flags for an existing managed row', async () => {
      seedManaged(db);
      const res = await request(app).get('/v1/managed-automations/plugin-x/poller');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        pluginKey: 'plugin-x',
        scriptKey: 'poller',
        code: 'v1\n',
        currentDefaultCode: 'v1\n',
        baseDefaultCode: null,
        isOverridden: false,
        hasDrift: false,
        allowUserOverride: true,
      });
    });

    it('hasDrift = true when overridden AND base ≠ current', async () => {
      seedManaged(db, {
        code: 'operator\n',
        baseDefaultCode: 'v1\n',
        currentDefaultCode: 'v2\n',
        isOverridden: true,
      });
      const res = await request(app).get('/v1/managed-automations/plugin-x/poller');
      expect(res.body.data.hasDrift).toBe(true);
    });

    it('404 for unknown plugin/script', async () => {
      const res = await request(app).get('/v1/managed-automations/nope/nope');
      expect(res.status).toBe(404);
    });
  });

  describe('PUT .../code (save override)', () => {
    it('writes operator code, snapshots fork point as base_default_code, flips is_overridden', async () => {
      seedManaged(db);
      const res = await request(app)
        .put('/v1/managed-automations/plugin-x/poller/code')
        .send({ code: 'operator\n' });
      expect(res.status).toBe(200);
      const row = db.select().from(automations).all()[0];
      expect(row.code).toBe('operator\n');
      expect(row.baseDefaultCode).toBe('v1\n');   // current at the moment of fork
      expect(row.isOverridden).toBe(true);
    });

    it('409 when allow_user_override = false', async () => {
      seedManaged(db, { allowUserOverride: false });
      const res = await request(app)
        .put('/v1/managed-automations/plugin-x/poller/code')
        .send({ code: 'edited\n' });
      expect(res.status).toBe(409);
      // and code is unchanged
      const row = db.select().from(automations).all()[0];
      expect(row.code).toBe('v1\n');
    });

    it('400 when body has no code', async () => {
      seedManaged(db);
      const res = await request(app)
        .put('/v1/managed-automations/plugin-x/poller/code')
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST .../reset', () => {
    it('drops the override and re-tracks the default', async () => {
      seedManaged(db, {
        code: 'operator\n',
        baseDefaultCode: 'v1\n',
        currentDefaultCode: 'v2\n',
        isOverridden: true,
      });
      const res = await request(app).post('/v1/managed-automations/plugin-x/poller/reset');
      expect(res.status).toBe(200);
      const row = db.select().from(automations).all()[0];
      expect(row.code).toBe('v2\n');             // re-adopted current default
      expect(row.baseDefaultCode).toBeNull();
      expect(row.isOverridden).toBe(false);
    });
  });

  describe('POST .../keep-mine', () => {
    it('advances base_default_code to current_default_code so drift turns off', async () => {
      seedManaged(db, {
        code: 'operator\n',
        baseDefaultCode: 'v1\n',
        currentDefaultCode: 'v2\n',
        isOverridden: true,
      });
      const res = await request(app).post('/v1/managed-automations/plugin-x/poller/keep-mine');
      expect(res.status).toBe(200);
      const row = db.select().from(automations).all()[0];
      expect(row.code).toBe('operator\n');       // unchanged
      expect(row.baseDefaultCode).toBe('v2\n');  // ancestor advanced
      expect(row.isOverridden).toBe(true);       // still overridden
      // and the response now reports no drift
      expect(res.body.data.hasDrift).toBe(false);
    });

    it('409 when not overridden', async () => {
      seedManaged(db);
      const res = await request(app).post('/v1/managed-automations/plugin-x/poller/keep-mine');
      expect(res.status).toBe(409);
    });
  });

  describe('GET .../diff', () => {
    it('returns the 3-way payload (ancestor, incoming, yours)', async () => {
      seedManaged(db, {
        code: 'operator\n',
        baseDefaultCode: 'v1\n',
        currentDefaultCode: 'v2\n',
        isOverridden: true,
      });
      const res = await request(app).get('/v1/managed-automations/plugin-x/poller/diff');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        ancestor: 'v1\n',
        incoming: 'v2\n',
        yours: 'operator\n',
      });
    });
  });

  describe('GET /v1/managed-automations (list)', () => {
    it('returns every managed row across plugins, hides ordinary rows', async () => {
      seedManaged(db, { managedBy: 'plugin-x', managedKey: 'a' });
      seedManaged(db, { managedBy: 'plugin-y', managedKey: 'b' });
      // an ordinary (non-managed) row should be excluded
      const now = new Date();
      db.insert(automations).values({
        name: 'Ordinary',
        code: 'noop',
        passcode: '',
        managedBy: null,
        managedKey: null,
        createdAt: now,
        updatedAt: now,
      }).run();

      const res = await request(app).get('/v1/managed-automations');
      expect(res.status).toBe(200);
      const items = res.body.data.items as Array<{ scriptKey: string }>;
      expect(items.map((i) => i.scriptKey).sort()).toEqual(['a', 'b']);
    });
  });
});
