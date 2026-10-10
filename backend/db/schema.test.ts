import { describe, it, expect, beforeEach } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import path from 'path';
import * as schema from './schema';
import { createTestDb } from '../test-utils/create-test-db';

const {
  proxies,
  devices,
  automations,
  automationSessions,
  screenshots,
  capturedTraffic,
} = schema;

describe('Database Schema', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('proxies', () => {
    it('should insert and retrieve a proxy', () => {
      const now = new Date();
      db.insert(proxies).values({
        url: 'http://proxy.example.com:8080',
        username: 'user',
        password: 'pass',
        createdAt: now,
      }).run();

      const result = db.select().from(proxies).all();
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('http://proxy.example.com:8080');
      expect(result[0].username).toBe('user');
      expect(result[0].password).toBe('pass');
      expect(result[0].failureCount).toBe(0);
      expect(result[0].enabled).toBe(true);
    });

    it('should use default values for failureCount and enabled', () => {
      db.insert(proxies).values({
        url: 'http://proxy2.example.com:8080',
        createdAt: new Date(),
      }).run();

      const result = db.select().from(proxies).all();
      expect(result[0].failureCount).toBe(0);
      expect(result[0].enabled).toBe(true);
    });

    it('should update proxy fields', () => {
      db.insert(proxies).values({
        url: 'http://proxy.example.com:8080',
        createdAt: new Date(),
      }).run();

      db.update(proxies)
        .set({ failureCount: 5, enabled: false })
        .where(eq(proxies.id, 1))
        .run();

      const result = db.select().from(proxies).where(eq(proxies.id, 1)).all();
      expect(result[0].failureCount).toBe(5);
      expect(result[0].enabled).toBe(false);
    });
  });

  describe('devices', () => {
    it('should insert and retrieve a device with text PK', () => {
      db.insert(devices).values({
        id: 'ABCDEF123456',
        name: 'Pixel 6',
      }).run();

      const result = db.select().from(devices).where(eq(devices.id, 'ABCDEF123456')).all();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Pixel 6');
      expect(result[0].isRooted).toBe(false);
      expect(result[0].setupVersion).toBe(0);
      expect(result[0].bridgePort).toBeNull();
    });

    it('should store bridge port assignment', () => {
      db.insert(devices).values({
        id: 'DEV001',
        name: 'Galaxy S22',
        bridgePort: 9100,
      }).run();

      const result = db.select().from(devices).where(eq(devices.id, 'DEV001')).all();
      expect(result[0].bridgePort).toBe(9100);
    });
  });

  describe('automations', () => {
    it('should insert and retrieve an automation', () => {
      const now = new Date();
      db.insert(automations).values({
        name: 'Test Automation',
        code: 'export default async function(device) { await device.click({ text: "OK" }); }',
        passcode: 'abc123',
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = db.select().from(automations).all();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Automation');
      expect(result[0].requiresHttpsCapture).toBe(false);
      expect(result[0].timeoutMs).toBe(300000);
      expect(result[0].isRule).toBe(false);
      expect(result[0].priority).toBe(0);
    });

    it('should support rule automations with priority', () => {
      const now = new Date();
      db.insert(automations).values({
        name: 'Cookie Accept Rule',
        code: 'export default async function(device) {}',
        passcode: 'rule123',
        isRule: true,
        priority: 10,
        createdAt: now,
        updatedAt: now,
      }).run();

      const result = db.select().from(automations).all();
      expect(result[0].isRule).toBe(true);
      expect(result[0].priority).toBe(10);
    });
  });

  describe('automationSessions', () => {
    it('should insert a session with FK references', () => {
      const now = new Date();
      db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();
      db.insert(automations).values({
        name: 'Auto',
        code: 'code',
        passcode: 'pass',
        createdAt: now,
        updatedAt: now,
      }).run();

      db.insert(automationSessions).values({
        automationId: 1,
        deviceId: 'DEV001',
        status: 'running',
        triggerType: 'manual',
        startedAt: now,
      }).run();

      const result = db.select().from(automationSessions).all();
      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('running');
      expect(result[0].triggerType).toBe('manual');
      expect(result[0].completedAt).toBeNull();
    });

    it('should update session status on completion', () => {
      const now = new Date();
      db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();
      db.insert(automations).values({
        name: 'Auto',
        code: 'code',
        passcode: 'pass',
        createdAt: now,
        updatedAt: now,
      }).run();
      db.insert(automationSessions).values({
        automationId: 1,
        deviceId: 'DEV001',
        status: 'running',
        triggerType: 'schedule',
        startedAt: now,
      }).run();

      const completedAt = new Date();
      db.update(automationSessions)
        .set({ status: 'success', completedAt, logs: 'All steps passed' })
        .where(eq(automationSessions.id, 1))
        .run();

      const result = db.select().from(automationSessions).where(eq(automationSessions.id, 1)).all();
      expect(result[0].status).toBe('success');
      expect(result[0].logs).toBe('All steps passed');
      expect(result[0].completedAt).not.toBeNull();
    });
  });

  describe('screenshots', () => {
    it('should insert and retrieve a screenshot', () => {
      const now = new Date();
      db.insert(screenshots).values({
        filename: 'screenshot-001.png',
        name: 'Login Screen',
        domSnapshot: '<hierarchy>...</hierarchy>',
        capturedAt: now,
      }).run();

      const result = db.select().from(screenshots).all();
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('screenshot-001.png');
      expect(result[0].name).toBe('Login Screen');
      expect(result[0].domSnapshot).toBe('<hierarchy>...</hierarchy>');
    });
  });

  describe('capturedTraffic', () => {
    it('should insert and retrieve traffic entries', () => {
      const now = new Date();
      db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();

      db.insert(capturedTraffic).values({
        deviceId: 'DEV001',
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        requestHeaders: JSON.stringify({ 'Content-Type': 'application/json' }),
        responseStatus: 200,
        responseBody: '{"ok": true}',
        capturedAt: now,
      }).run();

      const result = db.select().from(capturedTraffic).all();
      expect(result).toHaveLength(1);
      expect(result[0].requestMethod).toBe('GET');
      expect(result[0].requestUrl).toBe('https://api.example.com/data');
      expect(result[0].responseStatus).toBe(200);
    });

    it('should allow nullable sessionId', () => {
      const now = new Date();
      db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();

      db.insert(capturedTraffic).values({
        deviceId: 'DEV001',
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/submit',
        capturedAt: now,
      }).run();

      const result = db.select().from(capturedTraffic).all();
      expect(result[0].sessionId).toBeNull();
    });
  });

  describe('delete operations', () => {
    it('should delete records correctly', () => {
      db.insert(proxies).values({
        url: 'http://proxy.example.com:8080',
        createdAt: new Date(),
      }).run();

      expect(db.select().from(proxies).all()).toHaveLength(1);

      db.delete(proxies).where(eq(proxies.id, 1)).run();

      expect(db.select().from(proxies).all()).toHaveLength(0);
    });
  });
});

describe('ai_pipelines tables', () => {
  it('cascades deletes from aiPipelines through to aiPipelineNodeRuns', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE ai_pipelines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        job_kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE ai_pipeline_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_id INTEGER NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        graph TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at INTEGER NOT NULL,
        UNIQUE(pipeline_id, version)
      );
      CREATE TABLE ai_pipeline_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pipeline_version_id INTEGER NOT NULL REFERENCES ai_pipeline_versions(id) ON DELETE CASCADE,
        trigger_node_id TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        input TEXT,
        reuse_unchanged INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE ai_pipeline_node_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES ai_pipeline_runs(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        status TEXT NOT NULL,
        input TEXT,
        input_hash TEXT,
        was_memoized INTEGER NOT NULL DEFAULT 0,
        output TEXT,
        error TEXT,
        model_used TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `);
    const db = drizzle(sqlite, { schema });

    const now = new Date();
    db.insert(schema.aiPipelines).values({ id: 1, name: 'Astérix', jobKind: 'apk-analysis', createdAt: now }).run();
    db.insert(schema.aiPipelineVersions).values({ id: 1, pipelineId: 1, version: 1, graph: { nodes: [], edges: [] }, status: 'published', createdAt: now }).run();
    db.insert(schema.aiPipelineRuns).values({ id: 1, pipelineVersionId: 1, triggerNodeId: 'trigger', triggeredBy: 'manual', status: 'running', startedAt: now }).run();
    db.insert(schema.aiPipelineNodeRuns).values({ id: 1, runId: 1, nodeId: 'agent-overview', status: 'ok', startedAt: now }).run();

    db.delete(schema.aiPipelines).where(eq(schema.aiPipelines.id, 1)).run();

    expect(db.select().from(schema.aiPipelineNodeRuns).all()).toHaveLength(0);
  });
});

describe('migration 0102_ai_pipelines.sql', () => {
  function applyMigration(sqlite: Database.Database) {
    const dir = path.resolve(__dirname, '../../migrations');
    const file = fs.readdirSync(dir).find((f) => f.startsWith('0102_ai_pipelines'))!;
    expect(file).toBeTruthy();
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) if (stmt.trim()) sqlite.exec(stmt);
  }

  it('creates the four tables and cascades a pipeline delete through all children', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigration(sqlite);

    const tables = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_pipeline%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(['ai_pipeline_node_runs', 'ai_pipeline_runs', 'ai_pipeline_versions', 'ai_pipelines']);

    sqlite.exec(`
      INSERT INTO ai_pipelines (id, name, job_kind, created_at) VALUES (1, 'p', 'apk-analysis', 1000);
      INSERT INTO ai_pipeline_versions (id, pipeline_id, version, graph, created_at) VALUES (1, 1, 1, '{"nodes":[],"edges":[]}', 1000);
      INSERT INTO ai_pipeline_runs (id, pipeline_version_id, trigger_node_id, triggered_by, started_at) VALUES (1, 1, 't', 'manual', 1000);
      INSERT INTO ai_pipeline_node_runs (run_id, node_id, status, started_at) VALUES (1, 'n', 'ok', 1000);
    `);
    sqlite.prepare('DELETE FROM ai_pipelines WHERE id = 1').run();

    for (const t of ['ai_pipeline_versions', 'ai_pipeline_runs', 'ai_pipeline_node_runs']) {
      expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
    }
  });

  it('enforces unique (pipeline_id, version)', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigration(sqlite);
    sqlite.exec(`INSERT INTO ai_pipelines (id, name, job_kind, created_at) VALUES (1, 'p', 'apk-analysis', 1000);`);
    const ins = sqlite.prepare(`INSERT INTO ai_pipeline_versions (pipeline_id, version, graph, created_at) VALUES (1, 1, '{}', 1000)`);
    ins.run();
    expect(() => ins.run()).toThrow(/UNIQUE/);
  });
});
