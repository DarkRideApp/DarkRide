import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { pruneOldData } from './prune';

vi.mock('fs/promises', () => ({ unlink: vi.fn().mockResolvedValue(undefined) }));
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn().mockReturnValue(false), unlinkSync: vi.fn() };
});
vi.mock('../logs', () => ({ createLoggers: () => ({ log: vi.fn(), error: vi.fn() }) }));

import { createTestDb } from '../test-utils/create-test-db';

const { automationSessions, capturedTraffic, websocketMessages } = schema;

function daysAgo(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

// Regression: a long-lived capture-rule session can start before the prune
// cutoff yet keep producing traffic/WS rows timestamped AFTER the cutoff. The
// child deletes filter by their own timestamp, so those newer rows survive —
// then the session delete (filtered by startedAt) throws FOREIGN KEY because a
// child still references it. With foreign_keys=ON the whole prune aborts and
// recurs failing every night. pruneOldData must mop up children by the exact
// session set being deleted before removing the sessions.
describe('pruneOldData with foreign_keys ON', () => {
  let db: BetterSQLite3Database<typeof schema>;

  beforeEach(() => {
    db = createTestDb(undefined, { foreignKeys: true });
    vi.clearAllMocks();
  });

  it('deletes a stale session whose child traffic is newer than the cutoff', async () => {
    // Session started 40 days ago; still active — captured a request TODAY.
    db.insert(automationSessions).values({ id: 1, status: 'running', triggerType: 'capture', startedAt: daysAgo(40) }).run();
    db.insert(capturedTraffic).values({ id: 100, sessionId: 1, requestMethod: 'GET', requestUrl: 'https://x/y', capturedAt: new Date() }).run();
    db.insert(websocketMessages).values({ id: 200, trafficId: 100, sessionId: 1, direction: 'receive', opcode: 'text', timestamp: new Date() }).run();

    // pruneDays = 30 → cutoff 30 days ago. Must not throw.
    await expect(pruneOldData(db, 30, '/tmp/shots')).resolves.toBeUndefined();

    expect(db.select().from(automationSessions).all()).toHaveLength(0);
    expect(db.select().from(capturedTraffic).all()).toHaveLength(0);
    expect(db.select().from(websocketMessages).all()).toHaveLength(0);
  });

  it('deletes a stale session whose WS frame has a null sessionId but references its traffic', async () => {
    // A WS frame can carry sessionId=NULL (capture context unresolved at frame
    // time) yet still reference, via trafficId, a captured_traffic row owned by
    // the doomed session. The sessionId-based mop-up misses it, so the traffic
    // delete would throw FK unless we also sweep WS by trafficId.
    db.insert(automationSessions).values({ id: 3, status: 'running', triggerType: 'capture', startedAt: daysAgo(40) }).run();
    db.insert(capturedTraffic).values({ id: 300, sessionId: 3, requestMethod: 'GET', requestUrl: 'https://x/w', capturedAt: new Date() }).run();
    db.insert(websocketMessages).values({ id: 301, trafficId: 300, sessionId: null, direction: 'receive', opcode: 'text', timestamp: new Date() }).run();

    await expect(pruneOldData(db, 30, '/tmp/shots')).resolves.toBeUndefined();

    expect(db.select().from(automationSessions).all()).toHaveLength(0);
    expect(db.select().from(capturedTraffic).all()).toHaveLength(0);
    expect(db.select().from(websocketMessages).all()).toHaveLength(0);
  });

  it('leaves a pinned stale session (and its newer children) intact', async () => {
    db.insert(automationSessions).values({ id: 2, status: 'running', triggerType: 'capture', isPinned: true, startedAt: daysAgo(40) }).run();
    db.insert(capturedTraffic).values({ id: 101, sessionId: 2, requestMethod: 'GET', requestUrl: 'https://x/z', capturedAt: new Date() }).run();

    await expect(pruneOldData(db, 30, '/tmp/shots')).resolves.toBeUndefined();

    expect(db.select().from(automationSessions).all()).toHaveLength(1);
    expect(db.select().from(capturedTraffic).all()).toHaveLength(1);
  });
});
