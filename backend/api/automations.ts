import { eq, and, gte, lte, like, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { existsSync, unlinkSync } from 'fs';
import { stat } from 'fs/promises';
import { join, resolve } from 'path';
import { getDataRoot } from '../config/paths';
import { registerEndpoint } from './api-service';
import { automations, automationSessions, screenshots, capturedTraffic, websocketMessages, apiEndpointSessions } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { AutomationRunner } from '../services/automation-runner';
import { AutomationCompiler } from '../services/automation-compiler';
import { AutomationScheduler } from '../services/automation-scheduler';
import { validateScheduleConfig } from '../services/schedule-validator';
import { exportSessionHar, exportSessionZip } from '../services/session-export';
import { importSessionHar, importSessionZip } from '../services/session-import';
import type { CaptureSessionManager } from '../services/capture-session-manager';
import type { FileStorageService } from '../services/file-storage';
import type { TriggerType, SessionStatus, ScheduleConfig } from '../../shared/types/api';

const SCREENSHOT_PATH = resolve(process.env.SCREENSHOT_PATH || join(getDataRoot(), 'screenshots'));

export function registerAutomationEndpoints(
  db: AppDatabase,
  runner: AutomationRunner,
  compiler: AutomationCompiler,
  scheduler: AutomationScheduler,
  captureManager?: CaptureSessionManager,
  fileSync?: FileStorageService,
): void {
  function reloadCaptureRules() {
    if (!captureManager) return;
    const deviceIds = captureManager.getCapturingDeviceIds();
    for (const deviceId of deviceIds) {
      const sessionId = captureManager.getSessionId(deviceId);
      if (sessionId !== undefined) {
        runner.runCaptureRules(deviceId, sessionId).catch(() => {});
      }
    }
  }

  function waitForCompletion(
    automationId: number,
    timeoutMs: number,
  ): Promise<{ sessionId: number; status: string; success: boolean }> {
    const maxWait = timeoutMs + 30_000;
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      // Initial delay before first poll
      setTimeout(() => {
        const poll = () => {
          const sessions = db
            .select()
            .from(automationSessions)
            .where(eq(automationSessions.automationId, automationId))
            .orderBy(desc(automationSessions.startedAt))
            .limit(1)
            .all();

          if (sessions.length > 0 && sessions[0].status !== 'running') {
            resolve({
              sessionId: sessions[0].id,
              status: sessions[0].status,
              success: sessions[0].status === 'success',
            });
            return;
          }

          if (Date.now() - startTime > maxWait) {
            reject(new Error('Timeout waiting for automation completion'));
            return;
          }

          setTimeout(poll, 1000);
        };
        poll();
      }, 500);
    });
  }

  // GET /v1/automation/list
  registerEndpoint('GET', '/v1/automation/list', (req, res) => {
    const isRule = req.query.isRule;
    const isCaptureRule = req.query.isCaptureRule;
    let results;

    if (isCaptureRule !== undefined) {
      const flag = isCaptureRule === 'true';
      results = db.select().from(automations).where(eq(automations.isCaptureRule, flag)).all();
    } else if (isRule !== undefined) {
      const ruleFlag = isRule === 'true';
      results = db.select().from(automations).where(eq(automations.isRule, ruleFlag)).all();
    } else {
      results = db.select().from(automations).all();
    }

    res.json({ success: true, data: results });
  }, { requires: ['core.automations:read'] });

  // POST /v1/automation/create
  registerEndpoint('POST', '/v1/automation/create', (req, res) => {
    const { name, code, timeoutMs, requiresDevice, requiresHttpsCapture, isRule, isCaptureRule, priority, enabled } = req.body;

    if (!name || !code) {
      res.status(400).json({ success: false, error: 'name and code are required' });
      return;
    }

    if (isRule && isCaptureRule) {
      res.status(400).json({ success: false, error: 'isRule and isCaptureRule are mutually exclusive' });
      return;
    }

    const passcode = randomUUID();
    const now = new Date();

    db.insert(automations)
      .values({
        name,
        code,
        passcode,
        timeoutMs: timeoutMs ?? 300000,
        requiresDevice: requiresDevice ?? true,
        requiresHttpsCapture: requiresHttpsCapture ?? false,
        isRule: isRule ?? false,
        isCaptureRule: isCaptureRule ?? false,
        priority: priority ?? 0,
        enabled: enabled ?? true,
        deviceFilter: req.body.deviceFilter ? JSON.stringify(req.body.deviceFilter) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const all = db.select().from(automations).all();
    const created = all[all.length - 1];

    // Set schedule if provided
    if (req.body.schedule) {
      const validation = validateScheduleConfig(req.body.schedule);
      if (!validation.valid) {
        // Automation is already created, but schedule is invalid — still return it without schedule
        res.status(201).json({ success: true, data: created });
        return;
      }
      scheduler.setSchedule(created.id, req.body.schedule as ScheduleConfig);
    }

    if (isCaptureRule) {
      reloadCaptureRules();
    }

    // Re-fetch to include schedule column
    const final = db.select().from(automations).where(eq(automations.id, created.id)).all()[0];
    res.status(201).json({ success: true, data: final });
  }, { requires: ['core.automations:edit'] });

  // GET /v1/automation/view/:id
  registerEndpoint('GET', '/v1/automation/view/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const automation = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!automation) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    res.json({ success: true, data: automation });
  }, { requires: ['core.automations:read'] });

  // PUT /v1/automation/update/:id
  registerEndpoint('PUT', '/v1/automation/update/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const existing = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.code !== undefined) updates.code = req.body.code;
    if (req.body.timeoutMs !== undefined) updates.timeoutMs = req.body.timeoutMs;
    if (req.body.requiresDevice !== undefined) updates.requiresDevice = req.body.requiresDevice;
    if (req.body.requiresHttpsCapture !== undefined) updates.requiresHttpsCapture = req.body.requiresHttpsCapture;
    if (req.body.isRule !== undefined) updates.isRule = req.body.isRule;
    if (req.body.isCaptureRule !== undefined) updates.isCaptureRule = req.body.isCaptureRule;
    if (req.body.priority !== undefined) updates.priority = req.body.priority;
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
    if (req.body.deviceFilter !== undefined) {
      updates.deviceFilter = req.body.deviceFilter ? JSON.stringify(req.body.deviceFilter) : null;
    }

    const finalIsRule = updates.isRule ?? existing.isRule;
    const finalIsCaptureRule = updates.isCaptureRule ?? existing.isCaptureRule;
    if (finalIsRule && finalIsCaptureRule) {
      res.status(400).json({ success: false, error: 'isRule and isCaptureRule are mutually exclusive' });
      return;
    }

    db.update(automations).set(updates).where(eq(automations.id, id)).run();

    // Handle schedule update
    if (req.body.schedule !== undefined) {
      if (req.body.schedule === null) {
        scheduler.removeSchedule(id);
      } else {
        const validation = validateScheduleConfig(req.body.schedule);
        if (validation.valid) {
          scheduler.setSchedule(id, req.body.schedule as ScheduleConfig);
        }
      }
    }

    if (finalIsCaptureRule || existing.isCaptureRule) {
      reloadCaptureRules();
    }

    const updated = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    res.json({ success: true, data: updated });
  }, { requires: ['core.automations:edit'] });

  // DELETE /v1/automation/delete/:id
  registerEndpoint('DELETE', '/v1/automation/delete/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const existing = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    scheduler.removeSchedule(id);
    db.delete(automations).where(eq(automations.id, id)).run();

    if (existing.isCaptureRule) {
      reloadCaptureRules();
    }

    res.json({ success: true });
  }, { requires: ['core.automations:edit'] });

  // POST /v1/automation/enable/:id
  registerEndpoint('POST', '/v1/automation/enable/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const existing = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    db.update(automations).set({ enabled: true, updatedAt: new Date() }).where(eq(automations.id, id)).run();

    if (existing.isCaptureRule) {
      reloadCaptureRules();
    }

    const updated = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    res.json({ success: true, data: updated });
  }, { requires: ['core.automations:edit'] });

  // POST /v1/automation/disable/:id
  registerEndpoint('POST', '/v1/automation/disable/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const existing = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!existing) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    db.update(automations).set({ enabled: false, updatedAt: new Date() }).where(eq(automations.id, id)).run();

    if (existing.isCaptureRule) {
      reloadCaptureRules();
    }

    const updated = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    res.json({ success: true, data: updated });
  }, { requires: ['core.automations:edit'] });

  // POST /v1/automation/run/:id — manual trigger
  registerEndpoint('POST', '/v1/automation/run/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const automation = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!automation) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    const deviceId = req.body.deviceId;
    const triggerType: TriggerType = req.body.triggerType || 'manual';

    if (!deviceId) {
      // Deviceless automations can run immediately without a device
      if (!automation.requiresDevice) {
        try {
          const result = await runner.runAutomation(id, undefined, triggerType);
          res.json({ success: true, data: result });
        } catch (err: any) {
          res.status(500).json({ success: false, error: err.message });
        }
        return;
      }
      // Queue automation if no device specified
      const queued = scheduler.enqueue(id, triggerType);
      res.json({ success: true, data: { queued } });
      return;
    }

    try {
      const result = await runner.runAutomation(id, deviceId, triggerType);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  }, { requires: ['core.automations:execute'] });

  // POST /v1/automation/session/:sessionId/cancel — abort an in-flight run
  registerEndpoint('POST', '/v1/automation/session/:sessionId/cancel', (req, res) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (isNaN(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session id' });
      return;
    }
    const cancelled = runner.cancelRun(sessionId);
    if (!cancelled) {
      res.status(404).json({ success: false, error: 'No active run for that session' });
      return;
    }
    res.json({ success: true, data: { sessionId, cancelled: true } });
  }, { requires: ['core.automations:execute'] });

  // GET /v1/automation/run/:id/:passcode — external trigger
  registerEndpoint('GET', '/v1/automation/run/:id/:passcode', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const automation = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!automation) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    if (automation.passcode !== req.params.passcode) {
      res.status(403).json({ success: false, error: 'Invalid passcode' });
      return;
    }

    const deviceId = req.query.deviceId as string | undefined;
    const wait = req.query.wait === 'true';

    if (deviceId) {
      try {
        const result = await runner.runAutomation(id, deviceId, 'api');
        res.json({ success: true, data: { ...result, triggeredBy: 'api' } });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }

    const queued = scheduler.enqueue(id, 'api');

    if (wait) {
      try {
        const result = await waitForCompletion(id, automation.timeoutMs ?? 300000);
        res.json({ success: true, data: { ...result, triggeredBy: 'api' } });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }

    res.json({ success: true, data: { queued, triggeredBy: 'api' } });
  });

  // POST /v1/automation/run/:id/:passcode — external trigger with body
  registerEndpoint('POST', '/v1/automation/run/:id/:passcode', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const automation = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!automation) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    if (automation.passcode !== req.params.passcode) {
      res.status(403).json({ success: false, error: 'Invalid passcode' });
      return;
    }

    const deviceId = req.body.deviceId as string | undefined;
    const wait = req.query.wait === 'true';

    if (deviceId) {
      try {
        const result = await runner.runAutomation(id, deviceId, 'api');
        res.json({ success: true, data: { ...result, triggeredBy: 'api' } });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }

    const queued = scheduler.enqueue(id, 'api');

    if (wait) {
      try {
        const result = await waitForCompletion(id, automation.timeoutMs ?? 300000);
        res.json({ success: true, data: { ...result, triggeredBy: 'api' } });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
      return;
    }

    res.json({ success: true, data: { queued, triggeredBy: 'api' } });
  });

  // PATCH /v1/automation/session/:sessionId — update session (name, isPinned, notes)
  registerEndpoint('PATCH', '/v1/automation/session/:sessionId', (req, res) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (isNaN(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session id' });
      return;
    }

    const session = db.select().from(automationSessions).where(eq(automationSessions.id, sessionId)).all()[0];
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    const updates: Record<string, any> = {};
    if (typeof req.body.name === 'string') updates.name = req.body.name;
    if (typeof req.body.isPinned === 'boolean') updates.isPinned = req.body.isPinned;
    if (req.body.notes !== undefined) {
      updates.notes = typeof req.body.notes === 'string' ? req.body.notes : null;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ success: false, error: 'name, isPinned, or notes is required' });
      return;
    }

    db.update(automationSessions).set(updates).where(eq(automationSessions.id, sessionId)).run();
    const updated = db.select().from(automationSessions).where(eq(automationSessions.id, sessionId)).all()[0];
    res.json({ success: true, data: updated });
  }, { requires: ['core.automations:edit'] });

  // DELETE /v1/automation/session/:sessionId — delete session and all related data
  registerEndpoint('DELETE', '/v1/automation/session/:sessionId', (req, res) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (isNaN(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session id' });
      return;
    }

    const session = db.select().from(automationSessions).where(eq(automationSessions.id, sessionId)).all()[0];
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    // Delete screenshot files from disk
    const screenshotRows = db.select({ filename: screenshots.filename })
      .from(screenshots)
      .where(eq(screenshots.sessionId, sessionId))
      .all();
    for (const row of screenshotRows) {
      try {
        const filePath = join(getDataRoot(), 'screenshots', row.filename);
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch { /* file may already be deleted */ }
    }

    // Delete in FK order: screenshots → WS messages → traffic → endpoint junctions → session
    db.delete(screenshots).where(eq(screenshots.sessionId, sessionId)).run();
    db.delete(websocketMessages).where(eq(websocketMessages.sessionId, sessionId)).run();
    db.delete(capturedTraffic).where(eq(capturedTraffic.sessionId, sessionId)).run();
    db.delete(apiEndpointSessions).where(eq(apiEndpointSessions.sessionId, sessionId)).run();
    db.delete(automationSessions).where(eq(automationSessions.id, sessionId)).run();

    res.json({ success: true });
  }, { requires: ['core.automations:edit'] });

  // GET /v1/automation/sessions — all sessions (with optional limit, offset, filters)
  registerEndpoint('GET', '/v1/automation/sessions', (req, res) => {
    const status = req.query.status as string | undefined;
    const triggerType = req.query.triggerType as string | undefined;
    const pinned = req.query.pinned as string | undefined;
    const deviceId = req.query.deviceId as string | undefined;
    const search = req.query.search as string | undefined;
    const showManaged = req.query.showManaged === 'true';
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const limit = parseInt(req.query.limit as string, 10);

    const conditions: any[] = [];
    if (status) {
      conditions.push(eq(automationSessions.status, status as any));
    }
    if (triggerType) {
      conditions.push(eq(automationSessions.triggerType, triggerType as any));
    }
    if (pinned === 'true') {
      conditions.push(eq(automationSessions.isPinned, true));
    } else if (pinned === 'false') {
      conditions.push(eq(automationSessions.isPinned, false));
    }
    if (deviceId) {
      conditions.push(eq(automationSessions.deviceId, deviceId));
    }
    if (search) {
      conditions.push(like(automationSessions.name, `%${search}%`));
    }
    // Hide managed sessions by default — plugin-driven runs would otherwise
    // drown the operator's own automations in the history feed. The
    // session-history UI surfaces them behind a "Show managed (N)" toggle.
    if (!showManaged) {
      conditions.push(eq(automationSessions.managed, false));
    }

    const whereClause = conditions.length > 0
      ? conditions.length === 1 ? conditions[0] : and(...conditions)
      : undefined;

    const countQuery = db.select({ count: sql<number>`count(*)` }).from(automationSessions);
    const total = (whereClause ? countQuery.where(whereClause) : countQuery).all()[0].count;

    // Also surface the count of managed sessions matching the OTHER filters
    // (status / triggerType / etc, but NOT the managed clause) so the UI
    // can render an accurate "Show managed (N)" toggle without a second
    // request. Rebuild conditions without the managed clause to be safe.
    const otherConditions: any[] = [];
    if (status) otherConditions.push(eq(automationSessions.status, status as any));
    if (triggerType) otherConditions.push(eq(automationSessions.triggerType, triggerType as any));
    if (pinned === 'true') otherConditions.push(eq(automationSessions.isPinned, true));
    else if (pinned === 'false') otherConditions.push(eq(automationSessions.isPinned, false));
    if (deviceId) otherConditions.push(eq(automationSessions.deviceId, deviceId));
    if (search) otherConditions.push(like(automationSessions.name, `%${search}%`));
    otherConditions.push(eq(automationSessions.managed, true));
    const managedTotal = db.select({ count: sql<number>`count(*)` })
      .from(automationSessions)
      .where(otherConditions.length === 1 ? otherConditions[0] : and(...otherConditions))
      .all()[0].count;

    let query = db.select().from(automationSessions);
    if (whereClause) query = query.where(whereClause) as any;
    query = query.orderBy(desc(automationSessions.startedAt)) as any;
    if (!isNaN(limit) && limit > 0) {
      query = query.limit(limit).offset(offset) as any;
    } else if (offset > 0) {
      query = query.offset(offset) as any;
    }

    const results = query.all();
    res.json({ success: true, data: { items: results, total, managedTotal, limit: limit || results.length, offset } });
  }, { requires: ['core.automations:read'] });

  // GET /v1/automation/sessions/:id — session history for a specific automation
  registerEndpoint('GET', '/v1/automation/sessions/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    let results = db
      .select()
      .from(automationSessions)
      .where(eq(automationSessions.automationId, id))
      .orderBy(desc(automationSessions.startedAt))
      .all();

    // Apply filters from query params
    const status = req.query.status as string | undefined;
    const triggerType = req.query.triggerType as string | undefined;
    const startTime = req.query.startTime as string | undefined;
    const endTime = req.query.endTime as string | undefined;

    if (status) {
      results = results.filter((s) => s.status === status);
    }
    if (triggerType) {
      results = results.filter((s) => s.triggerType === triggerType);
    }
    if (startTime) {
      const start = new Date(startTime);
      results = results.filter((s) => s.startedAt && s.startedAt >= start);
    }
    if (endTime) {
      const end = new Date(endTime);
      results = results.filter((s) => s.startedAt && s.startedAt <= end);
    }

    res.json({ success: true, data: results });
  }, { requires: ['core.automations:read'] });

  // GET /v1/automation/session/:sessionId — full session detail
  registerEndpoint('GET', '/v1/automation/session/:sessionId', (req, res) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (isNaN(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session id' });
      return;
    }

    const session = db
      .select()
      .from(automationSessions)
      .where(eq(automationSessions.id, sessionId))
      .all()[0];

    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }

    const sessionScreenshots = db
      .select()
      .from(screenshots)
      .where(eq(screenshots.sessionId, sessionId))
      .all();

    const sessionTraffic = db
      .select()
      .from(capturedTraffic)
      .where(eq(capturedTraffic.sessionId, sessionId))
      .all();

    const wsMessages = db
      .select()
      .from(websocketMessages)
      .where(eq(websocketMessages.sessionId, sessionId))
      .all();

    res.json({
      success: true,
      data: {
        session,
        screenshots: sessionScreenshots,
        traffic: sessionTraffic,
        wsMessages,
      },
    });
  }, { requires: ['core.automations:read'] });

  // GET /v1/automation/schedules — list all active schedules
  registerEndpoint('GET', '/v1/automation/schedules', (_req, res) => {
    const schedules = scheduler.getSchedules();
    const data: Array<{ automationId: number; schedule: ScheduleConfig }> = [];
    for (const [automationId, schedule] of schedules) {
      data.push({ automationId, schedule });
    }
    res.json({ success: true, data });
  }, { requires: ['core.automations:read'] });

  // GET /v1/automation/schedule/:id — get schedule for one automation
  registerEndpoint('GET', '/v1/automation/schedule/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const automation = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!automation) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    const schedule = scheduler.getSchedule(id);
    res.json({ success: true, data: { automationId: id, schedule } });
  }, { requires: ['core.automations:edit'] });

  // PUT /v1/automation/schedule/:id — set schedule
  registerEndpoint('PUT', '/v1/automation/schedule/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const automation = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!automation) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    const { schedule } = req.body;
    const validation = validateScheduleConfig(schedule);
    if (!validation.valid) {
      res.status(400).json({ success: false, error: validation.error });
      return;
    }

    scheduler.setSchedule(id, schedule as ScheduleConfig);
    res.json({ success: true, data: { automationId: id, schedule } });
  }, { requires: ['core.automations:edit'] });

  // DELETE /v1/automation/schedule/:id — remove schedule
  registerEndpoint('DELETE', '/v1/automation/schedule/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid automation id' });
      return;
    }

    const automation = db.select().from(automations).where(eq(automations.id, id)).all()[0];
    if (!automation) {
      res.status(404).json({ success: false, error: 'Automation not found' });
      return;
    }

    scheduler.removeSchedule(id);
    res.json({ success: true });
  }, { requires: ['core.automations:edit'] });

  // GET /v1/automation/queue
  registerEndpoint('GET', '/v1/automation/queue', (_req, res) => {
    const queue = scheduler.getQueue();
    res.json({ success: true, data: queue });
  }, { requires: ['core.automations:execute'] });

  // GET /v1/automation/queue/status — detailed queue diagnostics
  registerEndpoint('GET', '/v1/automation/queue/status', (_req, res) => {
    const status = scheduler.getQueueStatus();
    res.json({ success: true, data: status });
  }, { requires: ['core.automations:read'] });

  // DELETE /v1/automation/queue — clear the queue
  registerEndpoint('DELETE', '/v1/automation/queue', (_req, res) => {
    const removed = scheduler.clearQueue();
    res.json({ success: true, removed });
  }, { requires: ['core.automations:execute'] });

  // POST /v1/automation/validate
  registerEndpoint('POST', '/v1/automation/validate', (req, res) => {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ success: false, error: 'code is required' });
      return;
    }

    const result = compiler.compileWithCache(code, 'validation-temp');
    const errors = (result.diagnostics || []).map((d) => {
      const pos = d.file?.getLineAndCharacterOfPosition(d.start || 0);
      return {
        line: pos?.line ?? 0,
        column: pos?.character ?? 0,
        message: typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText,
        severity: d.category,
      };
    });

    res.json({
      success: true,
      data: {
        errors,
        valid: errors.filter((e) => e.severity === 1).length === 0,
      },
    });
  }, { requires: ['core.automations:read'] });

  // GET /v1/automation/types
  registerEndpoint('GET', '/v1/automation/types', (_req, res) => {
    const typeDefs = compiler.getTypeDefinitions();
    res.send(typeDefs);
  }, { requires: ['core.automations:read'] });

  // GET /v1/automation/session/:sessionId/export/har
  registerEndpoint('GET', '/v1/automation/session/:sessionId/export/har', (req, res) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (isNaN(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session id' });
      return;
    }

    const found = exportSessionHar(db, sessionId, res);
    if (!found) {
      res.status(404).json({ success: false, error: 'Session not found' });
    }
  }, { requires: ['core.automations:read'] });

  // GET /v1/automation/session/:sessionId/export/zip
  registerEndpoint('GET', '/v1/automation/session/:sessionId/export/zip', async (req, res) => {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (isNaN(sessionId)) {
      res.status(400).json({ success: false, error: 'Invalid session id' });
      return;
    }

    const found = await exportSessionZip(db, sessionId, SCREENSHOT_PATH, res, fileSync);
    if (!found) {
      res.status(404).json({ success: false, error: 'Session not found' });
    }
  }, { requires: ['core.automations:read'] });

  // POST /v1/automation/session/import/har — import session from HAR JSON
  registerEndpoint('POST', '/v1/automation/session/import/har', (req, res) => {
    const harJson = req.body?.har;
    const name = req.body?.name;
    if (!harJson || !harJson.log) {
      res.status(400).json({ success: false, error: 'Invalid HAR data: must include { har: { log: { entries: [...] } } }' });
      return;
    }

    const result = importSessionHar(db, harJson, name);
    res.json({ success: true, data: result });
  }, { requires: ['core.automations:edit'] });

  // POST /v1/automation/session/import/zip — import session from ZIP file (raw body)
  registerEndpoint('POST', '/v1/automation/session/import/zip', async (req, res) => {
    // Expect base64-encoded ZIP in JSON body
    const base64 = req.body?.zip;
    const name = req.body?.name;
    if (!base64 || typeof base64 !== 'string') {
      res.status(400).json({ success: false, error: 'Missing zip field (base64-encoded ZIP)' });
      return;
    }

    let zipBuffer: Buffer;
    try {
      zipBuffer = Buffer.from(base64, 'base64');
    } catch {
      res.status(400).json({ success: false, error: 'Invalid base64 data' });
      return;
    }

    try {
      const result = await importSessionZip(db, zipBuffer, SCREENSHOT_PATH, name);
      res.json({ success: true, data: result });
    } catch (err: any) {
      res.status(400).json({ success: false, error: `Failed to import ZIP: ${err.message}` });
    }
  }, { requires: ['core.automations:edit'] });

  // GET /v1/screenshots/:filename — dynamic screenshot serve with cloud fallback
  registerEndpoint('GET', '/v1/screenshots/:filename', async (req, res) => {
    const { filename } = req.params;

    // Security: prevent path traversal
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      res.status(400).json({ success: false, error: 'Invalid filename' });
      return;
    }

    const localPath = join(SCREENSHOT_PATH, filename);

    // Try local file first (fast path)
    try {
      const fileStat = await stat(localPath);
      if (fileStat.isFile()) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.sendFile(localPath, { root: '/' });
        return;
      }
    } catch {
      // File not found locally, try cloud
    }

    // Cloud fallback
    if (!fileSync) {
      res.status(404).json({ success: false, error: 'Screenshot not found' });
      return;
    }

    // Parse sessionId from filename pattern: {sessionId}_{timestamp}_{name}.png
    const match = filename.match(/^(\d+)_/);
    if (!match) {
      res.status(404).json({ success: false, error: 'Screenshot not found' });
      return;
    }

    const sessionId = match[1];
    const cloudKey = `sessions/${sessionId}/${filename}`;

    const result = await fileSync.acquireLocal(cloudKey, 'screenshot-serve', localPath);
    if (result.error || !result.path) {
      res.status(404).json({ success: false, error: 'Screenshot not found' });
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(result.path, { root: '/' });
  }, { requires: ['core.automations:read'] });
}
