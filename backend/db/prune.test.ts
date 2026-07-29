import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import * as schema from './schema';
import { pruneOldData, cleanStaleSessions } from './prune';

const {
  devices,
  automations,
  automationSessions,
  screenshots,
  capturedTraffic,
  websocketMessages,
  injectedApks,
} = schema;

// Mock fs/promises unlink
vi.mock('fs/promises', () => ({
  unlink: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs sync methods for injected APK pruning
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    unlinkSync: vi.fn(),
  };
});

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn() }),
}));

import { unlink } from 'fs/promises';
import { createTestDb } from '../test-utils/create-test-db';

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

describe('pruneOldData', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();

    // Seed base data
    db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();
    db.insert(automations).values({
      name: 'Test Auto',
      code: 'code',
      passcode: 'pass',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();
  });

  it('should remove old screenshots, traffic, and sessions', async () => {
    const old = daysAgo(10);
    const recent = daysAgo(1);

    // Insert old session + old screenshot + old traffic
    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'manual',
      startedAt: old,
    }).run();

    db.insert(screenshots).values({
      sessionId: 1,
      filename: 'old-screenshot.png',
      name: 'Old',
      capturedAt: old,
    }).run();

    db.insert(capturedTraffic).values({
      deviceId: 'DEV001',
      sessionId: 1,
      requestMethod: 'GET',
      requestUrl: 'https://example.com/old',
      capturedAt: old,
    }).run();

    // Insert recent session + recent screenshot + recent traffic
    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'schedule',
      startedAt: recent,
    }).run();

    db.insert(screenshots).values({
      sessionId: 2,
      filename: 'new-screenshot.png',
      name: 'New',
      capturedAt: recent,
    }).run();

    db.insert(capturedTraffic).values({
      deviceId: 'DEV001',
      sessionId: 2,
      requestMethod: 'POST',
      requestUrl: 'https://example.com/new',
      capturedAt: recent,
    }).run();

    await pruneOldData(db as any, 7, '/tmp/screenshots');

    // Only recent data should remain
    expect(db.select().from(screenshots).all()).toHaveLength(1);
    expect(db.select().from(screenshots).all()[0].filename).toBe('new-screenshot.png');

    expect(db.select().from(capturedTraffic).all()).toHaveLength(1);
    expect(db.select().from(capturedTraffic).all()[0].requestUrl).toBe('https://example.com/new');

    expect(db.select().from(automationSessions).all()).toHaveLength(1);
    expect(db.select().from(automationSessions).all()[0].triggerType).toBe('schedule');
  });

  it('should attempt to delete screenshot files from disk', async () => {
    const old = daysAgo(10);

    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'manual',
      startedAt: old,
    }).run();

    db.insert(screenshots).values({
      sessionId: 1,
      filename: 'delete-me.png',
      capturedAt: old,
    }).run();

    db.insert(screenshots).values({
      sessionId: 1,
      filename: 'delete-me-too.png',
      capturedAt: old,
    }).run();

    await pruneOldData(db as any, 7, '/data/screenshots');

    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith(path.join('/data/screenshots', 'delete-me.png'));
    expect(unlink).toHaveBeenCalledWith(path.join('/data/screenshots', 'delete-me-too.png'));
  });

  it('should handle missing screenshot files gracefully', async () => {
    const old = daysAgo(10);

    // Make unlink throw ENOENT
    vi.mocked(unlink).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'manual',
      startedAt: old,
    }).run();

    db.insert(screenshots).values({
      sessionId: 1,
      filename: 'missing.png',
      capturedAt: old,
    }).run();

    // Should not throw even when file doesn't exist
    await expect(pruneOldData(db as any, 7, '/data/screenshots')).resolves.toBeUndefined();

    // DB records should still be deleted
    expect(db.select().from(screenshots).all()).toHaveLength(0);
  });

  it('should not remove data newer than prune days', async () => {
    const recent = daysAgo(3);

    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'api',
      startedAt: recent,
    }).run();

    db.insert(screenshots).values({
      sessionId: 1,
      filename: 'keep-me.png',
      capturedAt: recent,
    }).run();

    db.insert(capturedTraffic).values({
      deviceId: 'DEV001',
      requestMethod: 'GET',
      requestUrl: 'https://example.com/keep',
      capturedAt: recent,
    }).run();

    await pruneOldData(db as any, 7, '/tmp/screenshots');

    expect(db.select().from(screenshots).all()).toHaveLength(1);
    expect(db.select().from(capturedTraffic).all()).toHaveLength(1);
    expect(db.select().from(automationSessions).all()).toHaveLength(1);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('should not prune pinned sessions or their related data', async () => {
    const old = daysAgo(10);

    // Insert a pinned old session
    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'manual',
      isPinned: true,
      startedAt: old,
    }).run();

    // Insert an unpinned old session
    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'manual',
      startedAt: old,
    }).run();

    // Add screenshots for both
    db.insert(screenshots).values({
      sessionId: 1,
      filename: 'pinned-screenshot.png',
      capturedAt: old,
    }).run();
    db.insert(screenshots).values({
      sessionId: 2,
      filename: 'unpinned-screenshot.png',
      capturedAt: old,
    }).run();

    // Add traffic for both
    db.insert(capturedTraffic).values({
      sessionId: 1,
      deviceId: 'DEV001',
      requestMethod: 'GET',
      requestUrl: 'https://example.com/pinned',
      capturedAt: old,
    }).run();
    db.insert(capturedTraffic).values({
      sessionId: 2,
      deviceId: 'DEV001',
      requestMethod: 'GET',
      requestUrl: 'https://example.com/unpinned',
      capturedAt: old,
    }).run();

    // Add websocket messages for both
    db.insert(websocketMessages).values({
      sessionId: 1,
      direction: 'send',
      opcode: 'text',
      payload: 'pinned ws',
      payloadSize: 9,
      timestamp: old,
    }).run();
    db.insert(websocketMessages).values({
      sessionId: 2,
      direction: 'send',
      opcode: 'text',
      payload: 'unpinned ws',
      payloadSize: 11,
      timestamp: old,
    }).run();

    await pruneOldData(db as any, 7, '/tmp/screenshots');

    // Pinned session and its data should survive
    const remainingSessions = db.select().from(automationSessions).all();
    expect(remainingSessions).toHaveLength(1);
    expect(remainingSessions[0].isPinned).toBe(true);

    const remainingScreenshots = db.select().from(screenshots).all();
    expect(remainingScreenshots).toHaveLength(1);
    expect(remainingScreenshots[0].filename).toBe('pinned-screenshot.png');

    const remainingTraffic = db.select().from(capturedTraffic).all();
    expect(remainingTraffic).toHaveLength(1);
    expect(remainingTraffic[0].requestUrl).toBe('https://example.com/pinned');

    const remainingWs = db.select().from(websocketMessages).all();
    expect(remainingWs).toHaveLength(1);
    expect(remainingWs[0].payload).toBe('pinned ws');

    // Only the unpinned screenshot file should have been deleted
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(path.join('/tmp/screenshots', 'unpinned-screenshot.png'));
  });

  it('should prune old websocket messages', async () => {
    const oldDate = daysAgo(10);
    const recentDate = daysAgo(1);

    // Insert old session and old traffic entry
    db.insert(automationSessions).values({
      status: 'success',
      triggerType: 'manual',
      startedAt: oldDate,
      completedAt: oldDate,
    }).run();

    db.insert(capturedTraffic).values({
      sessionId: 1,
      requestMethod: 'GET',
      requestUrl: 'wss://example.com/ws',
      responseStatus: 101,
      type: 'websocket',
      capturedAt: oldDate,
    }).run();

    db.insert(websocketMessages).values({
      trafficId: 1,
      sessionId: 1,
      direction: 'send',
      opcode: 'text',
      payload: 'old message',
      payloadSize: 11,
      timestamp: oldDate,
    }).run();

    // Insert a recent session, traffic, and ws message
    db.insert(automationSessions).values({
      status: 'success',
      triggerType: 'manual',
      startedAt: recentDate,
      completedAt: recentDate,
    }).run();

    db.insert(capturedTraffic).values({
      sessionId: 2,
      requestMethod: 'GET',
      requestUrl: 'wss://example.com/ws2',
      responseStatus: 101,
      type: 'websocket',
      capturedAt: recentDate,
    }).run();

    db.insert(websocketMessages).values({
      trafficId: 2,
      sessionId: 2,
      direction: 'receive',
      opcode: 'text',
      payload: 'recent message',
      payloadSize: 14,
      timestamp: recentDate,
    }).run();

    await pruneOldData(db as any, 7, '/tmp/screenshots');

    const remaining = db.select().from(websocketMessages).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].payload).toBe('recent message');
  });
});

