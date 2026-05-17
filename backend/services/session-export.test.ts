import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as schema from '../db/schema';
import { buildHarJson, exportSessionHar, exportSessionZip } from './session-export';
import type { AppDatabase } from '../db/index';
import { createTestDb } from '../test-utils/create-test-db';

const { automationSessions, capturedTraffic, websocketMessages } = schema;

// Mock broadcastToAll
vi.mock('../websocket/index', () => ({
  broadcastToAll: vi.fn(),
}));

describe('session-export', () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  function insertSession(overrides: Partial<{ logs: string }> = {}) {
    const now = new Date();
    db.insert(schema.automationSessions)
      .values({
        automationId: null,
        deviceId: 'DEV001',
        status: 'success',
        triggerType: 'capture',
        startedAt: now,
        completedAt: now,
        ...overrides,
      })
      .run();
    return db.select().from(schema.automationSessions).all()[0];
  }

  describe('buildHarJson', () => {
    it('returns null for non-existent session', () => {
      expect(buildHarJson(db, 999)).toBeNull();
    });

    it('builds valid HAR with no traffic', () => {
      const session = insertSession();
      const result = buildHarJson(db, session.id);

      expect(result).not.toBeNull();
      expect(result!.har.log.version).toBe('1.2');
      expect(result!.har.log.creator.name).toBe('DarkRide');
      expect(result!.har.log.entries).toEqual([]);
      expect(result!.session.id).toBe(session.id);
    });

    it('builds HAR entries from captured traffic', () => {
      const session = insertSession();
      const now = new Date();

      db.insert(schema.capturedTraffic)
        .values({
          sessionId: session.id,
          deviceId: 'DEV001',
          requestMethod: 'POST',
          requestUrl: 'https://api.example.com/data',
          requestHeaders: JSON.stringify({ 'Content-Type': 'application/json' }),
          requestBody: '{"key":"value"}',
          responseStatus: 200,
          responseBody: '{"ok":true}',
          capturedAt: now,
        })
        .run();

      db.insert(schema.capturedTraffic)
        .values({
          sessionId: session.id,
          deviceId: 'DEV001',
          requestMethod: 'GET',
          requestUrl: 'https://example.com/',
          responseStatus: 301,
          capturedAt: now,
        })
        .run();

      const result = buildHarJson(db, session.id)!;
      expect(result.har.log.entries).toHaveLength(2);

      const entry0 = result.har.log.entries[0];
      expect(entry0.request.method).toBe('POST');
      expect(entry0.request.url).toBe('https://api.example.com/data');
      expect(entry0.request.headers).toEqual([
        { name: 'Content-Type', value: 'application/json' },
      ]);
      expect(entry0.request.postData).toEqual({
        mimeType: 'application/octet-stream',
        text: '{"key":"value"}',
      });
      expect(entry0.response.status).toBe(200);
      expect(entry0.response.content.text).toBe('{"ok":true}');

      const entry1 = result.har.log.entries[1];
      expect(entry1.request.method).toBe('GET');
      expect(entry1.response.status).toBe(301);
    });

    it('handles request headers in array format', () => {
      const session = insertSession();
      const now = new Date();

      db.insert(schema.capturedTraffic)
        .values({
          sessionId: session.id,
          deviceId: 'DEV001',
          requestMethod: 'GET',
          requestUrl: 'https://example.com',
          requestHeaders: JSON.stringify([
            { name: 'Accept', value: 'text/html' },
          ]),
          responseStatus: 200,
          capturedAt: now,
        })
        .run();

      const result = buildHarJson(db, session.id)!;
      expect(result.har.log.entries[0].request.headers).toEqual([
        { name: 'Accept', value: 'text/html' },
      ]);
    });

    it('handles invalid JSON in request headers', () => {
      const session = insertSession();
      const now = new Date();

      db.insert(schema.capturedTraffic)
        .values({
          sessionId: session.id,
          deviceId: 'DEV001',
          requestMethod: 'GET',
          requestUrl: 'https://example.com',
          requestHeaders: 'not-json',
          responseStatus: 200,
          capturedAt: now,
        })
        .run();

      const result = buildHarJson(db, session.id)!;
      expect(result.har.log.entries[0].request.headers).toEqual([]);
    });

    it('should include _webSocketMessages for websocket traffic in HAR', () => {
      // Insert session
      db.insert(automationSessions).values({
        status: 'success',
        triggerType: 'manual',
        startedAt: new Date(),
        completedAt: new Date(),
      }).run();

      // Insert websocket traffic
      db.insert(capturedTraffic).values({
        sessionId: 1,
        requestMethod: 'GET',
        requestUrl: 'wss://example.com/ws',
        responseStatus: 101,
        type: 'websocket',
        capturedAt: new Date(),
      }).run();

      // Insert frames
      db.insert(websocketMessages).values({
        trafficId: 1,
        sessionId: 1,
        direction: 'send',
        opcode: 'text',
        payload: '{"action":"subscribe"}',
        payloadSize: 22,
        timestamp: new Date(),
      }).run();

      db.insert(websocketMessages).values({
        trafficId: 1,
        sessionId: 1,
        direction: 'receive',
        opcode: 'text',
        payload: '{"event":"update"}',
        payloadSize: 18,
        timestamp: new Date(),
      }).run();

      const result = buildHarJson(db as any, 1);
      expect(result).not.toBeNull();
      const entry = result!.har.log.entries[0];
      expect(entry._webSocketMessages).toBeDefined();
      expect(entry._webSocketMessages).toHaveLength(2);
      expect(entry._webSocketMessages[0].type).toBe('send');
      expect(entry._webSocketMessages[0].opcode).toBe(1); // text
      expect(entry._webSocketMessages[1].type).toBe('receive');
    });
  });

  describe('exportSessionHar', () => {
    it('returns false for non-existent session', () => {
      const mockRes = createMockResponse();
      const found = exportSessionHar(db, 999, mockRes as any);
      expect(found).toBe(false);
    });

    it('sends HAR JSON with correct headers', () => {
      const session = insertSession();
      const mockRes = createMockResponse();

      const found = exportSessionHar(db, session.id, mockRes as any);
      expect(found).toBe(true);
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        `attachment; filename=session-${session.id}.har`,
      );
      expect(mockRes.send).toHaveBeenCalled();

      const sent = JSON.parse(mockRes.send.mock.calls[0][0]);
      expect(sent.log.version).toBe('1.2');
    });
  });

  describe('exportSessionZip', () => {
    it('returns false for non-existent session', async () => {
      const mockRes = createMockResponse();
      const found = await exportSessionZip(db, 999, '/tmp/test-ss', mockRes as any);
      expect(found).toBe(false);
    });

    it('streams a ZIP archive with correct headers', async () => {
      const session = insertSession({ logs: JSON.stringify([{ timestamp: new Date().toISOString(), method: 'click' }]) });
      const mockRes = createMockResponse();

      const found = await exportSessionZip(db, session.id, '/tmp/nonexistent-screenshots', mockRes as any);
      expect(found).toBe(true);
      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'application/zip');
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        `attachment; filename=session-${session.id}.zip`,
      );
      // archiver.pipe() was called, and data was written
      expect(mockRes.chunks.length).toBeGreaterThan(0);
    });
  });
});

function createMockResponse() {
  const chunks: Buffer[] = [];
  const res: any = {
    setHeader: vi.fn(),
    send: vi.fn(),
    chunks,
    // Writable stream interface for archiver.pipe()
    write: vi.fn((chunk: any) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }),
    end: vi.fn(),
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    emit: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    // Required by Node writable stream checks
    writable: true,
    headersSent: false,
  };
  return res;
}
