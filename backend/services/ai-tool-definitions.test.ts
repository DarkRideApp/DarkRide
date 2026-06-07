import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as schema from '../db/schema';
import { AiToolRegistry } from './ai-tools';
import { registerAllTools } from './ai-tool-definitions';
import { createTestDb } from '../test-utils/create-test-db';

const mockBroadcastToAll = vi.fn();
vi.mock('../websocket/index', () => ({
  broadcastToAll: (...args: any[]) => mockBroadcastToAll(...args),
}));

const NOW = Math.floor(Date.now() / 1000);

// Mock the frida-bridge module so we can assert that the AI tools call
// callFridaBridge directly (without HTTP loopback). Other tests in this
// file don't touch frida tools, so the mock is inert for them.
const mockCallFridaBridge = vi.fn();
vi.mock('./frida-bridge', () => ({
  callFridaBridge: (...args: any[]) => mockCallFridaBridge(...args),
}));

// Mock intercept-config-writer: it writes a file to disk in production but
// is irrelevant to tool behaviour we're asserting on.
const mockSyncInterceptConfig = vi.fn();
vi.mock('./intercept-config-writer', () => ({
  syncInterceptConfig: (...args: any[]) => mockSyncInterceptConfig(...args),
}));

describe('registerAllTools', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let registry: AiToolRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AiToolRegistry();
    // Fake bridge/device managers — the frida tools defensively check these
    // are wired before calling callFridaBridge (which is itself vi.mock'd).
    const fakeBridge = {} as any;
    const fakeDeviceManager = {
      markBusy: vi.fn(),
      markIdle: vi.fn(),
      getDeviceStatus: vi.fn().mockResolvedValue({ isOnline: true }),
      executeShellCommand: vi.fn().mockResolvedValue(''),
    } as any;
    registerAllTools(registry, db as any, { bridgeManager: fakeBridge, deviceManager: fakeDeviceManager });
    mockCallFridaBridge.mockReset();
  });

  // ── Context registration ──────────────────────────────────────

  it('registers tools for session-timeline context', () => {
    const tools = registry.getToolsForContext('session-timeline');
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_session_metadata');
    expect(names).toContain('query_session_traffic');
    expect(names).toContain('list_session_screenshots');
    expect(names).toContain('get_execution_log');
    expect(names).toContain('search_traffic');
    expect(names).toContain('get_request_detail');
  });

  it('registers tools for traffic context', () => {
    const tools = registry.getToolsForContext('traffic');
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_traffic');
    expect(names).toContain('get_request_detail');
  });

  it('registers tools for automations context', () => {
    const tools = registry.getToolsForContext('automations');
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_automations');
    expect(names).toContain('get_automation_code');
    expect(names).toContain('list_sessions');
  });

  it('registers tools for credentials context', () => {
    const tools = registry.getToolsForContext('credentials');
    const names = tools.map((t) => t.name);
    expect(names).toContain('search_credentials');
    expect(names).toContain('list_credentials');
  });

  it('registers tools for proxies context', () => {
    const tools = registry.getToolsForContext('proxies');
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_proxies');
  });

  it('registers tools for dashboard context', () => {
    const tools = registry.getToolsForContext('dashboard');
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_system_status');
    expect(names).toContain('list_automations');
    expect(names).toContain('list_sessions');
  });

  // ── query_session_traffic ─────────────────────────────────────

  describe('query_session_traffic', () => {
    it('returns traffic for a session', async () => {
      // Insert a session
      db.insert(schema.automationSessions).values({
        id: 1,
        automationId: null,
        deviceId: null,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      // Insert traffic entries
      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        responseStatus: 200,
        requestBody: 'req-body',
        responseBody: 'resp-body',
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/submit',
        responseStatus: 201,
        capturedAt: new Date(NOW * 1000),
      }).run();

      // Traffic for different session
      db.insert(schema.capturedTraffic).values({
        sessionId: null,
        requestMethod: 'GET',
        requestUrl: 'https://other.com/',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', { sessionId: 1 });
      expect(result).toHaveLength(2);
      expect(result.map((r: any) => r.requestUrl)).toContain('https://api.example.com/data');
      expect(result.map((r: any) => r.requestUrl)).toContain('https://api.example.com/submit');
    });

    it('truncates bodies to 2000 chars', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      const longBody = 'x'.repeat(3000);
      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/data',
        requestBody: longBody,
        responseBody: longBody,
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', { sessionId: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].requestBody.length).toBeLessThanOrEqual(2003 + 1); // 2000 + '...'
      expect(result[0].requestBody.endsWith('...')).toBe(true);
      expect(result[0].responseBody.endsWith('...')).toBe(true);
    });

    it('respects limit parameter', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      for (let i = 0; i < 5; i++) {
        db.insert(schema.capturedTraffic).values({
          sessionId: 1,
          requestMethod: 'GET',
          requestUrl: `https://api.example.com/${i}`,
          responseStatus: 200,
          capturedAt: new Date(NOW * 1000),
        }).run();
      }

      const result = await registry.executeTool('query_session_traffic', {
        sessionId: 1,
        limit: 2,
      });
      expect(result).toHaveLength(2);
    });

    it('filters by URL pattern (hostname) within session', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://cdn.other.com/image.png',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', {
        sessionId: 1,
        urlPattern: '%api.example.com%',
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/data');
    });

    it('filters by URL pattern (path) within session', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/v1/users',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/v1/login',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', {
        sessionId: 1,
        urlPattern: '%/v1/login%',
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/v1/login');
    });

    it('filters by method within session', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/submit',
        responseStatus: 201,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', {
        sessionId: 1,
        method: 'POST',
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/submit');
    });

    it('filters by status code within session', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/ok',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/not-found',
        responseStatus: 404,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', {
        sessionId: 1,
        statusCode: 404,
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/not-found');
    });

    it('combines multiple filters within session', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/login',
        responseStatus: 401,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/submit',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://cdn.example.com/image.png',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', {
        sessionId: 1,
        hostname: '%api.example.com%',
        method: 'POST',
        statusCode: 401,
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/login');
    });
  });

  // ── search_traffic ────────────────────────────────────────────

  describe('search_traffic', () => {
    beforeEach(() => {
      db.insert(schema.capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/users',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/login',
        responseStatus: 401,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://cdn.example.com/image.png',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();
    });

    it('filters by URL pattern', async () => {
      const result = await registry.executeTool('search_traffic', {
        urlPattern: '%api.example%',
      });
      expect(result).toHaveLength(2);
    });

    it('filters by method', async () => {
      const result = await registry.executeTool('search_traffic', { method: 'POST' });
      expect(result).toHaveLength(1);
      expect(result[0].requestMethod).toBe('POST');
    });

    it('filters by status code', async () => {
      const result = await registry.executeTool('search_traffic', { statusCode: 401 });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/login');
    });

    it('combines multiple filters', async () => {
      const result = await registry.executeTool('search_traffic', {
        urlPattern: '%api%',
        method: 'GET',
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/users');
    });

    it('returns summary fields only (no bodies)', async () => {
      const result = await registry.executeTool('search_traffic', {});
      expect(result).toHaveLength(3);
      const entry = result[0];
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('requestMethod');
      expect(entry).toHaveProperty('requestUrl');
      expect(entry).toHaveProperty('responseStatus');
      expect(entry).not.toHaveProperty('requestBody');
      expect(entry).not.toHaveProperty('responseBody');
    });

    it('filters by sessionId', async () => {
      // Add session-specific traffic
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/session-data',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      // Existing 3 entries have no sessionId; new one has sessionId=1
      const result = await registry.executeTool('search_traffic', { sessionId: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/session-data');
    });

    it('filters by hostname pattern', async () => {
      const result = await registry.executeTool('search_traffic', {
        hostname: '%cdn.example.com%',
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://cdn.example.com/image.png');
    });

    it('filters by path pattern', async () => {
      const result = await registry.executeTool('search_traffic', {
        path: '%/login%',
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/login');
    });

    it('combines sessionId with other filters', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/submit',
        responseStatus: 201,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('search_traffic', {
        sessionId: 1,
        method: 'POST',
      });
      expect(result).toHaveLength(1);
      expect(result[0].requestUrl).toBe('https://api.example.com/submit');
    });
  });

  // ── search_credentials ────────────────────────────────────────

  describe('search_credentials', () => {
    beforeEach(() => {
      db.insert(schema.credentials).values({
        appId: 'com.example.app',
        username: 'admin',
        password: 'super-secret-123',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.other.app',
        username: 'user@test.com',
        password: 'another-password',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();
    });

    it('masks passwords in results', async () => {
      const result = await registry.executeTool('search_credentials', { query: 'example' });
      expect(result).toHaveLength(1);
      expect(result[0].appId).toBe('com.example.app');
      expect(result[0].username).toBe('admin');
      expect(result[0].password).toBe('********');
    });

    it('searches by username', async () => {
      const result = await registry.executeTool('search_credentials', { query: 'test.com' });
      expect(result).toHaveLength(1);
      expect(result[0].username).toBe('user@test.com');
      expect(result[0].password).toBe('********');
    });

    it('returns empty array when nothing matches', async () => {
      const result = await registry.executeTool('search_credentials', { query: 'nonexistent' });
      expect(result).toEqual([]);
    });
  });

  // ── list_credentials ──────────────────────────────────────────

  describe('list_credentials', () => {
    it('masks all passwords', async () => {
      db.insert(schema.credentials).values({
        appId: 'com.app1',
        username: 'user1',
        password: 'password1',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.app2',
        username: 'user2',
        password: 'password2',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('list_credentials', {});
      expect(result).toHaveLength(2);
      for (const cred of result) {
        expect(cred.password).toBe('********');
      }
    });
  });

  // ── get_system_status ─────────────────────────────────────────

  describe('get_system_status', () => {
    it('returns correct counts', async () => {
      // Insert automations
      db.insert(schema.automations).values({
        name: 'Auto 1',
        code: 'code',
        passcode: 'pass',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();
      db.insert(schema.automations).values({
        name: 'Auto 2',
        code: 'code',
        passcode: 'pass',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      // Insert sessions
      db.insert(schema.automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      // Insert traffic
      db.insert(schema.capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://example.com',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();
      db.insert(schema.capturedTraffic).values({
        requestMethod: 'POST',
        requestUrl: 'https://example.com/api',
        responseStatus: 201,
        capturedAt: new Date(NOW * 1000),
      }).run();
      db.insert(schema.capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://example.com/data',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      // Insert proxies
      db.insert(schema.proxies).values({
        url: 'http://proxy1.com:8080',
        createdAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('get_system_status', {});
      expect(result).toEqual({
        automations: 2,
        sessions: 1,
        trafficEntries: 3,
        proxies: 1,
      });
    });

    it('returns zeros when database is empty', async () => {
      const result = await registry.executeTool('get_system_status', {});
      expect(result).toEqual({
        automations: 0,
        sessions: 0,
        trafficEntries: 0,
        proxies: 0,
      });
    });
  });

  // ── get_session_metadata ──────────────────────────────────────

  describe('get_session_metadata', () => {
    it('returns session data', async () => {
      db.insert(schema.automationSessions).values({
        id: 42,
        status: 'success',
        triggerType: 'schedule',
        logs: '[]',
        startedAt: new Date(NOW * 1000),
        completedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('get_session_metadata', { sessionId: 42 });
      expect(result.id).toBe(42);
      expect(result.status).toBe('success');
      expect(result.triggerType).toBe('schedule');
    });

    it('returns error for nonexistent session', async () => {
      const result = await registry.executeTool('get_session_metadata', { sessionId: 999 });
      expect(result).toEqual({ error: 'Session not found' });
    });
  });

  // ── get_execution_log ─────────────────────────────────────────

  describe('get_execution_log', () => {
    it('parses JSON logs', async () => {
      const logs = [{ type: 'info', message: 'started' }, { type: 'info', message: 'done' }];
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        logs: JSON.stringify(logs),
        startedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('get_execution_log', { sessionId: 1 });
      expect(result).toEqual(logs);
    });

    it('returns empty array for null logs', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        logs: null,
        startedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('get_execution_log', { sessionId: 1 });
      expect(result).toEqual([]);
    });
  });

  // ── list_automations ──────────────────────────────────────────

  describe('list_automations', () => {
    it('returns all automations with summary fields', async () => {
      db.insert(schema.automations).values({
        name: 'Login Flow',
        code: 'const x = 1;',
        passcode: 'pass',
        isRule: true,
        schedule: '{"cron":"0 * * * *"}',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('list_automations', {});
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Login Flow');
      expect(result[0]).toHaveProperty('enabled');
      expect(result[0]).toHaveProperty('isRule');
      expect(result[0]).toHaveProperty('schedule');
      // Should NOT include code or passcode
      expect(result[0]).not.toHaveProperty('code');
      expect(result[0]).not.toHaveProperty('passcode');
    });
  });

  // ── get_automation_code ───────────────────────────────────────

  describe('get_automation_code', () => {
    it('returns automation source code', async () => {
      db.insert(schema.automations).values({
        name: 'My Script',
        code: 'console.log("hello");',
        passcode: 'pass',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      const rows = db.select().from(schema.automations).all();
      const result = await registry.executeTool('get_automation_code', { id: rows[0].id });
      expect(result.code).toBe('console.log("hello");');
      expect(result.name).toBe('My Script');
    });

    it('returns error for nonexistent automation', async () => {
      const result = await registry.executeTool('get_automation_code', { id: 999 });
      expect(result).toEqual({ error: 'Automation not found' });
    });
  });

  // ── list_proxies ──────────────────────────────────────────────

  describe('list_proxies', () => {
    it('masks proxy credentials', async () => {
      db.insert(schema.proxies).values({
        url: 'http://user:secret@proxy.com:8080',
        username: 'user',
        password: 'secret',
        createdAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('list_proxies', {});
      expect(result).toHaveLength(1);
      expect(result[0].password).toBe('********');
      expect(result[0].url).not.toContain('secret');
    });
  });

  // ── list_session_screenshots ──────────────────────────────────

  describe('list_session_screenshots', () => {
    it('returns screenshots without blobs', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.screenshots).values({
        sessionId: 1,
        filename: 'shot1.png',
        name: 'Login screen',
        domSnapshot: '<div>big snapshot data</div>',
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('list_session_screenshots', { sessionId: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('shot1.png');
      expect(result[0].name).toBe('Login screen');
      expect(result[0]).not.toHaveProperty('domSnapshot');
    });

    it('returns empty array for session with no screenshots', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('list_session_screenshots', { sessionId: 1 });
      expect(result).toEqual([]);
    });
  });

  // ── Missing / empty data ──────────────────────────────────────

  describe('missing/empty data edge cases', () => {
    it('query_session_traffic should return empty array for session with no traffic', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', { sessionId: 1 });
      expect(result).toEqual([]);
    });

    it('get_execution_log should return empty array for session with no logs', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        logs: null,
        startedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('get_execution_log', { sessionId: 1 });
      expect(result).toEqual([]);
    });

    it('get_execution_log should handle malformed JSON in logs', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        logs: '{invalid json}',
        startedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('get_execution_log', { sessionId: 1 });
      expect(result).toBe('{invalid json}');
    });

    it('get_session_metadata should return error for non-existent session', async () => {
      const result = await registry.executeTool('get_session_metadata', { sessionId: 999 });
      expect(result).toEqual({ error: 'Session not found' });
    });

    it('get_automation_code should return error for non-existent automation', async () => {
      const result = await registry.executeTool('get_automation_code', { id: 999 });
      expect(result).toEqual({ error: 'Automation not found' });
    });
  });

  // ── Truncation ────────────────────────────────────────────────

  describe('truncation behavior', () => {
    it('query_session_traffic should truncate large request bodies', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      const largeBody = 'a'.repeat(5000);
      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/upload',
        requestBody: largeBody,
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', { sessionId: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].requestBody.length).toBe(2003); // 2000 + '...'
      expect(result[0].requestBody.endsWith('...')).toBe(true);
      expect(result[0].requestBody.slice(0, 2000)).toBe('a'.repeat(2000));
    });

    it('query_session_traffic should not truncate null bodies', async () => {
      db.insert(schema.automationSessions).values({
        id: 1,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        requestBody: null,
        responseBody: null,
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('query_session_traffic', { sessionId: 1 });
      expect(result).toHaveLength(1);
      expect(result[0].requestBody).toBeNull();
      expect(result[0].responseBody).toBeNull();
    });

    it('get_request_detail should truncate to 5000 chars', async () => {
      const hugeBody = 'z'.repeat(10000);
      db.insert(schema.capturedTraffic).values({
        id: 1,
        requestMethod: 'POST',
        requestUrl: 'https://api.example.com/big',
        requestBody: hugeBody,
        responseBody: hugeBody,
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('get_request_detail', { id: 1 });
      expect(result.requestBody.length).toBe(2503); // 2500 + '...'
      expect(result.requestBody.endsWith('...')).toBe(true);
      expect(result.responseBody.length).toBe(2503);
      expect(result.responseBody.endsWith('...')).toBe(true);
    });
  });

  // ── Security ──────────────────────────────────────────────────

  describe('security - credential masking', () => {
    it('search_credentials should mask all passwords', async () => {
      db.insert(schema.credentials).values({
        appId: 'com.app.one',
        username: 'admin1',
        password: 'secret-password-1',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.app.two',
        username: 'admin2',
        password: 'different-secret-2',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.app.three',
        username: 'admin3',
        password: 'yet-another-pass',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('search_credentials', { query: 'app' });
      expect(result).toHaveLength(3);
      for (const cred of result) {
        expect(cred.password).toBe('********');
      }
    });

    it('list_credentials should mask all passwords', async () => {
      db.insert(schema.credentials).values({
        appId: 'com.first',
        username: 'user-a',
        password: 'pw-alpha',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.second',
        username: 'user-b',
        password: 'pw-beta',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.third',
        username: 'user-c',
        password: 'pw-gamma',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('list_credentials', {});
      expect(result).toHaveLength(3);
      for (const cred of result) {
        expect(cred.password).toBe('********');
        // Ensure original passwords never leak
        expect(JSON.stringify(cred)).not.toContain('pw-alpha');
        expect(JSON.stringify(cred)).not.toContain('pw-beta');
        expect(JSON.stringify(cred)).not.toContain('pw-gamma');
      }
    });

    it('list_proxies should mask proxy password', async () => {
      db.insert(schema.proxies).values({
        url: 'http://myuser:mysecret@proxy.example.com:8080',
        username: 'myuser',
        password: 'mysecret',
        createdAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('list_proxies', {});
      expect(result).toHaveLength(1);
      expect(result[0].password).toBe('********');
      expect(result[0].url).not.toContain('mysecret');
    });

    it('search_credentials should handle SQL-like characters safely', async () => {
      db.insert(schema.credentials).values({
        appId: 'com.admin.app',
        username: 'admin%user',
        password: 'safe-pass',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.credentials).values({
        appId: 'com.normal.app',
        username: 'normaluser',
        password: 'another-pass',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      // The search wraps query in %...%, so 'admin%' becomes '%admin%%'
      // With parameterized LIKE this should still work without SQL injection
      const result = await registry.executeTool('search_credentials', { query: 'admin%' });
      // Should match both because SQLite LIKE with '%admin%%' matches 'com.admin.app' (appId)
      // and 'admin%user' (username)
      expect(result.length).toBeGreaterThanOrEqual(1);
      for (const cred of result) {
        expect(cred.password).toBe('********');
      }
    });
  });

  // ── Edge cases ────────────────────────────────────────────────

  describe('edge cases', () => {
    it('search_traffic with no filters should return recent traffic', async () => {
      db.insert(schema.capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://example.com/a',
        responseStatus: 200,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        requestMethod: 'POST',
        requestUrl: 'https://example.com/b',
        responseStatus: 201,
        capturedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.capturedTraffic).values({
        requestMethod: 'DELETE',
        requestUrl: 'https://example.com/c',
        responseStatus: 204,
        capturedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('search_traffic', {});
      expect(result).toHaveLength(3);
    });

    it('list_automations should return code-less summary', async () => {
      db.insert(schema.automations).values({
        name: 'Test Automation',
        code: 'const secret = "do-not-expose";',
        passcode: 'hidden-passcode',
        isRule: false,
        enabled: true,
        schedule: null,
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      const result = await registry.executeTool('list_automations', {});
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Test Automation');
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('enabled');
      expect(result[0]).toHaveProperty('isRule');
      expect(result[0]).toHaveProperty('schedule');
      expect(result[0]).toHaveProperty('createdAt');
      // code and passcode must NOT be in the summary
      expect(result[0]).not.toHaveProperty('code');
      expect(result[0]).not.toHaveProperty('passcode');
    });

    it('get_system_status should return all zeros for empty database', async () => {
      const result = await registry.executeTool('get_system_status', {});
      expect(result).toEqual({
        automations: 0,
        sessions: 0,
        trafficEntries: 0,
        proxies: 0,
      });
    });

    it('list_sessions should filter by automationId', async () => {
      // Create two automations
      db.insert(schema.automations).values({
        id: 10,
        name: 'Auto A',
        code: 'code-a',
        passcode: 'pass',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.automations).values({
        id: 20,
        name: 'Auto B',
        code: 'code-b',
        passcode: 'pass',
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      }).run();

      // Create sessions for automation 10
      db.insert(schema.automationSessions).values({
        automationId: 10,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.automationSessions).values({
        automationId: 10,
        status: 'failed',
        triggerType: 'schedule',
        startedAt: new Date(NOW * 1000),
      }).run();

      // Create sessions for automation 20
      db.insert(schema.automationSessions).values({
        automationId: 20,
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(NOW * 1000),
      }).run();

      // Filter by automationId 10
      const result = await registry.executeTool('list_sessions', { automationId: 10 });
      expect(result).toHaveLength(2);
      for (const session of result) {
        expect(session.automationId).toBe(10);
      }

      // Filter by automationId 20
      const result20 = await registry.executeTool('list_sessions', { automationId: 20 });
      expect(result20).toHaveLength(1);
      expect(result20[0].automationId).toBe(20);
    });
  });

  // ── Context registration completeness ─────────────────────────

  describe('context registration', () => {
    it('should register tools for all expected contexts', () => {
      const contexts = registry.listContexts();
      expect(contexts).toContain('session-timeline');
      expect(contexts).toContain('traffic');
      expect(contexts).toContain('automations');
      expect(contexts).toContain('credentials');
      expect(contexts).toContain('proxies');
      expect(contexts).toContain('dashboard');
    });

    it('search_traffic tool should be in both traffic and session-timeline contexts', () => {
      const trafficTools = registry.getToolsForContext('traffic');
      const sessionTools = registry.getToolsForContext('session-timeline');

      const trafficNames = trafficTools.map((t) => t.name);
      const sessionNames = sessionTools.map((t) => t.name);

      expect(trafficNames).toContain('search_traffic');
      expect(sessionNames).toContain('search_traffic');

      expect(trafficNames).toContain('get_request_detail');
      expect(sessionNames).toContain('get_request_detail');
    });
  });

  // ── Analysis notes tools ────────────────────────────────────────

  describe('read_analysis_notes / write_analysis_notes', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-ai-notes-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      // Insert a tracked app and version
      db.insert(schema.trackedApps).values({
        packageName: 'com.test.notes',
        appName: 'Notes Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('registers notes tools for apk-analysis context', () => {
      const tools = registry.getToolsForContext('apk-analysis');
      const names = tools.map((t) => t.name);
      expect(names).toContain('read_analysis_notes');
      expect(names).toContain('write_analysis_notes');
    });

    it('read_analysis_notes returns empty string when no file exists', async () => {
      const result = await registry.executeTool('read_analysis_notes', { versionId: 1 });
      expect(result).toEqual({ notes: '' });
    });

    it('read_analysis_notes returns error for nonexistent version', async () => {
      const result = await registry.executeTool('read_analysis_notes', { versionId: 999 });
      expect(result).toEqual({ error: 'APK version not found' });
    });

    it('write_analysis_notes persists the content in apk_notes', async () => {
      mockBroadcastToAll.mockClear();
      const result = await registry.executeTool('write_analysis_notes', {
        versionId: 1,
        notes: '# Test Notes\n\nSome content.',
      });
      expect(result).toEqual({ ok: true });

      const row = db.select().from(schema.apkNotes)
        .where(eq(schema.apkNotes.versionId, 1)).all()[0];
      expect(row?.content).toBe('# Test Notes\n\nSome content.');
    });

    it('write_analysis_notes broadcasts apk:notes-updated', async () => {
      mockBroadcastToAll.mockClear();
      await registry.executeTool('write_analysis_notes', {
        versionId: 1,
        notes: 'broadcast test',
      });
      expect(mockBroadcastToAll).toHaveBeenCalledWith({
        type: 'apk:notes-updated',
        versionId: 1,
        notes: 'broadcast test',
      });
    });

    it('write_analysis_notes returns error for nonexistent version', async () => {
      const result = await registry.executeTool('write_analysis_notes', {
        versionId: 999,
        notes: 'test',
      });
      expect(result).toEqual({ error: 'APK version not found' });
    });

    it('round-trip: write then read', async () => {
      const content = '# Analysis\n\n- Finding 1\n- Finding 2';
      await registry.executeTool('write_analysis_notes', { versionId: 1, notes: content });
      const result = await registry.executeTool('read_analysis_notes', { versionId: 1 });
      expect(result).toEqual({ notes: content });
    });

    it('write_analysis_notes overwrites existing content', async () => {
      await registry.executeTool('write_analysis_notes', { versionId: 1, notes: 'First' });
      await registry.executeTool('write_analysis_notes', { versionId: 1, notes: 'Second' });
      const result = await registry.executeTool('read_analysis_notes', { versionId: 1 });
      expect(result).toEqual({ notes: 'Second' });
    });
  });

  // ── patch_analysis_section ──────────────────────────────────────

  describe('patch_analysis_section', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-patch-notes-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      db.insert(schema.trackedApps).values({
        packageName: 'com.test.patch',
        appName: 'Patch Test',
        createdAt: new Date(NOW * 1000),
      }).run();
      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 100,
        versionName: '1.0.0',
        filename: '100_1.0.0.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      mockBroadcastToAll.mockClear();
    });

    it('creates a new section when notes are empty', async () => {
      const result = await registry.executeTool('patch_analysis_section', {
        versionId: 1,
        section: 'Overview',
        content: 'This is the overview.',
      });
      expect(result).toEqual({ ok: true, sectionCount: 1 });

      const read = await registry.executeTool('read_analysis_notes', { versionId: 1 });
      expect((read as any).notes).toContain('## Overview');
      expect((read as any).notes).toContain('This is the overview.');
    });

    it('appends a new section when notes already exist', async () => {
      await registry.executeTool('write_analysis_notes', { versionId: 1, notes: '## Overview\n\nFirst section.\n' });

      const result = await registry.executeTool('patch_analysis_section', {
        versionId: 1,
        section: 'API Endpoints',
        content: 'Endpoint details here.',
      });
      expect(result).toEqual({ ok: true, sectionCount: 2 });

      const read = await registry.executeTool('read_analysis_notes', { versionId: 1 });
      const notes = (read as any).notes as string;
      expect(notes).toContain('## Overview');
      expect(notes).toContain('## API Endpoints');
      expect(notes).toContain('Endpoint details here.');
      // Overview should come before API Endpoints
      expect(notes.indexOf('## Overview')).toBeLessThan(notes.indexOf('## API Endpoints'));
    });

    it('replaces an existing section in place', async () => {
      await registry.executeTool('write_analysis_notes', {
        versionId: 1,
        notes: '## Overview\n\nOld overview.\n\n## Maps\n\nMap info.\n',
      });

      const result = await registry.executeTool('patch_analysis_section', {
        versionId: 1,
        section: 'Overview',
        content: 'Updated overview with more detail.',
      });
      expect(result).toEqual({ ok: true, sectionCount: 2 });

      const read = await registry.executeTool('read_analysis_notes', { versionId: 1 });
      const notes = (read as any).notes as string;
      expect(notes).not.toContain('Old overview.');
      expect(notes).toContain('Updated overview with more detail.');
      expect(notes).toContain('## Maps');
      // Overview should still come before Maps
      expect(notes.indexOf('## Overview')).toBeLessThan(notes.indexOf('## Maps'));
    });

    it('preserves other sections when replacing a middle section', async () => {
      const initial = '## Overview\n\nFirst.\n\n## API\n\nOld API.\n\n## Maps\n\nMap data.\n';
      await registry.executeTool('write_analysis_notes', { versionId: 1, notes: initial });

      await registry.executeTool('patch_analysis_section', {
        versionId: 1,
        section: 'API',
        content: 'New API details.',
      });

      const read = await registry.executeTool('read_analysis_notes', { versionId: 1 });
      const notes = (read as any).notes as string;
      expect(notes).toContain('## Overview');
      expect(notes).toContain('First.');
      expect(notes).toContain('New API details.');
      expect(notes).not.toContain('Old API.');
      expect(notes).toContain('## Maps');
      expect(notes).toContain('Map data.');
    });

    it('broadcasts apk:notes-updated', async () => {
      mockBroadcastToAll.mockClear();
      await registry.executeTool('patch_analysis_section', {
        versionId: 1,
        section: 'Overview',
        content: 'Content here.',
      });
      expect(mockBroadcastToAll).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'apk:notes-updated', versionId: 1 }),
      );
    });

    it('returns error for nonexistent version', async () => {
      const result = await registry.executeTool('patch_analysis_section', {
        versionId: 999,
        section: 'Overview',
        content: 'Content.',
      });
      expect(result).toEqual({ error: 'APK version not found' });
    });

    it('is registered in the apk-analysis context', async () => {
      const tools = registry.getToolsForContext('apk-analysis');
      const names = tools.map((t) => t.name);
      expect(names).toContain('patch_analysis_section');
    });
  });

  // ── list_apk_assets ─────────────────────────────────────────────

  describe('list_apk_assets', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-apk-assets-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      // Insert app + version
      db.insert(schema.trackedApps).values({
        packageName: 'com.test.assets',
        appName: 'Assets Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 1,
        versionName: '1.0',
        filename: 'test.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      // Create a test APK zip file
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('AndroidManifest.xml', Buffer.from('<manifest/>'));
      zip.addFile('classes.dex', Buffer.from('dex'));
      zip.addFile('assets/config.json', Buffer.from('{"key":"val"}'));
      zip.addFile('assets/tiles/map.mbtiles', Buffer.from('fake-mbtiles'));
      zip.addFile('assets/tiles/overlay.mbtiles', Buffer.from('fake2'));
      zip.addFile('res/layout/main.xml', Buffer.from('<LinearLayout/>'));
      zip.addFile('lib/arm64-v8a/libnative.so', Buffer.from('elf'));

      const apkDir = path.join(tmpDir, 'data', 'apks', 'com.test.assets');
      fs.mkdirSync(apkDir, { recursive: true });
      zip.writeZip(path.join(apkDir, 'test.apk'));
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('registers list_apk_assets for apk-analysis context', () => {
      const tools = registry.getToolsForContext('apk-analysis');
      expect(tools.map(t => t.name)).toContain('list_apk_assets');
    });

    it('lists root-level entries non-recursively', async () => {
      const result = await registry.executeTool('list_apk_assets', { versionId: 1 });
      expect(result.totalEntries).toBeGreaterThan(0);
      // Should contain top-level files and directories
      const names = result.entries.map((e: any) => e.name);
      expect(names).toContain('AndroidManifest.xml');
      expect(names).toContain('classes.dex');
      // Should collapse assets/ into a directory entry
      expect(names.some((n: string) => n === 'assets/')).toBe(true);
      expect(names.some((n: string) => n === 'res/')).toBe(true);
      expect(names.some((n: string) => n === 'lib/')).toBe(true);
    });

    it('lists entries with prefix filter', async () => {
      const result = await registry.executeTool('list_apk_assets', { versionId: 1, path: 'assets/' });
      const names = result.entries.map((e: any) => e.name);
      expect(names).toContain('assets/config.json');
      expect(names.some((n: string) => n === 'assets/tiles/')).toBe(true);
      // Should NOT contain non-assets entries
      expect(names.some((n: string) => n.startsWith('res/'))).toBe(false);
    });

    it('lists entries recursively', async () => {
      const result = await registry.executeTool('list_apk_assets', { versionId: 1, path: 'assets/', recursive: true });
      const names = result.entries.map((e: any) => e.name);
      expect(names).toContain('assets/config.json');
      expect(names).toContain('assets/tiles/map.mbtiles');
      expect(names).toContain('assets/tiles/overlay.mbtiles');
    });

    it('returns error for nonexistent version', async () => {
      const result = await registry.executeTool('list_apk_assets', { versionId: 999 });
      expect(result).toEqual({ error: 'APK file not found for this version' });
    });

    it('handles prefix with no trailing slash', async () => {
      const result = await registry.executeTool('list_apk_assets', { versionId: 1, path: 'assets' });
      const names = result.entries.map((e: any) => e.name);
      expect(names).toContain('assets/config.json');
    });
  });

  // ── get_mbtiles_info ────────────────────────────────────────────

  describe('get_mbtiles_info', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-mbtiles-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      // Insert app + version
      db.insert(schema.trackedApps).values({
        packageName: 'com.test.mbtiles',
        appName: 'MBTiles Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 1,
        versionName: '1.0',
        filename: 'test.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      // Create a real mbtiles file (it's just SQLite)
      const BetterSqlite = require('better-sqlite3');
      const mbtilesPath = path.join(tmpDir, 'temp.mbtiles');
      const mbDb = new BetterSqlite(mbtilesPath);
      mbDb.exec(`
        CREATE TABLE metadata (name TEXT, value TEXT);
        INSERT INTO metadata VALUES ('name', 'Test Map');
        INSERT INTO metadata VALUES ('format', 'png');
        INSERT INTO metadata VALUES ('bounds', '-180,-85,180,85');
        INSERT INTO metadata VALUES ('minzoom', '0');
        INSERT INTO metadata VALUES ('maxzoom', '5');
        CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
      `);
      // Insert some tiles at different zoom levels
      for (let z = 0; z <= 3; z++) {
        for (let i = 0; i < (z + 1) * 2; i++) {
          mbDb.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)').run(z, i, 0, Buffer.from('tile'));
        }
      }
      mbDb.close();

      // Create APK with the mbtiles inside
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      zip.addFile('AndroidManifest.xml', Buffer.from('<manifest/>'));
      zip.addFile('assets/map.mbtiles', fs.readFileSync(mbtilesPath));

      const apkDir = path.join(tmpDir, 'data', 'apks', 'com.test.mbtiles');
      fs.mkdirSync(apkDir, { recursive: true });
      zip.writeZip(path.join(apkDir, 'test.apk'));

      // Clean up temp mbtiles
      fs.unlinkSync(mbtilesPath);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('registers get_mbtiles_info for apk-analysis context', () => {
      const tools = registry.getToolsForContext('apk-analysis');
      expect(tools.map(t => t.name)).toContain('get_mbtiles_info');
    });

    it('reads metadata and tile distribution from embedded mbtiles', async () => {
      const result = await registry.executeTool('get_mbtiles_info', {
        versionId: 1,
        path: 'assets/map.mbtiles',
      });
      expect(result.metadata.name).toBe('Test Map');
      expect(result.metadata.format).toBe('png');
      expect(result.metadata.bounds).toBe('-180,-85,180,85');
      expect(result.tileCount).toBe(2 + 4 + 6 + 8); // zoom 0-3
      expect(result.zoomDistribution[0]).toBe(2);
      expect(result.zoomDistribution[1]).toBe(4);
      expect(result.zoomDistribution[2]).toBe(6);
      expect(result.zoomDistribution[3]).toBe(8);
    });

    it('returns error for nonexistent path in APK', async () => {
      const result = await registry.executeTool('get_mbtiles_info', {
        versionId: 1,
        path: 'assets/nonexistent.mbtiles',
      });
      expect(result).toEqual({ error: 'Entry not found in APK: assets/nonexistent.mbtiles' });
    });

    it('returns error for nonexistent version', async () => {
      const result = await registry.executeTool('get_mbtiles_info', {
        versionId: 999,
        path: 'assets/map.mbtiles',
      });
      expect(result).toEqual({ error: 'APK file not found for this version' });
    });
  });

  // ── get_apk_file offset/limit pagination ────────────────────────

  describe('get_apk_file pagination', () => {
    let tmpDir: string;
    let originalCwd: string;

    function createSourceDb(dir: string, files: { path: string; content: string; source: string; language: string }[]) {
      const BetterSqlite = require('better-sqlite3');
      const zlib = require('zlib');
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, 'source.db');
      const sdb = new BetterSqlite(dbPath);
      sdb.exec(`
        CREATE TABLE manifest (key TEXT, value TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, source TEXT, content BLOB, language TEXT, size INTEGER);
        CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER, rule_id TEXT, severity TEXT, title TEXT, description TEXT, line_number INTEGER, matched_text TEXT, category TEXT);
      `);
      for (const f of files) {
        const compressed = zlib.deflateSync(Buffer.from(f.content));
        sdb.prepare('INSERT INTO files (path, source, content, language, size) VALUES (?, ?, ?, ?, ?)').run(f.path, f.source, compressed, f.language, f.content.length);
      }
      sdb.close();
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-apk-file-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      db.insert(schema.trackedApps).values({
        packageName: 'com.test.file',
        appName: 'File Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 1,
        versionName: '1.0',
        filename: 'test.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      // Create source.db with a multi-line file
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: content here`);
      createSourceDb(
        path.join(tmpDir, 'data/apks/com.test.file/analysis/1'),
        [{ path: 'com/test/Main.java', content: lines.join('\n'), source: 'jadx', language: 'java' }],
      );
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('returns paginated content with startLine and maxLines', async () => {
      const result = await registry.executeTool('get_apk_file', {
        versionId: 1,
        filePath: 'com/test/Main.java',
        startLine: 10,
        maxLines: 5,
      });
      expect(result.startLine).toBe(10);
      expect(result.endLine).toBe(14);
      expect(result.totalLines).toBe(50);
      expect(result.content).toContain('Line 10:');
      expect(result.content).toContain('Line 14:');
      expect(result.content).not.toContain('Line 9:');
      expect(result.content).not.toContain('Line 15:');
    });

    it('returns full content (truncated) without pagination params', async () => {
      const result = await registry.executeTool('get_apk_file', {
        versionId: 1,
        filePath: 'com/test/Main.java',
      });
      // No pagination fields
      expect(result).not.toHaveProperty('totalLines');
      expect(result).not.toHaveProperty('startLine');
      expect(result).not.toHaveProperty('endLine');
      expect(result.content).toContain('Line 1:');
      expect(result.language).toBe('java');
    });

    it('handles startLine beyond file length', async () => {
      const result = await registry.executeTool('get_apk_file', {
        versionId: 1,
        filePath: 'com/test/Main.java',
        startLine: 100,
        maxLines: 5,
      });
      expect(result.totalLines).toBe(50);
      expect(result.content).toBe('');
    });

    it('clamps maxLines to available lines', async () => {
      const result = await registry.executeTool('get_apk_file', {
        versionId: 1,
        filePath: 'com/test/Main.java',
        startLine: 48,
        maxLines: 10,
      });
      expect(result.startLine).toBe(48);
      expect(result.endLine).toBe(50);
      // Only 3 lines returned
      const lineCount = result.content.split('\n').length;
      expect(lineCount).toBe(3);
    });
  });

  // ── search_apk_code path filters ────────────────────────────────

  describe('search_apk_code path filters', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-code-filter-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      db.insert(schema.trackedApps).values({
        packageName: 'com.test.code',
        appName: 'Code Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 1,
        versionName: '1.0',
        filename: 'test.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      // Create source.db with files in different paths
      const zlib = require('zlib');
      const BetterSqlite = require('better-sqlite3');
      const dir = path.join(tmpDir, 'data/apks/com.test.code/analysis/1');
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, 'source.db');
      const sdb = new BetterSqlite(dbPath);
      sdb.exec(`
        CREATE TABLE manifest (key TEXT, value TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, source TEXT, content BLOB, language TEXT, size INTEGER);
        CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER, rule_id TEXT, severity TEXT, title TEXT, description TEXT, line_number INTEGER, matched_text TEXT, category TEXT);
      `);

      const addFile = (p: string, content: string) => {
        const compressed = zlib.deflateSync(Buffer.from(content));
        sdb.prepare('INSERT INTO files (path, source, content, language, size) VALUES (?, ?, ?, ?, ?)').run(p, 'jadx', compressed, 'java', content.length);
      };

      addFile('com/disney/app/Main.java', 'API_URL = "https://api.disney.com/v1"');
      addFile('com/google/common/Utils.java', 'API_URL = "https://google.com/api"');
      addFile('androidx/core/Widget.java', 'API_URL = "https://android.com/sdk"');
      addFile('com/disney/network/Client.java', 'API_URL = "https://cdn.disney.com/img"');
      sdb.close();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('filters with includePaths', async () => {
      const result = await registry.executeTool('search_apk_code', {
        versionId: 1,
        query: 'API_URL',
        includePaths: ['com/disney'],
      });
      expect(result.results).toHaveLength(2);
      expect(result.results.every((r: any) => r.file.includes('com/disney'))).toBe(true);
    });

    it('filters with excludePaths', async () => {
      const result = await registry.executeTool('search_apk_code', {
        versionId: 1,
        query: 'API_URL',
        excludePaths: ['androidx', 'com/google'],
      });
      expect(result.results).toHaveLength(2);
      expect(result.results.every((r: any) => r.file.includes('com/disney'))).toBe(true);
    });

    it('combines includePaths and excludePaths', async () => {
      const result = await registry.executeTool('search_apk_code', {
        versionId: 1,
        query: 'API_URL',
        includePaths: ['com/disney', 'com/google'],
        excludePaths: ['com/google'],
      });
      expect(result.results).toHaveLength(2);
      expect(result.results.every((r: any) => r.file.includes('com/disney'))).toBe(true);
    });

    it('works without path filters (backward compat)', async () => {
      const result = await registry.executeTool('search_apk_code', {
        versionId: 1,
        query: 'API_URL',
      });
      expect(result.results).toHaveLength(4);
    });
  });

  // ── search_apk_findings offset ──────────────────────────────────

  describe('search_apk_findings offset', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-findings-offset-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      db.insert(schema.trackedApps).values({
        packageName: 'com.test.findings',
        appName: 'Findings Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 1,
        versionName: '1.0',
        filename: 'test.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      // Create source.db with findings
      const BetterSqlite = require('better-sqlite3');
      const dir = path.join(tmpDir, 'data/apks/com.test.findings/analysis/1');
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, 'source.db');
      const sdb = new BetterSqlite(dbPath);
      sdb.exec(`
        CREATE TABLE manifest (key TEXT, value TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, source TEXT, content BLOB, language TEXT, size INTEGER);
        CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER, rule_id TEXT, severity TEXT, title TEXT, description TEXT, line_number INTEGER, matched_text TEXT, category TEXT);
      `);

      // Insert 10 findings
      for (let i = 0; i < 10; i++) {
        sdb.prepare('INSERT INTO findings (rule_id, severity, title, description, line_number, matched_text, category) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          `rule_${i}`, 'medium', `Finding ${i}`, `Description ${i}`, i + 1, `match_${i}`, 'network',
        );
      }
      sdb.close();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('returns total count and results with offset', async () => {
      const result = await registry.executeTool('search_apk_findings', {
        versionId: 1,
        limit: 3,
        offset: 0,
      });
      expect(result.total).toBe(10);
      expect(result.results).toHaveLength(3);
      expect(result.offset).toBe(0);
      expect(result.limited).toBe(true);
    });

    it('paginates with offset', async () => {
      const page1 = await registry.executeTool('search_apk_findings', {
        versionId: 1,
        limit: 3,
        offset: 0,
      });
      const page2 = await registry.executeTool('search_apk_findings', {
        versionId: 1,
        limit: 3,
        offset: 3,
      });
      // Different results on each page
      const ids1 = page1.results.map((r: any) => r.id);
      const ids2 = page2.results.map((r: any) => r.id);
      expect(ids1).not.toEqual(ids2);
      expect(page2.offset).toBe(3);
    });

    it('limited is false on last page', async () => {
      const result = await registry.executeTool('search_apk_findings', {
        versionId: 1,
        limit: 50,
        offset: 0,
      });
      expect(result.limited).toBe(false);
      expect(result.results).toHaveLength(10);
    });
  });

  // ── get_apk_strings filtering ───────────────────────────────────

  describe('get_apk_strings filtering', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-strings-filter-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      db.insert(schema.trackedApps).values({
        packageName: 'com.test.strings',
        appName: 'Strings Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 1,
        versionName: '1.0',
        filename: 'test.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      // Create source.db with URL findings
      const BetterSqlite = require('better-sqlite3');
      const dir = path.join(tmpDir, 'data/apks/com.test.strings/analysis/1');
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, 'source.db');
      const sdb = new BetterSqlite(dbPath);
      sdb.exec(`
        CREATE TABLE manifest (key TEXT, value TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, source TEXT, content BLOB, language TEXT, size INTEGER);
        CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER, rule_id TEXT, severity TEXT, title TEXT, description TEXT, line_number INTEGER, matched_text TEXT, category TEXT);
      `);

      // URL findings
      sdb.prepare('INSERT INTO findings (rule_id, severity, title, matched_text, category) VALUES (?, ?, ?, ?, ?)').run('url_1', 'info', 'URL', 'https://api.disney.com/v1', 'url');
      sdb.prepare('INSERT INTO findings (rule_id, severity, title, matched_text, category) VALUES (?, ?, ?, ?, ?)').run('url_2', 'info', 'URL', 'https://cdn.disney.com/img', 'network');
      sdb.prepare('INSERT INTO findings (rule_id, severity, title, matched_text, category) VALUES (?, ?, ?, ?, ?)').run('url_3', 'info', 'URL', 'https://w3.org/TR/html', 'url');
      sdb.prepare('INSERT INTO findings (rule_id, severity, title, matched_text, category) VALUES (?, ?, ?, ?, ?)').run('url_4', 'info', 'URL', 'https://apache.org/licenses/LICENSE-2.0', 'url');
      sdb.prepare('INSERT INTO findings (rule_id, severity, title, matched_text, category) VALUES (?, ?, ?, ?, ?)').run('url_5', 'info', 'URL', 'https://some-other-api.com/data', 'network');
      // Secret finding
      sdb.prepare('INSERT INTO findings (rule_id, severity, title, matched_text, category) VALUES (?, ?, ?, ?, ?)').run('secret_1', 'high', 'Secret', 'AKIA1234567890', 'secret');
      sdb.close();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('filters URLs by domainFilter', async () => {
      const result = await registry.executeTool('get_apk_strings', {
        versionId: 1,
        domainFilter: 'disney',
      });
      expect(result.urls).toHaveLength(2);
      expect(result.urls.every((u: any) => u.url.includes('disney'))).toBe(true);
      // secrets not affected by domainFilter
      expect(result.secrets).toHaveLength(1);
    });

    it('excludes noise URLs when excludeNoise is true', async () => {
      const result = await registry.executeTool('get_apk_strings', {
        versionId: 1,
        excludeNoise: true,
      });
      // w3.org and apache.org should be filtered out
      expect(result.urls.some((u: any) => u.url.includes('w3.org'))).toBe(false);
      expect(result.urls.some((u: any) => u.url.includes('apache.org'))).toBe(false);
      // disney and some-other-api should remain
      expect(result.urls.some((u: any) => u.url.includes('disney'))).toBe(true);
      expect(result.urls.some((u: any) => u.url.includes('some-other-api'))).toBe(true);
    });

    it('combines domainFilter and excludeNoise', async () => {
      const result = await registry.executeTool('get_apk_strings', {
        versionId: 1,
        domainFilter: 'disney',
        excludeNoise: true,
      });
      expect(result.urls).toHaveLength(2);
    });

    it('excludes noise by default (no explicit excludeNoise param)', async () => {
      const result = await registry.executeTool('get_apk_strings', { versionId: 1 });
      // w3.org and apache.org filtered out by default
      expect(result.urls).toHaveLength(3);
      expect(result.urls.some((u: any) => u.url.includes('w3.org'))).toBe(false);
      expect(result.urls.some((u: any) => u.url.includes('apache.org'))).toBe(false);
      expect(result.secrets).toHaveLength(1);
    });

    it('returns all URLs when excludeNoise is explicitly false', async () => {
      const result = await registry.executeTool('get_apk_strings', { versionId: 1, excludeNoise: false });
      expect(result.urls).toHaveLength(5);
      expect(result.secrets).toHaveLength(1);
    });
  });

  // ── list_flutter_classes ────────────────────────────────────────

  describe('list_flutter_classes', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-flutter-classes-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      db.insert(schema.trackedApps).values({
        packageName: 'com.test.flutter',
        appName: 'Flutter Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 1,
        versionName: '1.0',
        filename: 'test.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      // Create source.db with flutter-dump files
      const zlib = require('zlib');
      const BetterSqlite = require('better-sqlite3');
      const dir = path.join(tmpDir, 'data/apks/com.test.flutter/analysis/1');
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, 'source.db');
      const sdb = new BetterSqlite(dbPath);
      sdb.exec(`
        CREATE TABLE manifest (key TEXT, value TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, source TEXT, content BLOB, language TEXT, size INTEGER);
        CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER, rule_id TEXT, severity TEXT, title TEXT, description TEXT, line_number INTEGER, matched_text TEXT, category TEXT);
      `);

      const flutterDump = `
class MyApp {
  static Widget build() {
  }
}

abstract class BaseService {
  void init();
}

class ApiClient {
  String getUrl(String path) {
  }
  static ApiClient getInstance() {
  }
}
`.trim();

      const compressed = zlib.deflateSync(Buffer.from(flutterDump));
      sdb.prepare('INSERT INTO files (path, source, content, language, size) VALUES (?, ?, ?, ?, ?)').run('lib/main.dart', 'flutter-dump', compressed, 'dart', flutterDump.length);
      sdb.close();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('registers list_flutter_classes for apk-analysis context', () => {
      const tools = registry.getToolsForContext('apk-analysis');
      expect(tools.map(t => t.name)).toContain('list_flutter_classes');
    });

    it('extracts class names from flutter-dump files', async () => {
      const result = await registry.executeTool('list_flutter_classes', { versionId: 1 });
      expect(result.classes).toHaveLength(3);
      const names = result.classes.map((c: any) => c.name);
      expect(names).toContain('MyApp');
      expect(names).toContain('BaseService');
      expect(names).toContain('ApiClient');
    });

    it('returns error when no flutter-dump data exists', async () => {
      // Create a version with source.db but no flutter-dump
      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 2,
        versionName: '2.0',
        filename: 'test2.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      const BetterSqlite = require('better-sqlite3');
      const dir = path.join(tmpDir, 'data/apks/com.test.flutter/analysis/2');
      fs.mkdirSync(dir, { recursive: true });
      const sdb = new BetterSqlite(path.join(dir, 'source.db'));
      sdb.exec(`
        CREATE TABLE manifest (key TEXT, value TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, source TEXT, content BLOB, language TEXT, size INTEGER);
        CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER, rule_id TEXT, severity TEXT, title TEXT, description TEXT, line_number INTEGER, matched_text TEXT, category TEXT);
      `);
      sdb.close();

      const result = await registry.executeTool('list_flutter_classes', { versionId: 2 });
      expect(result).toEqual({ error: 'No Flutter dump data found for this version' });
    });
  });

  // ── search_flutter_methods ──────────────────────────────────────

  describe('search_flutter_methods', () => {
    let tmpDir: string;
    let originalCwd: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'darkride-flutter-methods-test-'));
      originalCwd = process.cwd();
      process.chdir(tmpDir);

      db.insert(schema.trackedApps).values({
        packageName: 'com.test.flutter2',
        appName: 'Flutter Methods Test',
        createdAt: new Date(NOW * 1000),
      }).run();

      db.insert(schema.apkVersions).values({
        trackedAppId: 1,
        versionCode: 1,
        versionName: '1.0',
        filename: 'test.apk',
        fileSize: 1000,
        downloadedAt: new Date(NOW * 1000),
      }).run();

      const zlib = require('zlib');
      const BetterSqlite = require('better-sqlite3');
      const dir = path.join(tmpDir, 'data/apks/com.test.flutter2/analysis/1');
      fs.mkdirSync(dir, { recursive: true });
      const dbPath = path.join(dir, 'source.db');
      const sdb = new BetterSqlite(dbPath);
      sdb.exec(`
        CREATE TABLE manifest (key TEXT, value TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, source TEXT, content BLOB, language TEXT, size INTEGER);
        CREATE TABLE findings (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id INTEGER, rule_id TEXT, severity TEXT, title TEXT, description TEXT, line_number INTEGER, matched_text TEXT, category TEXT);
      `);

      const flutterDump = `class NetworkService {
  Future<Response> fetchData(String url) {
  }
  static NetworkService createInstance() {
  }
  void dispose() {
  }
}

class AuthManager {
  Future<bool> login(String user, String pass) {
  }
  void logout() {
  }
}`;

      const compressed = zlib.deflateSync(Buffer.from(flutterDump));
      sdb.prepare('INSERT INTO files (path, source, content, language, size) VALUES (?, ?, ?, ?, ?)').run('lib/services.dart', 'flutter-dump', compressed, 'dart', flutterDump.length);
      sdb.close();
    });

    afterEach(() => {
      process.chdir(originalCwd);
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('registers search_flutter_methods for apk-analysis context', () => {
      const tools = registry.getToolsForContext('apk-analysis');
      expect(tools.map(t => t.name)).toContain('search_flutter_methods');
    });

    it('finds all methods without filters', async () => {
      const result = await registry.executeTool('search_flutter_methods', { versionId: 1 });
      expect(result.methods.length).toBe(5);
    });

    it('filters by className', async () => {
      const result = await registry.executeTool('search_flutter_methods', {
        versionId: 1,
        className: 'AuthManager',
      });
      expect(result.methods).toHaveLength(2);
      expect(result.methods.every((m: any) => m.className === 'AuthManager')).toBe(true);
      const names = result.methods.map((m: any) => m.name);
      expect(names).toContain('login');
      expect(names).toContain('logout');
    });

    it('filters by query substring', async () => {
      const result = await registry.executeTool('search_flutter_methods', {
        versionId: 1,
        query: 'log',
      });
      // Should match 'login' and 'logout'
      expect(result.methods).toHaveLength(2);
    });

    it('combines className and query', async () => {
      const result = await registry.executeTool('search_flutter_methods', {
        versionId: 1,
        className: 'NetworkService',
        query: 'fetch',
      });
      expect(result.methods).toHaveLength(1);
      expect(result.methods[0].name).toBe('fetchData');
      expect(result.methods[0].className).toBe('NetworkService');
    });

    it('includes line numbers', async () => {
      const result = await registry.executeTool('search_flutter_methods', {
        versionId: 1,
        className: 'NetworkService',
      });
      for (const m of result.methods) {
        expect(typeof m.line).toBe('number');
        expect(m.line).toBeGreaterThan(0);
      }
    });
  });

  // ─── Regression: frida + device-shell tools must not loop back via HTTP ────
  //
  // Pre-fix, these tools all did `fetch('http://localhost:PORT/v1/frida/...')`
  // (or `/v1/device/:id/shell`). The host's auth middleware rejected the
  // loopback as unauthenticated and returned 401 — even though the original
  // MCP caller was authenticated. Tests below mock callFridaBridge and the
  // deviceManager's executeShellCommand and assert each tool resolves via
  // the service handle directly, without making any fetch() call.
  describe('frida and device-shell tools resolve without HTTP loopback', () => {
    const realFetch = globalThis.fetch;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Trap any unintended fetch so the test fails loudly if a tool
      // regresses to HTTP loopback.
      fetchSpy = vi.fn().mockRejectedValue(new Error('UNEXPECTED FETCH'));
      (globalThis as any).fetch = fetchSpy;
    });

    afterEach(() => {
      (globalThis as any).fetch = realFetch;
    });

    it('list_device_apps calls the bridge directly', async () => {
      mockCallFridaBridge.mockResolvedValueOnce([{ name: 'com.example' }]);
      const result = await registry.executeTool('list_device_apps', { deviceId: 'dev-1' });
      expect(mockCallFridaBridge).toHaveBeenCalledWith(
        expect.anything(),
        'dev-1',
        'frida_list_apps',
        {},
      );
      expect(result).toEqual([{ name: 'com.example' }]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('get_frida_messages calls the bridge directly', async () => {
      mockCallFridaBridge.mockResolvedValueOnce([{ ts: 1, payload: 'hello' }]);
      const result = await registry.executeTool('get_frida_messages', { deviceId: 'dev-1', since: 123 });
      expect(mockCallFridaBridge).toHaveBeenCalledWith(
        expect.anything(),
        'dev-1',
        'frida_get_messages',
        { since: 123 },
      );
      expect(result).toEqual([{ ts: 1, payload: 'hello' }]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('stop_frida calls the bridge directly', async () => {
      mockCallFridaBridge.mockResolvedValueOnce({ stopped: true });
      const result = await registry.executeTool('stop_frida', { deviceId: 'dev-1' });
      expect(mockCallFridaBridge).toHaveBeenCalledWith(
        expect.anything(),
        'dev-1',
        'frida_stop_server',
        {},
      );
      expect(result).toEqual({ stopped: true });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('run_frida_script calls the bridge directly with the spawn method', async () => {
      mockCallFridaBridge.mockResolvedValueOnce({ pid: 1234 });
      const result = await registry.executeTool('run_frida_script', {
        deviceId: 'dev-1',
        bundleId: 'com.example',
        code: 'send("hi")',
        mode: 'spawn',
      });
      expect(mockCallFridaBridge).toHaveBeenCalledWith(
        expect.anything(),
        'dev-1',
        'frida_run',
        expect.objectContaining({
          bundle_id: 'com.example',
          code: 'send("hi")',
        }),
      );
      expect(result).toEqual({ pid: 1234 });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('run_adb_command returns {output, stderr, exitCode} on a successful run', async () => {
      const runShellCommandWithExitCode = vi.fn().mockResolvedValue({
        stdout: 'total 0\n', stderr: '', exitCode: 0,
      });
      const getDeviceStatus = vi.fn().mockResolvedValue({ isOnline: true });
      const fakeDeviceManager = { runShellCommandWithExitCode, getDeviceStatus } as any;

      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { deviceManager: fakeDeviceManager });

      const result = await r.executeTool('run_adb_command', { deviceId: 'dev-1', command: 'ls' });

      expect(runShellCommandWithExitCode).toHaveBeenCalledWith('dev-1', 'ls');
      expect(result).toEqual({
        deviceId: 'dev-1',
        command: 'ls',
        output: 'total 0',     // trimmed
        stderr: '',
        exitCode: 0,
      });
    });

    it('run_adb_command returns non-zero exits as data, does NOT throw', async () => {
      // `killall x` when nothing matches — exit 1 is a benign outcome the AI
      // should be able to branch on rather than retry with `cmd; true`.
      const runShellCommandWithExitCode = vi.fn().mockResolvedValue({
        stdout: '', stderr: 'no process found\n', exitCode: 1,
      });
      const getDeviceStatus = vi.fn().mockResolvedValue({ isOnline: true });
      const fakeDeviceManager = { runShellCommandWithExitCode, getDeviceStatus } as any;

      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { deviceManager: fakeDeviceManager });

      const result = await r.executeTool('run_adb_command', {
        deviceId: 'dev-1', command: 'killall frida-server',
      });

      expect(result).toEqual({
        deviceId: 'dev-1',
        command: 'killall frida-server',
        output: '',
        stderr: 'no process found',
        exitCode: 1,
      });
      expect((result as any).error).toBeUndefined();
    });

    it('run_adb_command rethrows transport errors (adb missing, timeout, etc.)', async () => {
      // ENOENT / ETIMEDOUT come back as a thrown error from the helper — the
      // tool must NOT swallow these as exit codes; they indicate ADB itself
      // is broken, not that the command exited non-zero.
      const transportErr = Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' });
      const runShellCommandWithExitCode = vi.fn().mockRejectedValue(transportErr);
      const getDeviceStatus = vi.fn().mockResolvedValue({ isOnline: true });
      const fakeDeviceManager = { runShellCommandWithExitCode, getDeviceStatus } as any;

      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { deviceManager: fakeDeviceManager });

      const result = await r.executeTool('run_adb_command', { deviceId: 'dev-1', command: 'ls' });
      // The tool's own try/catch wraps thrown errors into a {error} payload
      // (file convention; AiToolRegistry.executeTool itself rethrows).
      expect((result as any).error).toMatch(/ENOENT|spawn adb/);
    });

    it('run_adb_command treats timeout (err.code === null) as a transport error', async () => {
      // Node's execFile signals timeout by rejecting with `err.code === null`
      // (a different branch of the helper's `typeof err.code !== 'number'`
      // guard than ENOENT, which is the string 'ENOENT'). Both must surface
      // as a {error} payload, not as an exit-code data shape.
      const timeoutErr = Object.assign(new Error('Command failed: adb -s dev-1 shell sleep 60'), { code: null });
      const runShellCommandWithExitCode = vi.fn().mockRejectedValue(timeoutErr);
      const getDeviceStatus = vi.fn().mockResolvedValue({ isOnline: true });
      const fakeDeviceManager = { runShellCommandWithExitCode, getDeviceStatus } as any;

      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { deviceManager: fakeDeviceManager });

      const result = await r.executeTool('run_adb_command', { deviceId: 'dev-1', command: 'sleep 60' });
      expect((result as any).error).toMatch(/Command failed/);
      expect((result as any).exitCode).toBeUndefined();
    });
  });

  // ─── Automation authoring tools ──────────────────────────────────────────
  describe('automation authoring tools', () => {
    it('create_automation inserts a row and returns id + code', async () => {
      const result = await registry.executeTool('create_automation', {
        name: 'morning login',
        code: 'await device.tap(100, 200);',
      }) as any;
      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe('morning login');
      expect(result.code).toBe('await device.tap(100, 200);');
      const row = db.select().from(schema.automations).where(eq(schema.automations.id, result.id)).all()[0];
      expect(row.passcode).toBeTruthy();
      expect(row.enabled).toBe(true);
      expect(row.requiresDevice).toBe(true);
    });

    it('create_automation rejects isRule + isCaptureRule together', async () => {
      await expect(registry.executeTool('create_automation', {
        name: 'bad', code: 'x', isRule: true, isCaptureRule: true,
      })).rejects.toThrow(/mutually exclusive/);
    });

    it('update_automation_code replaces only the code field', async () => {
      const created = await registry.executeTool('create_automation', { name: 'a', code: 'original' }) as any;
      const before = db.select().from(schema.automations).where(eq(schema.automations.id, created.id)).all()[0];
      const result = await registry.executeTool('update_automation_code', {
        id: created.id, code: 'new body',
      }) as any;
      expect(result.codeLength).toBe('new body'.length);
      const after = db.select().from(schema.automations).where(eq(schema.automations.id, created.id)).all()[0];
      expect(after.code).toBe('new body');
      expect(after.name).toBe(before.name);
      expect(after.passcode).toBe(before.passcode);
    });

    it('update_automation_code returns error for missing automation', async () => {
      const result = await registry.executeTool('update_automation_code', { id: 99999, code: 'x' });
      expect(result).toEqual({ error: 'Automation not found' });
    });

    it('patch_automation_code replaces a unique substring', async () => {
      const created = await registry.executeTool('create_automation', { name: 'p', code: 'line A\nline B\nline C\n' }) as any;
      const result = await registry.executeTool('patch_automation_code', {
        id: created.id, oldText: 'line B', newText: 'replaced',
      }) as any;
      expect(result.replacedAt).toBeGreaterThan(0);
      const after = db.select().from(schema.automations).where(eq(schema.automations.id, created.id)).all()[0];
      expect(after.code).toBe('line A\nreplaced\nline C\n');
    });

    it('patch_automation_code errors on no match', async () => {
      const created = await registry.executeTool('create_automation', { name: 'p', code: 'hello world' }) as any;
      const result = await registry.executeTool('patch_automation_code', {
        id: created.id, oldText: 'goodbye', newText: 'x',
      });
      expect(result).toEqual({ error: 'oldText not found in automation code' });
    });

    it('patch_automation_code errors on ambiguous match', async () => {
      const created = await registry.executeTool('create_automation', { name: 'p', code: 'foo foo foo' }) as any;
      const result = await registry.executeTool('patch_automation_code', {
        id: created.id, oldText: 'foo', newText: 'bar',
      });
      expect(result).toMatchObject({ error: expect.stringContaining('multiple locations') });
    });

    it('validate_automation returns valid:true for clean code', async () => {
      const compile = vi.fn().mockReturnValue({ code: 'compiled', diagnostics: [] });
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { compiler: { compileWithCache: compile } as any });
      const result = await r.executeTool('validate_automation', { code: 'const x = 1;' }) as any;
      expect(result.valid).toBe(true);
      expect(result.diagnostics).toEqual([]);
      expect(compile).toHaveBeenCalledWith('const x = 1;', '__validate__');
    });

    it('validate_automation returns diagnostics for bad code', async () => {
      const diagnostics = [{ messageText: 'Cannot find name "xyzzy"', line: 1 }];
      const compile = vi.fn().mockReturnValue({ code: '', diagnostics });
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { compiler: { compileWithCache: compile } as any });
      const result = await r.executeTool('validate_automation', { code: 'xyzzy()' }) as any;
      expect(result.valid).toBe(false);
      expect(result.diagnostics).toEqual(diagnostics);
    });

    it('run_automation runs deviceless automation via runner directly', async () => {
      const created = await registry.executeTool('create_automation', {
        name: 'deviceless', code: 'console.log("hi")', requiresDevice: false,
      }) as any;
      const runAutomation = vi.fn().mockResolvedValue({ sessionId: 42, status: 'completed' });
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, {
        runner: { runAutomation } as any,
        scheduler: { enqueue: vi.fn() } as any,
      });
      const result = await r.executeTool('run_automation', { id: created.id });
      expect(runAutomation).toHaveBeenCalledWith(created.id, undefined, 'manual');
      expect(result).toEqual({ sessionId: 42, status: 'completed' });
    });

    it('run_automation queues when device required but not supplied', async () => {
      const created = await registry.executeTool('create_automation', {
        name: 'needs-device', code: 'x', requiresDevice: true,
      }) as any;
      const enqueue = vi.fn().mockReturnValue({ queueId: 7 });
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, {
        runner: { runAutomation: vi.fn() } as any,
        scheduler: { enqueue } as any,
      });
      const result = await r.executeTool('run_automation', { id: created.id });
      expect(enqueue).toHaveBeenCalledWith(created.id, 'manual');
      expect(result).toEqual({ queued: { queueId: 7 } });
    });

    it('run_automation passes deviceId through to the runner', async () => {
      const created = await registry.executeTool('create_automation', { name: 'with-device', code: 'x' }) as any;
      const runAutomation = vi.fn().mockResolvedValue({ sessionId: 100 });
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, {
        runner: { runAutomation } as any,
        scheduler: { enqueue: vi.fn() } as any,
      });
      const result = await r.executeTool('run_automation', { id: created.id, deviceId: 'dev-1' });
      expect(runAutomation).toHaveBeenCalledWith(created.id, 'dev-1', 'manual');
      expect(result).toEqual({ sessionId: 100 });
    });

    // ─── update_automation_config ────────────────────────────────────────
    it('update_automation_config applies partial metadata updates', async () => {
      const created = await registry.executeTool('create_automation', { name: 'config-test', code: 'x' }) as any;
      const result = await registry.executeTool('update_automation_config', {
        id: created.id, name: 'renamed', priority: 50, enabled: false,
      }) as any;
      expect(result.name).toBe('renamed');
      expect(result.priority).toBe(50);
      expect(result.enabled).toBe(false);
      expect(result.scheduleResult).toBe('unchanged');
    });

    it('update_automation_config does NOT touch the code field', async () => {
      const created = await registry.executeTool('create_automation', { name: 'c', code: 'original code' }) as any;
      await registry.executeTool('update_automation_config', { id: created.id, name: 'renamed' });
      const row = db.select().from(schema.automations).where(eq(schema.automations.id, created.id)).all()[0];
      expect(row.code).toBe('original code');
    });

    it('update_automation_config returns error for missing automation', async () => {
      const result = await registry.executeTool('update_automation_config', { id: 99999, name: 'x' });
      expect(result).toEqual({ error: 'Automation not found' });
    });

    it('update_automation_config rejects isRule + isCaptureRule together', async () => {
      const created = await registry.executeTool('create_automation', { name: 'r', code: 'x' }) as any;
      const result = await registry.executeTool('update_automation_config', {
        id: created.id, isRule: true, isCaptureRule: true,
      });
      expect(result).toMatchObject({ error: expect.stringContaining('mutually exclusive') });
    });

    it('update_automation_config installs a valid cron schedule', async () => {
      const created = await registry.executeTool('create_automation', { name: 's', code: 'x' }) as any;
      const setSchedule = vi.fn();
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, {
        scheduler: { setSchedule, removeSchedule: vi.fn() } as any,
      });
      const result = await r.executeTool('update_automation_config', {
        id: created.id,
        schedule: { type: 'cron', expressions: ['0 9 * * *'] },
      }) as any;
      expect(setSchedule).toHaveBeenCalledWith(created.id, { type: 'cron', expressions: ['0 9 * * *'] });
      expect(result.scheduleResult).toBe('installed');
    });

    it('update_automation_config rejects an invalid cron expression', async () => {
      const created = await registry.executeTool('create_automation', { name: 's', code: 'x' }) as any;
      const setSchedule = vi.fn();
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, {
        scheduler: { setSchedule, removeSchedule: vi.fn() } as any,
      });
      const result = await r.executeTool('update_automation_config', {
        id: created.id,
        schedule: { type: 'cron', expressions: ['not a cron'] },
      }) as any;
      expect(setSchedule).not.toHaveBeenCalled();
      expect(result.scheduleResult).toBe('invalid');
    });

    it('update_automation_config clears the schedule when null is passed', async () => {
      const created = await registry.executeTool('create_automation', { name: 's', code: 'x' }) as any;
      const removeSchedule = vi.fn();
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, {
        scheduler: { setSchedule: vi.fn(), removeSchedule } as any,
      });
      const result = await r.executeTool('update_automation_config', {
        id: created.id, schedule: null,
      }) as any;
      expect(removeSchedule).toHaveBeenCalledWith(created.id);
      expect(result.scheduleResult).toBe('cleared');
    });
  });

  // ─── Intercept rule tools ────────────────────────────────────────────────
  describe('intercept rule tools', () => {
    beforeEach(() => {
      mockSyncInterceptConfig.mockReset();
    });

    it('list_intercept_rules returns rows sorted by priority', async () => {
      const now = new Date();
      (db as any).insert(schema.interceptRules).values([
        { name: 'B', matchHostname: 'b.example.com', phase: 'request', actions: '[]', priority: 10, createdAt: now, updatedAt: now },
        { name: 'A', matchHostname: 'a.example.com', phase: 'request', actions: '[]', priority: 1, createdAt: now, updatedAt: now },
      ]).run();
      const result = await registry.executeTool('list_intercept_rules', {}) as any[];
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('A');
      expect(result[1].name).toBe('B');
    });

    it('create_intercept_rule inserts and triggers syncInterceptConfig', async () => {
      const result = await registry.executeTool('create_intercept_rule', {
        name: 'Block ads', matchHostname: 'ads.example.com', phase: 'request',
        actions: [{ type: 'block' }],
      }) as any;
      expect(result.id).toBeGreaterThan(0);
      expect(result.name).toBe('Block ads');
      expect(result.actions).toBe(JSON.stringify([{ type: 'block' }]));
      expect(mockSyncInterceptConfig).toHaveBeenCalledTimes(1);
    });

    it('create_intercept_rule defaults actions to empty array', async () => {
      const result = await registry.executeTool('create_intercept_rule', {
        name: 'Rule', matchHostname: 'h', phase: 'request',
      }) as any;
      expect(result.actions).toBe('[]');
    });

    it('update_intercept_rule applies partial updates and triggers sync', async () => {
      const created = await registry.executeTool('create_intercept_rule', {
        name: 'Initial', matchHostname: 'h', phase: 'request',
      }) as any;
      mockSyncInterceptConfig.mockClear();
      const result = await registry.executeTool('update_intercept_rule', {
        id: created.id, name: 'Renamed', priority: 50,
      }) as any;
      expect(result.name).toBe('Renamed');
      expect(result.priority).toBe(50);
      expect(result.matchHostname).toBe('h'); // unchanged
      expect(mockSyncInterceptConfig).toHaveBeenCalledTimes(1);
    });

    it('update_intercept_rule returns error for missing rule', async () => {
      const result = await registry.executeTool('update_intercept_rule', { id: 9999, name: 'x' });
      expect(result).toEqual({ error: 'Rule not found' });
    });

    it('toggle_intercept_rule flips enabled and triggers sync', async () => {
      const created = await registry.executeTool('create_intercept_rule', {
        name: 'T', matchHostname: 'h', phase: 'request',
      }) as any;
      expect(created.enabled).toBe(true);
      mockSyncInterceptConfig.mockClear();
      const off = await registry.executeTool('toggle_intercept_rule', { id: created.id }) as any;
      expect(off.enabled).toBe(false);
      const on = await registry.executeTool('toggle_intercept_rule', { id: created.id }) as any;
      expect(on.enabled).toBe(true);
      expect(mockSyncInterceptConfig).toHaveBeenCalledTimes(2);
    });

    it('delete_intercept_rule removes the row and triggers sync', async () => {
      const created = await registry.executeTool('create_intercept_rule', {
        name: 'D', matchHostname: 'h', phase: 'request',
      }) as any;
      mockSyncInterceptConfig.mockClear();
      const result = await registry.executeTool('delete_intercept_rule', { id: created.id }) as any;
      expect(result).toEqual({ id: created.id, deleted: true });
      const remaining = db.select().from(schema.interceptRules).where(eq(schema.interceptRules.id, created.id)).all();
      expect(remaining).toHaveLength(0);
      expect(mockSyncInterceptConfig).toHaveBeenCalledTimes(1);
    });

    it('delete_intercept_rule returns error for missing rule', async () => {
      const result = await registry.executeTool('delete_intercept_rule', { id: 9999 });
      expect(result).toEqual({ error: 'Rule not found' });
    });
  });

  // ─── Capture session tools ───────────────────────────────────────────────
  describe('capture session tools', () => {
    it('start_capture calls captureManager.startCapture and returns sessionId', async () => {
      const startCapture = vi.fn().mockResolvedValue({ sessionId: 42 });
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { captureManager: { startCapture } as any });
      const result = await r.executeTool('start_capture', {
        deviceId: 'dev-1', proxyMode: 'normal', tlsProfile: 'firefox-128',
      });
      expect(startCapture).toHaveBeenCalledWith('dev-1', { mode: 'normal', country: undefined }, 'firefox-128');
      expect(result).toEqual({ sessionId: 42 });
    });

    it('start_capture omits proxyOptions when proxyMode missing', async () => {
      const startCapture = vi.fn().mockResolvedValue({ sessionId: 7 });
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { captureManager: { startCapture } as any });
      await r.executeTool('start_capture', { deviceId: 'dev-1' });
      expect(startCapture).toHaveBeenCalledWith('dev-1', undefined, undefined);
    });

    it('stop_capture calls captureManager.stopCapture and returns ack', async () => {
      const stopCapture = vi.fn().mockResolvedValue(undefined);
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, { captureManager: { stopCapture } as any });
      const result = await r.executeTool('stop_capture', { deviceId: 'dev-1' });
      expect(stopCapture).toHaveBeenCalledWith('dev-1');
      expect(result).toEqual({ deviceId: 'dev-1', stopped: true });
    });
  });

  // ─── Plugin management tools ─────────────────────────────────────────────
  describe('plugin management tools', () => {
    function makePluginRegistry() {
      const setEnabled = vi.fn();
      const get = vi.fn().mockReturnValue({ name: 'demo', enabled: true });
      const setRestartRequired = vi.fn();
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, {
        pluginStateManager: { setEnabled, get } as any,
        systemStateService: { setRestartRequired } as any,
      });
      return { r, setEnabled, get, setRestartRequired };
    }

    it('enable_plugin calls setEnabled(true) and flags restart-required', async () => {
      const { r, setEnabled, setRestartRequired } = makePluginRegistry();
      const result = await r.executeTool('enable_plugin', { name: 'demo' });
      expect(setEnabled).toHaveBeenCalledWith('demo', true);
      expect(setRestartRequired).toHaveBeenCalledWith('plugin demo enabled');
      expect(result).toEqual({ name: 'demo', enabled: true, restartRequired: true });
    });

    it('disable_plugin calls setEnabled(false) and flags restart-required', async () => {
      const { r, setEnabled, setRestartRequired } = makePluginRegistry();
      const result = await r.executeTool('disable_plugin', { name: 'demo' });
      expect(setEnabled).toHaveBeenCalledWith('demo', false);
      expect(setRestartRequired).toHaveBeenCalledWith('plugin demo disabled');
      expect(result).toEqual({ name: 'demo', enabled: false, restartRequired: true });
    });

    it('enable_plugin returns error if plugin not found', async () => {
      const r = new AiToolRegistry();
      registerAllTools(r, db as any, {
        pluginStateManager: { get: vi.fn().mockReturnValue(undefined), setEnabled: vi.fn() } as any,
      });
      const result = await r.executeTool('enable_plugin', { name: 'missing' }) as any;
      expect(result.error).toMatch(/not found/);
    });
  });

  // ─── Settings tools ──────────────────────────────────────────────────────
  describe('settings tools', () => {
    it('get_setting returns null value when key never set', async () => {
      const result = await registry.executeTool('get_setting', { key: 'never_set' });
      expect(result).toEqual({ key: 'never_set', value: null });
    });

    it('get_setting returns stored value for known key', async () => {
      (db as any).insert(schema.settings).values({ key: 'mcp_enabled', value: 'true' }).run();
      const result = await registry.executeTool('get_setting', { key: 'mcp_enabled' });
      expect(result).toEqual({ key: 'mcp_enabled', value: 'true' });
    });

    it('get_setting masks secret-looking keys', async () => {
      (db as any).insert(schema.settings).values({ key: 'github_api_key', value: 'ghp_supersecret' }).run();
      const result = await registry.executeTool('get_setting', { key: 'github_api_key' }) as any;
      expect(result.value).toBe('********');
    });

    it('update_setting inserts on first write', async () => {
      const result = await registry.executeTool('update_setting', { key: 'new_key', value: 'hello' });
      expect(result).toEqual({ key: 'new_key', updated: true });
      const row = db.select().from(schema.settings).where(eq(schema.settings.key, 'new_key')).all()[0];
      expect(row.value).toBe('hello');
    });

    it('update_setting overwrites on second write', async () => {
      await registry.executeTool('update_setting', { key: 'k', value: 'first' });
      await registry.executeTool('update_setting', { key: 'k', value: 'second' });
      const row = db.select().from(schema.settings).where(eq(schema.settings.key, 'k')).all()[0];
      expect(row.value).toBe('second');
    });
  });

  // ─── Patch tools (token reduction) ───────────────────────────────────────
  describe('patch tools', () => {
    async function makeFridaScript(code: string): Promise<number> {
      const now = new Date();
      (db as any).insert(schema.fridaScripts).values({
        name: 'test-script', code, createdAt: now, updatedAt: now,
      }).run();
      const rows = (db as any).select().from(schema.fridaScripts).all() as any[];
      return rows[rows.length - 1].id;
    }

    it('patch_frida_script replaces a unique substring', async () => {
      const id = await makeFridaScript('hookA();\nhookB();\nhookC();\n');
      const result = await registry.executeTool('patch_frida_script', {
        scriptId: id, oldText: 'hookB();', newText: 'hookB({ verbose: true });',
      }) as any;
      expect(result.scriptId).toBe(id);
      const row = (db as any).select().from(schema.fridaScripts).where(eq(schema.fridaScripts.id, id)).all()[0];
      expect(row.code).toBe('hookA();\nhookB({ verbose: true });\nhookC();\n');
    });

    it('patch_frida_script errors on ambiguous match', async () => {
      const id = await makeFridaScript('x();x();x();');
      const result = await registry.executeTool('patch_frida_script', {
        scriptId: id, oldText: 'x();', newText: 'y();',
      });
      expect(result).toMatchObject({ error: expect.stringContaining('multiple') });
    });

    it('patch_frida_script errors on no match', async () => {
      const id = await makeFridaScript('no match here');
      const result = await registry.executeTool('patch_frida_script', {
        scriptId: id, oldText: 'absent', newText: 'x',
      });
      expect(result).toEqual({ error: 'oldText not found in script' });
    });

    it('append_frida_hook appends a hook with a separator', async () => {
      const id = await makeFridaScript('Java.perform(() => { ... });\n');
      const result = await registry.executeTool('append_frida_hook', {
        scriptId: id, hookCode: 'Java.perform(() => { another(); });',
      }) as any;
      expect(result.scriptId).toBe(id);
      const row = (db as any).select().from(schema.fridaScripts).where(eq(schema.fridaScripts.id, id)).all()[0];
      expect(row.code).toBe('Java.perform(() => { ... });\n\nJava.perform(() => { another(); });');
    });

    it('append_frida_hook handles missing trailing newline', async () => {
      const id = await makeFridaScript('first()');
      await registry.executeTool('append_frida_hook', { scriptId: id, hookCode: 'second()' });
      const row = (db as any).select().from(schema.fridaScripts).where(eq(schema.fridaScripts.id, id)).all()[0];
      // Two newlines inserted because previous code didn't end with \n
      expect(row.code).toBe('first()\n\nsecond()');
    });

    it('patch_diff_summary_section replaces an existing section', async () => {
      const now = new Date();
      (db as any).insert(schema.apkDiffReports).values({
        apkVersionId: 1, compareVersionId: 2,
        status: 'completed',
        aiSummary: '## Overview\nold overview text\n\n## Details\nstuff\n',
        createdAt: now,
      }).run();
      const reportId = (db as any).select().from(schema.apkDiffReports).all()[0].id;
      const result = await registry.executeTool('patch_diff_summary_section', {
        reportId, section: 'Overview', content: 'new overview text',
      }) as any;
      expect(result.section).toBe('Overview');
      const row = (db as any).select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, reportId)).all()[0];
      expect(row.aiSummary).toContain('## Overview\nnew overview text');
      expect(row.aiSummary).toContain('## Details\nstuff');
    });

    it('patch_diff_summary_section appends a new section', async () => {
      const now = new Date();
      (db as any).insert(schema.apkDiffReports).values({
        apkVersionId: 1, compareVersionId: 2,
        status: 'completed',
        aiSummary: '## Overview\nstuff\n',
        createdAt: now,
      }).run();
      const reportId = (db as any).select().from(schema.apkDiffReports).all()[0].id;
      await registry.executeTool('patch_diff_summary_section', {
        reportId, section: 'New Section', content: 'fresh content',
      });
      const row = (db as any).select().from(schema.apkDiffReports).where(eq(schema.apkDiffReports.id, reportId)).all()[0];
      expect(row.aiSummary).toContain('## Overview\nstuff');
      expect(row.aiSummary).toContain('## New Section\nfresh content');
    });

    it('patch_diff_summary_section returns error for missing report', async () => {
      const result = await registry.executeTool('patch_diff_summary_section', {
        reportId: 99999, section: 'X', content: 'y',
      });
      expect(result).toEqual({ error: 'Diff report not found' });
    });
  });

  // ── Frida tool-definition correctness ─────────────────────────

  describe('run_frida_script — scriptId resolution', () => {
    it('looks up scriptId and passes its code to the bridge', async () => {
      db.insert(schema.fridaScripts).values({
        name: 'AppGuard',
        code: 'send({type:"guard",enabled:true});',
        createdAt: new Date(),
        updatedAt: new Date(),
      }).run();
      const row = db.select().from(schema.fridaScripts).all()[0];

      mockCallFridaBridge.mockResolvedValue({ ok: true });
      await registry.executeTool('run_frida_script', {
        deviceId: 'd1', bundleId: 'com.example', scriptId: row.id,
      });

      expect(mockCallFridaBridge).toHaveBeenCalledWith(
        expect.anything(), 'd1', 'frida_run',
        expect.objectContaining({ code: 'send({type:"guard",enabled:true});' }),
      );
    });

    it('prefers inline code over scriptId when both are given', async () => {
      db.insert(schema.fridaScripts).values({
        name: 'S', code: 'send("from-db");', createdAt: new Date(), updatedAt: new Date(),
      }).run();
      const row = db.select().from(schema.fridaScripts).all()[0];

      mockCallFridaBridge.mockResolvedValue({ ok: true });
      await registry.executeTool('run_frida_script', {
        deviceId: 'd1', bundleId: 'com.example', scriptId: row.id, code: 'send("inline");',
      });

      expect(mockCallFridaBridge).toHaveBeenCalledWith(
        expect.anything(), 'd1', 'frida_run',
        expect.objectContaining({ code: 'send("inline");' }),
      );
    });

    it('rejects when scriptId does not exist', async () => {
      const result = await registry.executeTool('run_frida_script', {
        deviceId: 'd1', bundleId: 'com.example', scriptId: 99999,
      });
      expect(result).toMatchObject({ error: expect.stringMatching(/script.*99999/i) });
    });

    it('rejects when neither code nor scriptId is provided', async () => {
      const result = await registry.executeTool('run_frida_script', {
        deviceId: 'd1', bundleId: 'com.example',
      });
      expect(result).toMatchObject({ error: expect.stringMatching(/code.*scriptId|scriptId.*code/i) });
    });
  });

  describe('run_frida_script — schema documents controlled mode', () => {
    it('lists controlled in the mode enum with send-capture guidance', () => {
      const tool = registry
        .getToolsForContext('frida')
        .find((t) => t.name === 'run_frida_script');
      expect(tool).toBeDefined();
      const modeProp = (tool!.inputSchema as any).properties.mode;
      expect(modeProp.enum).toEqual(expect.arrayContaining(['spawn', 'attach', 'controlled']));
      expect(String(modeProp.description).toLowerCase()).toMatch(/controlled/);
      expect(String(modeProp.description).toLowerCase()).toMatch(/send/);
    });
  });

  describe('get_frida_output — reads bridge {messages,next_index} shape', () => {
    it('returns the messages array from the bridge object', async () => {
      mockCallFridaBridge.mockResolvedValue({
        messages: [{ type: 'send', payload: { x: 1 } }, { type: 'send', payload: { x: 2 } }],
        next_index: 2,
      });
      const result = await registry.executeTool('get_frida_output', { deviceId: 'd1' });
      expect(result).toEqual([
        { type: 'send', payload: { x: 1 } },
        { type: 'send', payload: { x: 2 } },
      ]);
    });

    it('respects the limit param', async () => {
      mockCallFridaBridge.mockResolvedValue({
        messages: [1, 2, 3, 4, 5], next_index: 5,
      });
      const result = await registry.executeTool('get_frida_output', { deviceId: 'd1', limit: 2 });
      expect(result).toEqual([1, 2]);
    });

    it('returns [] gracefully when the bridge returns nothing useful', async () => {
      mockCallFridaBridge.mockResolvedValue(null);
      const result = await registry.executeTool('get_frida_output', { deviceId: 'd1' });
      expect(result).toEqual([]);
    });
  });

  // ── Frida collector helper (spawnWaitCollectStop, exercised through
  //    run_frida_and_collect) ──────────────────────────────────────────

  describe('run_frida_and_collect — controlled-mode routing', () => {
    it('routes through frida_spawn_controlled, not frida_run', async () => {
      mockCallFridaBridge.mockImplementation(async (_bm, _dev, method, _params) => {
        if (method === 'frida_spawn_controlled') return { pid: 123, status: 'running' };
        if (method === 'frida_get_messages') return { messages: [], next_index: 0 };
        if (method === 'frida_stop_server') return { status: 'stopped' };
        throw new Error(`Unexpected bridge method: ${method}`);
      });

      await registry.executeTool('run_frida_and_collect', {
        deviceId: 'd1', bundleId: 'com.example', code: 'send({hi:1});', durationMs: 1,
      });

      const spawnCall = mockCallFridaBridge.mock.calls.find(
        (c: any[]) => c[2] === 'frida_spawn_controlled',
      );
      expect(spawnCall, 'expected frida_spawn_controlled to be invoked').toBeDefined();
      const runCall = mockCallFridaBridge.mock.calls.find(
        (c: any[]) => c[2] === 'frida_run',
      );
      expect(runCall, 'frida_run should NOT be called from the collector helper').toBeUndefined();
      // mode must NOT be passed (controlled mode ignores it; passing it
      // would just mislead future readers).
      expect(spawnCall![3]).not.toHaveProperty('mode');
    });

    it('returns send() payloads from the bridge {messages, next_index} shape', async () => {
      mockCallFridaBridge.mockImplementation(async (_bm, _dev, method, _params) => {
        if (method === 'frida_spawn_controlled') return { pid: 1, status: 'running' };
        if (method === 'frida_get_messages') {
          return {
            messages: [
              { type: 'send', payload: { found: 1 } },
              { type: 'send', payload: { found: 2 } },
            ],
            next_index: 2,
          };
        }
        if (method === 'frida_stop_server') return { status: 'stopped' };
        return null;
      });

      const result = await registry.executeTool('run_frida_and_collect', {
        deviceId: 'd1', bundleId: 'com.example', code: 'send({found:1});', durationMs: 1,
      });

      expect((result as any).messageCount).toBe(2);
      expect((result as any).messages).toEqual([
        { type: 'send', payload: { found: 1 } },
        { type: 'send', payload: { found: 2 } },
      ]);
    });

    it('still calls frida_stop_server after collection (best-effort cleanup)', async () => {
      mockCallFridaBridge.mockImplementation(async (_bm, _dev, method) => {
        if (method === 'frida_spawn_controlled') return { pid: 1, status: 'running' };
        if (method === 'frida_get_messages') return { messages: [], next_index: 0 };
        if (method === 'frida_stop_server') return { status: 'stopped' };
        return null;
      });

      await registry.executeTool('run_frida_and_collect', {
        deviceId: 'd1', bundleId: 'com.example', code: 'send({})', durationMs: 1,
      });

      const methods = mockCallFridaBridge.mock.calls.map((c: any[]) => c[2]);
      expect(methods).toContain('frida_stop_server');
      const spawnIdx = methods.indexOf('frida_spawn_controlled');
      const msgsIdx = methods.indexOf('frida_get_messages');
      const stopIdx = methods.indexOf('frida_stop_server');
      expect(stopIdx).toBeGreaterThan(spawnIdx);
      expect(stopIdx).toBeGreaterThan(msgsIdx);
    });
  });

  // ── App discovery tools ────────────────────────────────────────
  // The MCP-side tool surface was apk-analysis-centric: an agent could
  // inspect a known versionId 17 ways but had no way to discover one
  // from an app name. These tools close that loop.

  describe('list_tracked_apps', () => {
    function seedApps() {
      db.insert(schema.trackedApps).values([
        { packageName: 'com.disney.wdw', appName: 'Walt Disney World', createdAt: new Date(NOW * 1000) },
        { packageName: 'com.disney.dlr', appName: 'Disneyland Resort', createdAt: new Date(NOW * 1000) },
        { packageName: 'com.universal.studios', appName: 'Universal Studios', createdAt: new Date(NOW * 1000) },
        { packageName: 'com.empty.app', appName: 'No Versions', createdAt: new Date(NOW * 1000) },
      ]).run();
      const apps = db.select().from(schema.trackedApps).all();
      const wdw = apps.find(a => a.packageName === 'com.disney.wdw')!;
      const dlr = apps.find(a => a.packageName === 'com.disney.dlr')!;
      const uni = apps.find(a => a.packageName === 'com.universal.studios')!;
      db.insert(schema.apkVersions).values([
        { trackedAppId: wdw.id, versionCode: 100, versionName: '7.50.0', filename: 'wdw-100.apk', downloadedAt: new Date(NOW * 1000) },
        { trackedAppId: wdw.id, versionCode: 110, versionName: '7.51.0', filename: 'wdw-110.apk', downloadedAt: new Date(NOW * 1000) },
        { trackedAppId: dlr.id, versionCode: 80, versionName: '6.10.0', filename: 'dlr-80.apk', downloadedAt: new Date(NOW * 1000) },
        { trackedAppId: uni.id, versionCode: 50, versionName: '2.0.0', filename: 'uni-50.apk', downloadedAt: new Date(NOW * 1000) },
      ]).run();
      return { wdw, dlr, uni };
    }

    it('returns every tracked app with version count + latest version when no query is given', async () => {
      seedApps();
      const result: any = await registry.executeTool('list_tracked_apps', {});
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(4);
      const wdw = result.find((r: any) => r.packageName === 'com.disney.wdw');
      expect(wdw.versionCount).toBe(2);
      expect(wdw.latestVersionId).toBeTypeOf('number');
      expect(wdw.latestVersionCode).toBe(110);
      expect(wdw.latestVersionName).toBe('7.51.0');
      expect(wdw.appName).toBe('Walt Disney World');
    });

    it('reports 0 versions / null latest for an app with no APKs', async () => {
      seedApps();
      const result: any = await registry.executeTool('list_tracked_apps', {});
      const empty = result.find((r: any) => r.packageName === 'com.empty.app');
      expect(empty.versionCount).toBe(0);
      expect(empty.latestVersionId).toBeNull();
    });

    it('filters by query against appName (case insensitive)', async () => {
      seedApps();
      const result: any = await registry.executeTool('list_tracked_apps', { query: 'disney' });
      expect(result.map((r: any) => r.packageName).sort()).toEqual([
        'com.disney.dlr',
        'com.disney.wdw',
      ]);
    });

    it('filters by query against packageName', async () => {
      seedApps();
      const result: any = await registry.executeTool('list_tracked_apps', { query: 'universal' });
      expect(result).toHaveLength(1);
      expect(result[0].packageName).toBe('com.universal.studios');
    });

    it('returns an empty array when no apps match the query', async () => {
      seedApps();
      const result: any = await registry.executeTool('list_tracked_apps', { query: 'nothing-like-this' });
      expect(result).toEqual([]);
    });
  });

  describe('get_app_versions', () => {
    function seedAppWithVersions() {
      db.insert(schema.trackedApps).values({
        packageName: 'com.disney.wdw',
        appName: 'Walt Disney World',
        createdAt: new Date(NOW * 1000),
      }).run();
      const app = db.select().from(schema.trackedApps).all()[0];
      db.insert(schema.apkVersions).values([
        { trackedAppId: app.id, versionCode: 100, versionName: '7.50.0', filename: 'wdw-100.apk', downloadedAt: new Date(NOW * 1000) },
        { trackedAppId: app.id, versionCode: 110, versionName: '7.51.0', filename: 'wdw-110.apk', downloadedAt: new Date(NOW * 1000) },
        { trackedAppId: app.id, versionCode: 90, versionName: '7.49.0', filename: 'wdw-90.apk', downloadedAt: new Date(NOW * 1000) },
      ]).run();
      return app;
    }

    it('returns versions for a trackedAppId, newest versionCode first', async () => {
      const app = seedAppWithVersions();
      const result: any = await registry.executeTool('get_app_versions', { trackedAppId: app.id });
      expect(result.versions.map((v: any) => v.versionCode)).toEqual([110, 100, 90]);
      // The agent needs versionId so it can pass it to other apk tools.
      expect(result.versions[0].versionId).toBeTypeOf('number');
    });

    it('looks up by packageName', async () => {
      seedAppWithVersions();
      const result: any = await registry.executeTool('get_app_versions', { packageName: 'com.disney.wdw' });
      expect(result.packageName).toBe('com.disney.wdw');
      expect(result.versions).toHaveLength(3);
    });

    it('returns an error when neither trackedAppId nor packageName is given', async () => {
      const result: any = await registry.executeTool('get_app_versions', {});
      expect(result.error).toBeTruthy();
    });

    it('returns an error when the app is not found', async () => {
      const result: any = await registry.executeTool('get_app_versions', { packageName: 'com.does.not.exist' });
      expect(result.error).toBeTruthy();
    });

    it('reports analysis status per version (none / completed / pending)', async () => {
      const app = seedAppWithVersions();
      const versions = db.select().from(schema.apkVersions).all().sort((a, b) => b.versionCode - a.versionCode);
      db.insert(schema.analysisJobs).values([
        { apkVersionId: versions[0].id, status: 'completed', createdAt: new Date(NOW * 1000) },
        { apkVersionId: versions[1].id, status: 'pending', createdAt: new Date(NOW * 1000) },
      ]).run();
      const result: any = await registry.executeTool('get_app_versions', { trackedAppId: app.id });
      const v110 = result.versions.find((v: any) => v.versionCode === 110);
      const v100 = result.versions.find((v: any) => v.versionCode === 100);
      const v90 = result.versions.find((v: any) => v.versionCode === 90);
      expect(v110.analysisStatus).toBe('completed');
      expect(v100.analysisStatus).toBe('pending');
      expect(v90.analysisStatus).toBeNull();
    });

    it('uses the latest job per version when multiple jobs exist', async () => {
      // Regression for an in-memory-map quirk: if the iteration order
      // changes, picking the "first seen" must still mean the highest
      // id (= newest). Insert in a deliberately out-of-order sequence.
      const app = seedAppWithVersions();
      const versions = db.select().from(schema.apkVersions).all().sort((a, b) => b.versionCode - a.versionCode);
      db.insert(schema.analysisJobs).values([
        { apkVersionId: versions[0].id, status: 'failed', createdAt: new Date(NOW * 1000 - 2000) },
        { apkVersionId: versions[0].id, status: 'pending', createdAt: new Date(NOW * 1000 - 1000) },
        { apkVersionId: versions[0].id, status: 'completed', createdAt: new Date(NOW * 1000) },
      ]).run();
      const result: any = await registry.executeTool('get_app_versions', { trackedAppId: app.id });
      const v110 = result.versions.find((v: any) => v.versionCode === 110);
      expect(v110.analysisStatus).toBe('completed');
    });

    it('does not surface analysis jobs from a different app', async () => {
      // Regression: pre-fix, get_app_versions read every analysis_jobs
      // row in the DB and grouped client-side. The query is now scoped
      // to the app's versionIds via SQL inArray. This test would still
      // pass on the old impl (because grouping is by apkVersionId), but
      // codifies the boundary so a future "just join everything" change
      // can't silently leak unrelated app status.
      const app = seedAppWithVersions();
      // Insert a separate app + version + analysis job for it
      db.insert(schema.trackedApps).values({
        packageName: 'com.other.app', appName: 'Other', createdAt: new Date(NOW * 1000),
      }).run();
      const other = db.select().from(schema.trackedApps).where(eq(schema.trackedApps.packageName, 'com.other.app')).all()[0];
      db.insert(schema.apkVersions).values({
        trackedAppId: other.id, versionCode: 1, filename: 'other-1.apk', downloadedAt: new Date(NOW * 1000),
      }).run();
      const otherVersion = db.select().from(schema.apkVersions).where(eq(schema.apkVersions.trackedAppId, other.id)).all()[0];
      db.insert(schema.analysisJobs).values({
        apkVersionId: otherVersion.id, status: 'completed', createdAt: new Date(NOW * 1000),
      }).run();

      const result: any = await registry.executeTool('get_app_versions', { trackedAppId: app.id });
      // None of the WDW versions should have analysisStatus set just
      // because com.other.app has a completed job somewhere.
      for (const v of result.versions) {
        expect(v.analysisStatus).toBeNull();
      }
    });
  });

  describe('trigger_apk_analysis', () => {
    let localRegistry: AiToolRegistry;
    let fakeAnalyzer: { enqueue: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      localRegistry = new AiToolRegistry();
      fakeAnalyzer = { enqueue: vi.fn(async (_id: number) => 42) };
      registerAllTools(localRegistry, db as any, {
        bridgeManager: {} as any,
        deviceManager: { markBusy: vi.fn(), markIdle: vi.fn() } as any,
        apkAnalyzer: fakeAnalyzer as any,
      });
    });

    it('enqueues an analysis job for a known versionId and returns the jobId', async () => {
      db.insert(schema.trackedApps).values({
        packageName: 'com.disney.wdw', appName: 'Walt Disney World', createdAt: new Date(NOW * 1000),
      }).run();
      const app = db.select().from(schema.trackedApps).all()[0];
      db.insert(schema.apkVersions).values({
        trackedAppId: app.id, versionCode: 110, versionName: '7.51.0',
        filename: 'wdw-110.apk', downloadedAt: new Date(NOW * 1000),
      }).run();
      const version = db.select().from(schema.apkVersions).all()[0];

      const result: any = await localRegistry.executeTool('trigger_apk_analysis', { versionId: version.id });
      expect(fakeAnalyzer.enqueue).toHaveBeenCalledWith(version.id);
      expect(result.jobId).toBe(42);
    });

    it('returns an error when the version does not exist', async () => {
      const result: any = await localRegistry.executeTool('trigger_apk_analysis', { versionId: 9999 });
      expect(result.error).toBeTruthy();
      expect(fakeAnalyzer.enqueue).not.toHaveBeenCalled();
    });

    it('returns an error when the apk analyzer service is not wired in', async () => {
      const unwiredRegistry = new AiToolRegistry();
      registerAllTools(unwiredRegistry, db as any, {
        bridgeManager: {} as any,
        deviceManager: { markBusy: vi.fn(), markIdle: vi.fn() } as any,
      });
      db.insert(schema.trackedApps).values({
        packageName: 'com.x', appName: 'X', createdAt: new Date(NOW * 1000),
      }).run();
      const app = db.select().from(schema.trackedApps).all()[0];
      db.insert(schema.apkVersions).values({
        trackedAppId: app.id, versionCode: 1, filename: 'x-1.apk', downloadedAt: new Date(NOW * 1000),
      }).run();
      const version = db.select().from(schema.apkVersions).all()[0];

      const result: any = await unwiredRegistry.executeTool('trigger_apk_analysis', { versionId: version.id });
      expect(result.error).toMatch(/analyzer/i);
    });
  });

  describe('discovery tool context registration', () => {
    it('discovery tools are registered on dashboard context', () => {
      const tools = registry.getToolsForContext('dashboard');
      const names = tools.map(t => t.name);
      expect(names).toContain('list_tracked_apps');
      expect(names).toContain('get_app_versions');
      expect(names).toContain('trigger_apk_analysis');
    });

    it('discovery tools are also registered on apk-analysis context', () => {
      // So an agent already drilled into versionId X can find sibling
      // versions or trigger a re-analysis without context-switching.
      const tools = registry.getToolsForContext('apk-analysis');
      const names = tools.map(t => t.name);
      expect(names).toContain('list_tracked_apps');
      expect(names).toContain('get_app_versions');
      expect(names).toContain('trigger_apk_analysis');
    });
  });
});