describe('cleanStaleSessions', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();

    db.insert(devices).values({ id: 'DEV001', name: 'Test Device' }).run();
    db.insert(automations).values({
      name: 'Test Auto',
      code: 'code',
      passcode: 'pass',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();
  });

  it('should mark old running sessions as failed', () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'running',
      triggerType: 'manual',
      startedAt: oldDate,
    }).run();

    const cleaned = cleanStaleSessions(db as any, 30);
    expect(cleaned).toBe(1);

    const sessions = db.select().from(automationSessions).all();
    expect(sessions[0].status).toBe('failed');
    expect(sessions[0].completedAt).not.toBeNull();
    expect(sessions[0].logs).toContain('stale running state');
  });

  it('should not touch recent running sessions', () => {
    const recentDate = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago

    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'running',
      triggerType: 'manual',
      startedAt: recentDate,
    }).run();

    const cleaned = cleanStaleSessions(db as any, 30);
    expect(cleaned).toBe(0);

    const sessions = db.select().from(automationSessions).all();
    expect(sessions[0].status).toBe('running');
  });

  it('should not touch completed sessions', () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000);

    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'manual',
      startedAt: oldDate,
      completedAt: oldDate,
    }).run();

    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'failed',
      triggerType: 'manual',
      startedAt: oldDate,
      completedAt: oldDate,
    }).run();

    const cleaned = cleanStaleSessions(db as any, 30);
    expect(cleaned).toBe(0);
  });

  it('should return 0 when no stale sessions exist', () => {
    const cleaned = cleanStaleSessions(db as any, 30);
    expect(cleaned).toBe(0);
  });

  it('should mark ALL running sessions as failed when staleMinutes is 0 (startup mode)', () => {
    // A session started just 1 second ago — normally not stale
    const justNow = new Date(Date.now() - 1000);

    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'running',
      triggerType: 'manual',
      startedAt: justNow,
    }).run();

    // A completed session should be untouched
    db.insert(automationSessions).values({
      automationId: 1,
      deviceId: 'DEV001',
      status: 'success',
      triggerType: 'manual',
      startedAt: justNow,
      completedAt: justNow,
    }).run();

    const cleaned = cleanStaleSessions(db as any, 0);
    expect(cleaned).toBe(1);

    const sessions = db.select().from(automationSessions).all();
    expect(sessions[0].status).toBe('failed');
    expect(sessions[0].logs).toContain('stale running state');
    expect(sessions[1].status).toBe('success');
  });

  it('should handle multiple stale sessions', () => {
    const oldDate = new Date(Date.now() - 60 * 60 * 1000);

    db.insert(automationSessions).values({
      automationId: 1, deviceId: 'DEV001', status: 'running', triggerType: 'manual', startedAt: oldDate,
    }).run();
    db.insert(automationSessions).values({
      automationId: 1, deviceId: 'DEV001', status: 'running', triggerType: 'schedule', startedAt: oldDate,
    }).run();

    const cleaned = cleanStaleSessions(db as any, 30);
    expect(cleaned).toBe(2);

    const sessions = db.select().from(automationSessions).all();
    expect(sessions.every(s => s.status === 'failed')).toBe(true);
  });
});

describe('injected APK pruning', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  it('deletes injected APKs older than 3 days', async () => {
    const old = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    const fresh = new Date();

    db.insert(injectedApks).values({
      packageName: 'old.app', versionCode: 1, fridaVersion: '16.0.0',
      filename: 'old.apk', createdAt: old,
    }).run();
    db.insert(injectedApks).values({
      packageName: 'new.app', versionCode: 1, fridaVersion: '16.0.0',
      filename: 'new.apk', createdAt: fresh,
    }).run();

    await pruneOldData(db as any, 7, '/tmp/screenshots');

    const remaining = db.select().from(injectedApks).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].packageName).toBe('new.app');
  });

  it('keeps injected APKs younger than 3 days', async () => {
    const fresh = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    db.insert(injectedApks).values({
      packageName: 'recent.app', versionCode: 2, fridaVersion: '16.0.0',
      filename: 'recent.apk', createdAt: fresh,
    }).run();

    await pruneOldData(db as any, 7, '/tmp/screenshots');

    const remaining = db.select().from(injectedApks).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].packageName).toBe('recent.app');
  });
});
