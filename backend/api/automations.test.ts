import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import * as schema from '../db/schema';
import { registerAutomationEndpoints } from './automations';
import { AutomationRunner } from '../services/automation-runner';
import { AutomationCompiler } from '../services/automation-compiler';
import { AutomationScheduler } from '../services/automation-scheduler';
import { PythonBridgeManager } from '../services/python-bridge';
import { clearEndpoints, getApiRouter } from './api-service';
import type { AppDatabase } from '../db/index';
import { createTestDb } from '../test-utils/create-test-db';

// Mock broadcastToAll
vi.mock('../websocket/index', () => ({
  broadcastToAll: vi.fn(),
}));

describe('Automation API', () => {
  let db: AppDatabase;
  let app: express.Express;
  let compiler: AutomationCompiler;
  let bridgeManager: PythonBridgeManager;
  let runner: AutomationRunner;
  let scheduler: AutomationScheduler;

  beforeEach(() => {
    clearEndpoints();

    db = createTestDb();
    compiler = new AutomationCompiler();
    bridgeManager = new PythonBridgeManager(db);
    runner = new AutomationRunner(db, bridgeManager, compiler);
    scheduler = new AutomationScheduler(db, runner);

    registerAutomationEndpoints(db, runner, compiler, scheduler);

    app = express();
    app.use(express.json());
    app.use(getApiRouter());
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
  });

  describe('POST /v1/automation/create', () => {
    it('creates an automation', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Test Auto',
          code: 'export default async function(d: any) {}',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('Test Auto');
      expect(res.body.data.passcode).toBeDefined();
      expect(res.body.data.timeoutMs).toBe(300000);
    });

    it('creates a rule automation', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Cookie Rule',
          code: 'export default async function(d: any) {}',
          isRule: true,
          priority: 5,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.isRule).toBeTruthy();
      expect(res.body.data.priority).toBe(5);
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({ code: 'some code' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when code is missing', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Test' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /v1/automation/list', () => {
    it('returns empty list initially', async () => {
      const res = await request(app).get('/v1/automation/list');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('returns created automations', async () => {
      await request(app).post('/v1/automation/create').send({
        name: 'Auto 1',
        code: 'code1',
      });
      await request(app).post('/v1/automation/create').send({
        name: 'Auto 2',
        code: 'code2',
      });

      const res = await request(app).get('/v1/automation/list');

      expect(res.body.data).toHaveLength(2);
    });

    it('filters by isRule', async () => {
      await request(app).post('/v1/automation/create').send({
        name: 'Regular',
        code: 'code',
        isRule: false,
      });
      await request(app).post('/v1/automation/create').send({
        name: 'Rule',
        code: 'code',
        isRule: true,
      });

      const rulesRes = await request(app).get('/v1/automation/list?isRule=true');
      expect(rulesRes.body.data).toHaveLength(1);
      expect(rulesRes.body.data[0].name).toBe('Rule');

      const regularRes = await request(app).get('/v1/automation/list?isRule=false');
      expect(regularRes.body.data).toHaveLength(1);
      expect(regularRes.body.data[0].name).toBe('Regular');
    });
  });

  describe('GET /v1/automation/view/:id', () => {
    it('returns automation by id', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const id = createRes.body.data.id;

      const res = await request(app).get(`/v1/automation/view/${id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Test');
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app).get('/v1/automation/view/999');

      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid id', async () => {
      const res = await request(app).get('/v1/automation/view/abc');

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /v1/automation/update/:id', () => {
    it('updates automation fields', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Original',
        code: 'code',
      });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ name: 'Updated', timeoutMs: 60000 });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated');
      expect(res.body.data.timeoutMs).toBe(60000);
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app)
        .put('/v1/automation/update/999')
        .send({ name: 'Updated' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /v1/automation/delete/:id', () => {
    it('deletes automation', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'ToDelete',
        code: 'code',
      });
      const id = createRes.body.data.id;

      const res = await request(app).delete(`/v1/automation/delete/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const viewRes = await request(app).get(`/v1/automation/view/${id}`);
      expect(viewRes.status).toBe(404);
    });

    it('returns 404 for non-existent id', async () => {
      const res = await request(app).delete('/v1/automation/delete/999');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/automation/run/:id/:passcode', () => {
    it('queues automation with valid passcode', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const { id, passcode } = createRes.body.data;

      const res = await request(app).get(`/v1/automation/run/${id}/${passcode}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.triggeredBy).toBe('api');
    });

    it('returns 403 for invalid passcode', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const { id } = createRes.body.data;

      const res = await request(app).get(`/v1/automation/run/${id}/wrong-passcode`);

      expect(res.status).toBe(403);
    });
  });

  describe('GET /v1/automation/sessions', () => {
    it('filters by pinned=true', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const autoId = createRes.body.data.id;

      const now = new Date();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        isPinned: true,
        startedAt: now,
      }).run();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        isPinned: false,
        startedAt: now,
      }).run();

      const res = await request(app).get('/v1/automation/sessions?pinned=true');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].isPinned).toBe(true);
    });

    it('filters by pinned=false', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const autoId = createRes.body.data.id;

      const now = new Date();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        isPinned: true,
        startedAt: now,
      }).run();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        isPinned: false,
        startedAt: now,
      }).run();

      const res = await request(app).get('/v1/automation/sessions?pinned=false');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].isPinned).toBe(false);
    });

    it('returns all sessions when pinned param is absent', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const autoId = createRes.body.data.id;

      const now = new Date();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        isPinned: true,
        startedAt: now,
      }).run();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        isPinned: false,
        startedAt: now,
      }).run();

      const res = await request(app).get('/v1/automation/sessions');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
    });
  });

  describe('GET /v1/automation/sessions/:id', () => {
    it('returns session history for automation', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const autoId = createRes.body.data.id;

      // Insert test sessions
      const now = new Date();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        startedAt: now,
        completedAt: now,
      }).run();

      const res = await request(app).get(`/v1/automation/sessions/${autoId}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('success');
    });

    it('filters by status', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const autoId = createRes.body.data.id;

      const now = new Date();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        startedAt: now,
      }).run();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'failed',
        triggerType: 'manual',
        startedAt: now,
      }).run();

      const res = await request(app).get(`/v1/automation/sessions/${autoId}?status=failed`);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('failed');
    });
  });

  describe('GET /v1/automation/session/:sessionId', () => {
    it('returns full session detail with screenshots and traffic', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const autoId = createRes.body.data.id;

      const now = new Date();
      db.insert(schema.automationSessions).values({
        automationId: autoId,
        deviceId: 'device-1',
        status: 'success',
        triggerType: 'manual',
        startedAt: now,
      }).run();

      const sessions = db.select().from(schema.automationSessions).all();
      const sessionId = sessions[0].id;

      // Add screenshot
      db.insert(schema.screenshots).values({
        sessionId,
        filename: 'test.png',
        name: 'Test Screenshot',
        capturedAt: now,
      }).run();

      // Add traffic
      db.insert(schema.capturedTraffic).values({
        sessionId,
        deviceId: 'device-1',
        requestMethod: 'GET',
        requestUrl: 'https://example.com',
        capturedAt: now,
      }).run();

      const res = await request(app).get(`/v1/automation/session/${sessionId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.session).toBeDefined();
      expect(res.body.data.screenshots).toHaveLength(1);
      expect(res.body.data.traffic).toHaveLength(1);
    });

    it('returns 404 for non-existent session', async () => {
      const res = await request(app).get('/v1/automation/session/999');
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /v1/automation/session/:sessionId', () => {
    it('updates session name', async () => {
      const now = new Date();
      db.insert(schema.automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        startedAt: now,
      }).run();

      const sessions = db.select().from(schema.automationSessions).all();
      const sessionId = sessions[0].id;

      const res = await request(app)
        .patch(`/v1/automation/session/${sessionId}`)
        .send({ name: 'My Session' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('My Session');
    });

    it('updates session isPinned', async () => {
      const now = new Date();
      db.insert(schema.automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        startedAt: now,
      }).run();

      const sessions = db.select().from(schema.automationSessions).all();
      const sessionId = sessions[0].id;

      const res = await request(app)
        .patch(`/v1/automation/session/${sessionId}`)
        .send({ isPinned: true });

      expect(res.status).toBe(200);
      expect(res.body.data.isPinned).toBe(true);

      // Toggle back
      const res2 = await request(app)
        .patch(`/v1/automation/session/${sessionId}`)
        .send({ isPinned: false });

      expect(res2.status).toBe(200);
      expect(res2.body.data.isPinned).toBe(false);
    });

    it('returns 400 when no valid fields provided', async () => {
      const now = new Date();
      db.insert(schema.automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        startedAt: now,
      }).run();

      const sessions = db.select().from(schema.automationSessions).all();
      const sessionId = sessions[0].id;

      const res = await request(app)
        .patch(`/v1/automation/session/${sessionId}`)
        .send({ foo: 'bar' });

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent session', async () => {
      const res = await request(app)
        .patch('/v1/automation/session/999')
        .send({ name: 'Test' });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/automation/queue', () => {
    it('returns current queue', async () => {
      const res = await request(app).get('/v1/automation/queue');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('POST /v1/automation/validate', () => {
    it('validates valid TypeScript code', async () => {
      const res = await request(app)
        .post('/v1/automation/validate')
        .send({ code: 'export default async function(d: any) { return 42; }' });

      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(true);
      expect(res.body.data.errors).toHaveLength(0);
    });

    it('returns 400 when code is missing', async () => {
      const res = await request(app)
        .post('/v1/automation/validate')
        .send({});

      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/automation/types', () => {
    it('returns type definitions', async () => {
      const res = await request(app).get('/v1/automation/types');

      expect(res.status).toBe(200);
      expect(typeof res.text).toBe('string');
      // Type definitions come from the automation.ts source file
      expect(res.text.length).toBeGreaterThan(0);
    }, 30000);
  });

  describe('capture rules', () => {
    it('creates a capture rule automation', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Hook Rule',
          code: 'export default async function(d: any) {}',
          isCaptureRule: true,
          priority: 3,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.isCaptureRule).toBeTruthy();
      expect(res.body.data.isRule).toBeFalsy();
      expect(res.body.data.priority).toBe(3);
      expect(res.body.data.enabled).toBeTruthy();
    });

    it('rejects mutual exclusivity of isRule and isCaptureRule on create', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Bad Rule',
          code: 'export default async function(d: any) {}',
          isRule: true,
          isCaptureRule: true,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('mutually exclusive');
    });

    it('rejects mutual exclusivity of isRule and isCaptureRule on update', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Rule',
          code: 'code',
          isRule: true,
        });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ isCaptureRule: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('mutually exclusive');
    });

    it('filters by isCaptureRule', async () => {
      await request(app).post('/v1/automation/create').send({
        name: 'Regular',
        code: 'code',
      });
      await request(app).post('/v1/automation/create').send({
        name: 'CaptureRule',
        code: 'code',
        isCaptureRule: true,
      });
      await request(app).post('/v1/automation/create').send({
        name: 'Rule',
        code: 'code',
        isRule: true,
      });

      const captureRes = await request(app).get('/v1/automation/list?isCaptureRule=true');
      expect(captureRes.body.data).toHaveLength(1);
      expect(captureRes.body.data[0].name).toBe('CaptureRule');

      const nonCaptureRes = await request(app).get('/v1/automation/list?isCaptureRule=false');
      expect(nonCaptureRes.body.data).toHaveLength(2);
    });

    it('creates automation with enabled=false', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Disabled',
          code: 'code',
          enabled: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.enabled).toBeFalsy();
    });
  });

  describe('enable/disable endpoints', () => {
    it('disables an automation', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Test', code: 'code' });
      const id = createRes.body.data.id;

      const res = await request(app).post(`/v1/automation/disable/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBeFalsy();
    });

    it('enables an automation', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Test', code: 'code', enabled: false });
      const id = createRes.body.data.id;

      const res = await request(app).post(`/v1/automation/enable/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBeTruthy();
    });

    it('returns 404 for non-existent id on enable', async () => {
      const res = await request(app).post('/v1/automation/enable/999');
      expect(res.status).toBe(404);
    });

    it('returns 404 for non-existent id on disable', async () => {
      const res = await request(app).post('/v1/automation/disable/999');
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid id on enable', async () => {
      const res = await request(app).post('/v1/automation/enable/abc');
      expect(res.status).toBe(400);
    });
  });

  describe('capture rule reload on mutation', () => {
    let mockCaptureManager: any;
    let mockRunCaptureRules: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      clearEndpoints();

      mockRunCaptureRules = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(runner, 'runCaptureRules').mockImplementation(mockRunCaptureRules);

      mockCaptureManager = {
        getCapturingDeviceIds: vi.fn().mockReturnValue(['DEV001', 'DEV002']),
        getSessionId: vi.fn().mockImplementation((id: string) => id === 'DEV001' ? 100 : 200),
      };

      registerAutomationEndpoints(db, runner, compiler, scheduler, mockCaptureManager);

      app = express();
      app.use(express.json());
      app.use(getApiRouter());
    });

    it('reloads capture rules on create of capture rule', async () => {
      await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'New CR',
          code: 'export default async function(d: any) {}',
          isCaptureRule: true,
        });

      expect(mockRunCaptureRules).toHaveBeenCalledWith('DEV001', 100);
      expect(mockRunCaptureRules).toHaveBeenCalledWith('DEV002', 200);
    });

    it('does not reload on create of non-capture-rule', async () => {
      await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Regular',
          code: 'export default async function(d: any) {}',
        });

      expect(mockRunCaptureRules).not.toHaveBeenCalled();
    });

    it('reloads capture rules on update of capture rule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'CR', code: 'code', isCaptureRule: true });
      const id = createRes.body.data.id;
      mockRunCaptureRules.mockClear();

      await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ code: 'new code' });

      expect(mockRunCaptureRules).toHaveBeenCalledTimes(2);
    });

    it('reloads when automation changes from capture rule to non-capture-rule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'CR', code: 'code', isCaptureRule: true });
      const id = createRes.body.data.id;
      mockRunCaptureRules.mockClear();

      await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ isCaptureRule: false });

      // Should reload because existing.isCaptureRule was true
      expect(mockRunCaptureRules).toHaveBeenCalled();
    });

    it('does not reload on update of non-capture-rule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Regular', code: 'code' });
      const id = createRes.body.data.id;
      mockRunCaptureRules.mockClear();

      await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ name: 'Updated' });

      expect(mockRunCaptureRules).not.toHaveBeenCalled();
    });

    it('reloads capture rules on delete of capture rule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'CR', code: 'code', isCaptureRule: true });
      const id = createRes.body.data.id;
      mockRunCaptureRules.mockClear();

      await request(app).delete(`/v1/automation/delete/${id}`);

      expect(mockRunCaptureRules).toHaveBeenCalledTimes(2);
    });

    it('does not reload on delete of non-capture-rule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Regular', code: 'code' });
      const id = createRes.body.data.id;
      mockRunCaptureRules.mockClear();

      await request(app).delete(`/v1/automation/delete/${id}`);

      expect(mockRunCaptureRules).not.toHaveBeenCalled();
    });

    it('reloads capture rules on enable of capture rule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'CR', code: 'code', isCaptureRule: true, enabled: false });
      const id = createRes.body.data.id;
      mockRunCaptureRules.mockClear();

      await request(app).post(`/v1/automation/enable/${id}`);

      expect(mockRunCaptureRules).toHaveBeenCalledTimes(2);
    });

    it('reloads capture rules on disable of capture rule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'CR', code: 'code', isCaptureRule: true });
      const id = createRes.body.data.id;
      mockRunCaptureRules.mockClear();

      await request(app).post(`/v1/automation/disable/${id}`);

      expect(mockRunCaptureRules).toHaveBeenCalledTimes(2);
    });

    it('does not reload on enable of non-capture-rule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Regular', code: 'code', enabled: false });
      const id = createRes.body.data.id;
      mockRunCaptureRules.mockClear();

      await request(app).post(`/v1/automation/enable/${id}`);

      expect(mockRunCaptureRules).not.toHaveBeenCalled();
    });

    it('does not reload when no captureManager is provided', async () => {
      clearEndpoints();
      registerAutomationEndpoints(db, runner, compiler, scheduler);
      app = express();
      app.use(express.json());
      app.use(getApiRouter());

      mockRunCaptureRules.mockClear();

      await request(app)
        .post('/v1/automation/create')
        .send({ name: 'CR', code: 'code', isCaptureRule: true });

      expect(mockRunCaptureRules).not.toHaveBeenCalled();
    });
  });

  describe('Schedule CRUD', () => {
    it('sets a cron schedule via PUT', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Scheduled', code: 'code' });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/schedule/${id}`)
        .send({ schedule: { type: 'cron', expressions: ['0 9 * * *'] } });

      expect(res.status).toBe(200);
      expect(res.body.data.schedule.type).toBe('cron');
      expect(res.body.data.schedule.expressions).toEqual(['0 9 * * *']);
    });

    it('sets an interval schedule via PUT', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Interval', code: 'code' });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/schedule/${id}`)
        .send({ schedule: { type: 'interval', intervalMs: 1800000 } });

      expect(res.status).toBe(200);
      expect(res.body.data.schedule.type).toBe('interval');
      expect(res.body.data.schedule.intervalMs).toBe(1800000);
    });

    it('rejects interval < 60s', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'TooFast', code: 'code' });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/schedule/${id}`)
        .send({ schedule: { type: 'interval', intervalMs: 5000 } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('intervalMs >= 60000');
    });

    it('rejects cron with empty expressions', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'BadCron', code: 'code' });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/schedule/${id}`)
        .send({ schedule: { type: 'cron', expressions: [] } });

      expect(res.status).toBe(400);
    });

    it('deletes a schedule', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Sched', code: 'code' });
      const id = createRes.body.data.id;

      await request(app)
        .put(`/v1/automation/schedule/${id}`)
        .send({ schedule: { type: 'cron', expressions: ['0 9 * * *'] } });

      const delRes = await request(app).delete(`/v1/automation/schedule/${id}`);
      expect(delRes.status).toBe(200);

      const getRes = await request(app).get(`/v1/automation/schedule/${id}`);
      expect(getRes.body.data.schedule).toBeNull();
    });

    it('lists all active schedules', async () => {
      const a1 = await request(app).post('/v1/automation/create').send({ name: 'A1', code: 'c' });
      const a2 = await request(app).post('/v1/automation/create').send({ name: 'A2', code: 'c' });

      await request(app)
        .put(`/v1/automation/schedule/${a1.body.data.id}`)
        .send({ schedule: { type: 'cron', expressions: ['0 * * * *'] } });
      await request(app)
        .put(`/v1/automation/schedule/${a2.body.data.id}`)
        .send({ schedule: { type: 'interval', intervalMs: 60000 } });

      const res = await request(app).get('/v1/automation/schedules');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 404 for missing automation on GET schedule', async () => {
      const res = await request(app).get('/v1/automation/schedule/999');
      expect(res.status).toBe(404);
    });

    it('returns 404 for missing automation on PUT schedule', async () => {
      const res = await request(app)
        .put('/v1/automation/schedule/999')
        .send({ schedule: { type: 'cron', expressions: ['0 * * * *'] } });
      expect(res.status).toBe(404);
    });

    it('schedule is visible in automation view', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'WithSched', code: 'code' });
      const id = createRes.body.data.id;

      await request(app)
        .put(`/v1/automation/schedule/${id}`)
        .send({ schedule: { type: 'cron', expressions: ['30 8 * * 1-5'] } });

      const viewRes = await request(app).get(`/v1/automation/view/${id}`);
      expect(viewRes.body.data.schedule).toBeTruthy();
      const parsed = JSON.parse(viewRes.body.data.schedule);
      expect(parsed.type).toBe('cron');
    });

    it('removes schedule when automation is deleted', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'ToDel', code: 'code' });
      const id = createRes.body.data.id;

      await request(app)
        .put(`/v1/automation/schedule/${id}`)
        .send({ schedule: { type: 'cron', expressions: ['0 * * * *'] } });

      expect(scheduler.getSchedule(id)).not.toBeNull();

      await request(app).delete(`/v1/automation/delete/${id}`);

      expect(scheduler.getSchedule(id)).toBeNull();
    });

    it('updates schedule via automation update endpoint', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Upd', code: 'code' });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ schedule: { type: 'interval', intervalMs: 120000 } });

      expect(res.status).toBe(200);
      expect(scheduler.getSchedule(id)).toEqual({ type: 'interval', intervalMs: 120000 });
    });

    it('clears schedule via automation update endpoint with null', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Clear', code: 'code' });
      const id = createRes.body.data.id;

      await request(app)
        .put(`/v1/automation/schedule/${id}`)
        .send({ schedule: { type: 'cron', expressions: ['0 * * * *'] } });

      const res = await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ schedule: null });

      expect(res.status).toBe(200);
      expect(scheduler.getSchedule(id)).toBeNull();
    });
  });

  describe('POST /v1/automation/run/:id/:passcode', () => {
    it('queues automation with valid passcode', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const { id, passcode } = createRes.body.data;

      const res = await request(app)
        .post(`/v1/automation/run/${id}/${passcode}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.triggeredBy).toBe('api');
    });

    it('returns 403 for invalid passcode', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const { id } = createRes.body.data;

      const res = await request(app)
        .post(`/v1/automation/run/${id}/wrong-passcode`)
        .send({});

      expect(res.status).toBe(403);
    });

    it('returns 404 for non-existent automation', async () => {
      const res = await request(app)
        .post('/v1/automation/run/999/some-passcode')
        .send({});

      expect(res.status).toBe(404);
    });
  });

  describe('Device Filter CRUD', () => {
    it('creates automation with deviceFilter', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Filtered',
          code: 'code',
          deviceFilter: { rooted: true, minBattery: 80 },
        });

      expect(res.status).toBe(201);
      expect(res.body.data.deviceFilter).toBeTruthy();
      const parsed = JSON.parse(res.body.data.deviceFilter);
      expect(parsed.rooted).toBe(true);
      expect(parsed.minBattery).toBe(80);
    });

    it('creates automation with deviceIds filter', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'DeviceSpecific',
          code: 'code',
          deviceFilter: { deviceIds: ['dev1', 'dev2'] },
        });

      expect(res.status).toBe(201);
      const parsed = JSON.parse(res.body.data.deviceFilter);
      expect(parsed.deviceIds).toEqual(['dev1', 'dev2']);
    });

    it('creates automation without deviceFilter', async () => {
      const res = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'NoFilter', code: 'code' });

      expect(res.status).toBe(201);
      expect(res.body.data.deviceFilter).toBeNull();
    });

    it('updates deviceFilter on existing automation', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({ name: 'Test', code: 'code' });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ deviceFilter: { rooted: true } });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body.data.deviceFilter);
      expect(parsed.rooted).toBe(true);
    });

    it('clears deviceFilter with null', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Test',
          code: 'code',
          deviceFilter: { rooted: true },
        });
      const id = createRes.body.data.id;

      const res = await request(app)
        .put(`/v1/automation/update/${id}`)
        .send({ deviceFilter: null });

      expect(res.status).toBe(200);
      expect(res.body.data.deviceFilter).toBeNull();
    });

    it('deviceFilter is visible in automation view', async () => {
      const createRes = await request(app)
        .post('/v1/automation/create')
        .send({
          name: 'Visible',
          code: 'code',
          deviceFilter: { minBattery: 50, deviceIds: ['abc'] },
        });
      const id = createRes.body.data.id;

      const viewRes = await request(app).get(`/v1/automation/view/${id}`);
      expect(viewRes.body.data.deviceFilter).toBeTruthy();
      const parsed = JSON.parse(viewRes.body.data.deviceFilter);
      expect(parsed.minBattery).toBe(50);
      expect(parsed.deviceIds).toEqual(['abc']);
    });
  });

  describe('DELETE /v1/automation/session/:sessionId', () => {
    it('returns 404 for non-existent session', async () => {
      const res = await request(app).delete('/v1/automation/session/99999');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 for invalid session id', async () => {
      const res = await request(app).delete('/v1/automation/session/not-a-number');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('successfully deletes session and all related rows', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const autoId = createRes.body.data.id;

      const now = new Date();
      const sessionResult = db.insert(schema.automationSessions).values({
        automationId: autoId,
        status: 'success',
        triggerType: 'manual',
        startedAt: now,
      }).run();
      const sessionId = Number(sessionResult.lastInsertRowid);

      // Insert related rows
      db.insert(schema.screenshots).values({
        sessionId,
        filename: 'test-shot.png',
        capturedAt: now,
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId,
        requestMethod: 'GET',
        requestUrl: 'https://example.com/api',
        capturedAt: now,
      }).run();

      db.insert(schema.websocketMessages).values({
        sessionId,
        direction: 'receive',
        opcode: 'text',
        payload: 'hello',
        timestamp: now,
      }).run();

      // Confirm rows exist before delete
      expect(db.select().from(schema.automationSessions).all()).toHaveLength(1);
      expect(db.select().from(schema.screenshots).all()).toHaveLength(1);
      expect(db.select().from(schema.capturedTraffic).all()).toHaveLength(1);
      expect(db.select().from(schema.websocketMessages).all()).toHaveLength(1);

      const res = await request(app).delete(`/v1/automation/session/${sessionId}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // All related rows should be gone
      expect(db.select().from(schema.automationSessions).all()).toHaveLength(0);
      expect(db.select().from(schema.screenshots).all()).toHaveLength(0);
      expect(db.select().from(schema.capturedTraffic).all()).toHaveLength(0);
      expect(db.select().from(schema.websocketMessages).all()).toHaveLength(0);
    });

    it('returns success even if screenshot files do not exist on disk', async () => {
      const createRes = await request(app).post('/v1/automation/create').send({
        name: 'Test',
        code: 'code',
      });
      const autoId = createRes.body.data.id;

      const now = new Date();
      const sessionResult = db.insert(schema.automationSessions).values({
        automationId: autoId,
        status: 'success',
        triggerType: 'manual',
        startedAt: now,
      }).run();
      const sessionId = Number(sessionResult.lastInsertRowid);

      // Insert a screenshot row referencing a file that doesn't exist on disk
      db.insert(schema.screenshots).values({
        sessionId,
        filename: 'nonexistent-file-xyz-123.png',
        capturedAt: now,
      }).run();

      const res = await request(app).delete(`/v1/automation/session/${sessionId}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Session and screenshot row should still be deleted
      expect(db.select().from(schema.automationSessions).all()).toHaveLength(0);
      expect(db.select().from(schema.screenshots).all()).toHaveLength(0);
    });
  });
});
