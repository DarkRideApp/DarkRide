import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerTrafficEndpoints, resetFilterRules, wsFlowMap } from './traffic';
import { TrafficHookRegistry } from '../services/traffic-hook-registry';
import { importSessionHar } from '../services/session-import';
import { createTestDb } from '../test-utils/create-test-db';

// Mock broadcastToAll
const mockBroadcastToAll = vi.fn();
vi.mock('../websocket/index', () => ({
  broadcastToAll: (...args: any[]) => mockBroadcastToAll(...args),
}));

const { capturedTraffic, devices, websocketMessages } = schema;

function createApp(db: BetterSQLite3Database<typeof schema>) {
  clearEndpoints();
  registerTrafficEndpoints(db as any);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Traffic API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    resetFilterRules();
    mockBroadcastToAll.mockClear();
    wsFlowMap.clear();
    app = createApp(db);
  });

  describe('POST /v1/traffic/ingest', () => {
    it('should ingest traffic data', async () => {
      const res = await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: {
            method: 'GET',
            url: 'https://api.example.com/data',
            headers: { 'Content-Type': 'application/json' },
            body: null,
          },
          response: {
            status: 200,
            body: '{"ok":true}',
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.filtered).toBe(false);

      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic).toHaveLength(1);
      expect(traffic[0].requestMethod).toBe('GET');
      expect(traffic[0].requestUrl).toBe('https://api.example.com/data');
      expect(traffic[0].responseStatus).toBe(200);
    });

    it('should return 400 for invalid data', async () => {
      const res = await request(app)
        .post('/v1/traffic/ingest')
        .send({ request: { method: null, url: null } });

      expect(res.status).toBe(400);
    });

    it('should ingest with sessionId and deviceId', async () => {
      db.insert(devices).values({ id: 'DEV001', name: 'Test' }).run();

      const res = await request(app)
        .post('/v1/traffic/ingest')
        .send({
          deviceId: 'DEV001',
          request: { method: 'POST', url: 'https://api.example.com/submit', headers: {}, body: '{}' },
          response: { status: 201, body: '{"id":1}' },
        });

      expect(res.status).toBe(200);
      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic[0].deviceId).toBe('DEV001');
    });

    it('should filter traffic based on hostname rule', async () => {
      // Add a filter rule first
      await request(app)
        .post('/v1/traffic/rules')
        .send({ hostname: 'ads\\.example\\.com' });

      const res = await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: { method: 'GET', url: 'https://ads.example.com/track', headers: {} },
          response: { status: 200, body: '' },
        });

      expect(res.status).toBe(200);
      expect(res.body.filtered).toBe(true);

      // Should not be stored
      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic).toHaveLength(0);
    });

    it('should filter traffic based on maxContentSize rule', async () => {
      // Add rule: ignore responses over 100 bytes
      await request(app)
        .post('/v1/traffic/rules')
        .send({ maxContentSize: 100 });

      const largeBody = 'x'.repeat(200);

      const res = await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: { method: 'GET', url: 'https://api.example.com/large', headers: {} },
          response: { status: 200, body: largeBody },
        });

      expect(res.body.filtered).toBe(true);
    });

    it('should broadcast traffic-entry via WebSocket after ingest', async () => {
      await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: {
            method: 'GET',
            url: 'https://api.example.com/broadcast-test',
            headers: { 'Accept': 'application/json' },
          },
          response: {
            status: 200,
            body: '{"test":true}',
          },
          deviceId: null,
          sessionId: null,
        });

      expect(mockBroadcastToAll).toHaveBeenCalledOnce();
      const broadcastArg = mockBroadcastToAll.mock.calls[0][0];
      expect(broadcastArg.type).toBe('traffic-entry');
      expect(broadcastArg.entry.requestMethod).toBe('GET');
      expect(broadcastArg.entry.requestUrl).toBe('https://api.example.com/broadcast-test');
      expect(broadcastArg.entry.responseStatus).toBe(200);
      expect(broadcastArg.entry.id).toBeDefined();
    });

    it('should truncate large responseBody in broadcast', async () => {
      const largeBody = 'x'.repeat(20000);

      await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: { method: 'GET', url: 'https://api.example.com/large', headers: {} },
          response: { status: 200, body: largeBody },
        });

      expect(mockBroadcastToAll).toHaveBeenCalledOnce();
      const broadcastArg = mockBroadcastToAll.mock.calls[0][0];
      expect(broadcastArg.entry.responseBody.length).toBeLessThan(largeBody.length);
      expect(broadcastArg.entry.responseBody).toContain('…[truncated]');
    });

    it('should not broadcast when traffic is filtered', async () => {
      await request(app)
        .post('/v1/traffic/rules')
        .send({ hostname: 'ads\\.example\\.com' });

      await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: { method: 'GET', url: 'https://ads.example.com/track', headers: {} },
          response: { status: 200, body: '' },
        });

      expect(mockBroadcastToAll).not.toHaveBeenCalled();
    });

    it('should not filter traffic that does not match rules', async () => {
      await request(app)
        .post('/v1/traffic/rules')
        .send({ hostname: 'ads\\.example\\.com' });

      const res = await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: { method: 'GET', url: 'https://api.example.com/data', headers: {} },
          response: { status: 200, body: '{}' },
        });

      expect(res.body.filtered).toBe(false);
      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic).toHaveLength(1);
    });
  });

  describe('GET /v1/traffic/list', () => {
    beforeEach(() => {
      // Seed some traffic data
      const now = new Date();
      const earlier = new Date(now.getTime() - 60000);

      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        responseStatus: 200,
        responseBody: '{"ok":true}',
        capturedAt: now,
      }).run();

      db.insert(capturedTraffic).values({
        requestMethod: 'POST',
        requestUrl: 'https://api.other.com/submit',
        responseStatus: 201,
        responseBody: '{"id":1}',
        capturedAt: earlier,
      }).run();

      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/error',
        responseStatus: 500,
        capturedAt: earlier,
      }).run();
    });

    it('should return all traffic with pagination', async () => {
      const res = await request(app).get('/v1/traffic/list');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(3);
      expect(res.body.data.total).toBe(3);
    });

    it('should support limit and offset', async () => {
      const res = await request(app).get('/v1/traffic/list?limit=1&offset=0');

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.limit).toBe(1);
      expect(res.body.data.offset).toBe(0);
    });

    it('should filter by method', async () => {
      const res = await request(app).get('/v1/traffic/list?method=POST');

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].requestMethod).toBe('POST');
    });

    it('should filter by status', async () => {
      const res = await request(app).get('/v1/traffic/list?status=500');

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].responseStatus).toBe(500);
    });

    it('should filter by hostname regex', async () => {
      const res = await request(app).get('/v1/traffic/list?hostname=other\\.com');

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].requestUrl).toContain('other.com');
    });

    it('should filter by path regex', async () => {
      const res = await request(app).get('/v1/traffic/list?path=%2Ferror');

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].requestUrl).toContain('/error');
    });

    it('should combine multiple filters', async () => {
      const res = await request(app).get('/v1/traffic/list?method=GET&status=200');

      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].requestUrl).toBe('https://api.example.com/data');
    });

    it('should sort by bodySize', async () => {
      const res = await request(app).get('/v1/traffic/list?sortBy=bodySize');

      expect(res.body.data.items).toHaveLength(3);
      // First item should have longest responseBody
      const firstBodyLen = res.body.data.items[0].responseBody ? res.body.data.items[0].responseBody.length : 0;
      const lastBodyLen = res.body.data.items[2].responseBody ? res.body.data.items[2].responseBody.length : 0;
      expect(firstBodyLen).toBeGreaterThanOrEqual(lastBodyLen);
    });
  });

  describe('GET /v1/traffic/view/:id', () => {
    it('should return traffic entry details', async () => {
      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/data',
        responseStatus: 200,
        responseBody: '{"hello":"world"}',
        capturedAt: new Date(),
      }).run();

      const res = await request(app).get('/v1/traffic/view/1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.requestUrl).toBe('https://api.example.com/data');
    });

    it('should return 404 for non-existent entry', async () => {
      const res = await request(app).get('/v1/traffic/view/999');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /v1/traffic/search', () => {
    beforeEach(() => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60000);

      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://myapp.com/v1/data',
        responseStatus: 200,
        responseBody: '{"latest": true}',
        capturedAt: now,
      }).run();

      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://myapp.com/v1/data',
        responseStatus: 200,
        responseBody: '{"latest": false}',
        capturedAt: earlier,
      }).run();

      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://myapp.com/v1/data',
        responseStatus: 500,
        capturedAt: earlier,
      }).run();
    });

    it('should find latest successful request matching URL pattern', async () => {
      const res = await request(app).get('/v1/traffic/search?url=myapp\\.com%2Fv1%2Fdata');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.responseBody).toBe('{"latest": true}');
    });

    it('should filter by specific status code', async () => {
      const res = await request(app).get('/v1/traffic/search?url=myapp\\.com&status=500');

      expect(res.status).toBe(200);
      expect(res.body.data.responseStatus).toBe(500);
    });

    it('should return 404 when no match', async () => {
      const res = await request(app).get('/v1/traffic/search?url=nonexistent\\.com');
      expect(res.status).toBe(404);
    });

    it('should return 400 when url param is missing', async () => {
      const res = await request(app).get('/v1/traffic/search');
      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid regex', async () => {
      const res = await request(app).get('/v1/traffic/search?url=[invalid');
      expect(res.status).toBe(400);
    });

    it('should still find a match when other rows have huge bodies (SQL push-down regression)', async () => {
      // Insert 100 large-body rows that don't match the search.
      // Old implementation loaded them all into heap before filtering;
      // the regression guard is that the match is still found + fast.
      const hugeBody = 'x'.repeat(200_000);
      for (let i = 0; i < 100; i++) {
        db.insert(capturedTraffic).values({
          requestMethod: 'GET',
          requestUrl: `https://unrelated-${i}.example.net/data`,
          responseStatus: 200,
          responseBody: hugeBody,
          capturedAt: new Date(Date.now() - 1000 * (i + 1)),
        }).run();
      }

      const res = await request(app).get('/v1/traffic/search?url=myapp\\.com%2Fv1%2Fdata');
      expect(res.status).toBe(200);
      expect(res.body.data.responseBody).toBe('{"latest": true}');
    });
  });

  describe('Traffic Filter Rules API', () => {
    describe('GET /v1/traffic/rules', () => {
      it('should return empty array initially', async () => {
        const res = await request(app).get('/v1/traffic/rules');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      });
    });

    describe('POST /v1/traffic/rules', () => {
      it('should add a filter rule', async () => {
        const res = await request(app)
          .post('/v1/traffic/rules')
          .send({ hostname: '.*\\.google\\.com' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.data.hostname).toBe('.*\\.google\\.com');
        expect(res.body.data.id).toBe(1);
      });

      it('should add a rule with multiple conditions', async () => {
        const res = await request(app)
          .post('/v1/traffic/rules')
          .send({ hostname: '.*\\.google\\.com', maxContentSize: 2097152 });

        expect(res.status).toBe(201);
        expect(res.body.data.hostname).toBe('.*\\.google\\.com');
        expect(res.body.data.maxContentSize).toBe(2097152);
      });

      it('should return 400 with no conditions', async () => {
        const res = await request(app)
          .post('/v1/traffic/rules')
          .send({});

        expect(res.status).toBe(400);
      });
    });

    describe('DELETE /v1/traffic/rules/:id', () => {
      it('should remove a rule', async () => {
        await request(app)
          .post('/v1/traffic/rules')
          .send({ hostname: 'test' });

        const res = await request(app).delete('/v1/traffic/rules/1');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const list = await request(app).get('/v1/traffic/rules');
        expect(list.body).toHaveLength(0);
      });

      it('should return 404 for non-existent rule', async () => {
        const res = await request(app).delete('/v1/traffic/rules/999');
        expect(res.status).toBe(404);
      });
    });
  });

  describe('WebSocket Traffic Endpoints', () => {
    describe('POST /v1/traffic/ws-start', () => {
      it('should create a websocket traffic entry', async () => {
        const res = await request(app)
          .post('/v1/traffic/ws-start')
          .send({
            flowId: 'flow-123',
            url: 'wss://api.example.com/ws',
            headers: { 'Upgrade': 'websocket' },
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const traffic = db.select().from(capturedTraffic).all();
        expect(traffic).toHaveLength(1);
        expect(traffic[0].type).toBe('websocket');
        expect(traffic[0].requestUrl).toBe('wss://api.example.com/ws');
        expect(traffic[0].responseStatus).toBe(101);
        expect(traffic[0].wsMessageCount).toBe(0);
      });

      it('should broadcast traffic-entry with websocket type', async () => {
        await request(app)
          .post('/v1/traffic/ws-start')
          .send({ flowId: 'flow-456', url: 'wss://example.com/ws', headers: {} });

        expect(mockBroadcastToAll).toHaveBeenCalledOnce();
        const msg = mockBroadcastToAll.mock.calls[0][0];
        expect(msg.type).toBe('traffic-entry');
        expect(msg.entry.trafficType).toBe('websocket');
        expect(msg.entry.responseStatus).toBe(101);
      });

      it('should return 400 without flowId', async () => {
        const res = await request(app)
          .post('/v1/traffic/ws-start')
          .send({ url: 'wss://example.com/ws' });
        expect(res.status).toBe(400);
      });
    });

    describe('POST /v1/traffic/ws-message', () => {
      beforeEach(async () => {
        await request(app)
          .post('/v1/traffic/ws-start')
          .send({ flowId: 'flow-msg', url: 'wss://example.com/ws', headers: {} });
        mockBroadcastToAll.mockClear();
      });

      it('should insert a websocket message', async () => {
        const res = await request(app)
          .post('/v1/traffic/ws-message')
          .send({
            flowId: 'flow-msg',
            direction: 'receive',
            opcode: 'text',
            payload: '{"hello":"world"}',
            isBinary: false,
            payloadSize: 17,
          });

        expect(res.status).toBe(200);
        const messages = db.select().from(websocketMessages).all();
        expect(messages).toHaveLength(1);
        expect(messages[0].direction).toBe('receive');
        expect(messages[0].payload).toBe('{"hello":"world"}');
      });

      it('should increment wsMessageCount on parent', async () => {
        await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'flow-msg', direction: 'send', opcode: 'text', payload: 'a', payloadSize: 1 });

        await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'flow-msg', direction: 'receive', opcode: 'text', payload: 'b', payloadSize: 1 });

        const traffic = db.select().from(capturedTraffic).all();
        expect(traffic[0].wsMessageCount).toBe(2);
      });

      it('should broadcast ws-frame message', async () => {
        await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'flow-msg', direction: 'send', opcode: 'text', payload: 'test', payloadSize: 4 });

        expect(mockBroadcastToAll).toHaveBeenCalledOnce();
        const msg = mockBroadcastToAll.mock.calls[0][0];
        expect(msg.type).toBe('ws-frame');
        expect(msg.frame.direction).toBe('send');
        expect(msg.frame.payload).toBe('test');
      });

      it('should return 404 for unknown flow', async () => {
        const res = await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'unknown', direction: 'send', opcode: 'text', payload: 'x', payloadSize: 1 });
        expect(res.status).toBe(404);
      });
    });

    describe('POST /v1/traffic/ws-end', () => {
      beforeEach(async () => {
        await request(app)
          .post('/v1/traffic/ws-start')
          .send({ flowId: 'flow-end', url: 'wss://example.com/ws', headers: {} });
        mockBroadcastToAll.mockClear();
      });

      it('should update close code and reason', async () => {
        const res = await request(app)
          .post('/v1/traffic/ws-end')
          .send({ flowId: 'flow-end', closeCode: 1000, closeReason: 'Normal closure', messageCount: 5 });

        expect(res.status).toBe(200);
        const traffic = db.select().from(capturedTraffic).all();
        expect(traffic[0].wsCloseCode).toBe(1000);
        expect(traffic[0].wsCloseReason).toBe('Normal closure');
        expect(traffic[0].wsMessageCount).toBe(5);
      });

      it('should broadcast ws-connection-closed', async () => {
        await request(app)
          .post('/v1/traffic/ws-end')
          .send({ flowId: 'flow-end', closeCode: 1000, closeReason: 'done', messageCount: 3 });

        expect(mockBroadcastToAll).toHaveBeenCalledOnce();
        const msg = mockBroadcastToAll.mock.calls[0][0];
        expect(msg.type).toBe('ws-connection-closed');
        expect(msg.closeCode).toBe(1000);
        expect(msg.messageCount).toBe(3);
      });

      it('should remove flow from map', async () => {
        await request(app)
          .post('/v1/traffic/ws-end')
          .send({ flowId: 'flow-end', closeCode: 1000, messageCount: 0 });

        // Trying to send a message now should fail
        const res = await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'flow-end', direction: 'send', opcode: 'text', payload: 'x', payloadSize: 1 });
        expect(res.status).toBe(404);
      });

      it('should return 404 for unknown flow', async () => {
        const res = await request(app)
          .post('/v1/traffic/ws-end')
          .send({ flowId: 'nonexistent', closeCode: 1000, messageCount: 0 });
        expect(res.status).toBe(404);
      });
    });

    describe('GET /v1/traffic/ws-messages/:trafficId', () => {
      beforeEach(async () => {
        await request(app)
          .post('/v1/traffic/ws-start')
          .send({ flowId: 'flow-list', url: 'wss://example.com/ws', headers: {} });

        await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'flow-list', direction: 'send', opcode: 'text', payload: 'msg1', payloadSize: 4 });
        await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'flow-list', direction: 'receive', opcode: 'text', payload: 'msg2', payloadSize: 4 });
        await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'flow-list', direction: 'send', opcode: 'binary', payload: 'base64data', isBinary: true, payloadSize: 10 });
        mockBroadcastToAll.mockClear();
      });

      it('should return paginated frames', async () => {
        const traffic = db.select().from(capturedTraffic).all();
        const trafficId = traffic[0].id;

        const res = await request(app).get(`/v1/traffic/ws-messages/${trafficId}`);
        expect(res.status).toBe(200);
        expect(res.body.data.items).toHaveLength(3);
        expect(res.body.data.total).toBe(3);
      });

      it('should filter by direction', async () => {
        const traffic = db.select().from(capturedTraffic).all();
        const trafficId = traffic[0].id;

        const res = await request(app).get(`/v1/traffic/ws-messages/${trafficId}?direction=send`);
        expect(res.body.data.items).toHaveLength(2);
      });

      it('should support limit and offset', async () => {
        const traffic = db.select().from(capturedTraffic).all();
        const trafficId = traffic[0].id;

        const res = await request(app).get(`/v1/traffic/ws-messages/${trafficId}?limit=1&offset=1`);
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.total).toBe(3);
      });
    });

    describe('GET /v1/traffic/list with type filter', () => {
      beforeEach(async () => {
        db.insert(capturedTraffic).values({
          requestMethod: 'GET',
          requestUrl: 'https://api.example.com/data',
          responseStatus: 200,
          capturedAt: new Date(),
        }).run();

        await request(app)
          .post('/v1/traffic/ws-start')
          .send({ flowId: 'flow-type', url: 'wss://example.com/ws', headers: {} });
        mockBroadcastToAll.mockClear();
      });

      it('should filter by type=websocket', async () => {
        const res = await request(app).get('/v1/traffic/list?type=websocket');
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.items[0].type).toBe('websocket');
      });

      it('should filter by type=http', async () => {
        const res = await request(app).get('/v1/traffic/list?type=http');
        expect(res.body.data.items).toHaveLength(1);
        expect(res.body.data.items[0].type).toBe('http');
      });

      it('should return all when no type filter', async () => {
        const res = await request(app).get('/v1/traffic/list');
        expect(res.body.data.items).toHaveLength(2);
      });
    });

    describe('GET /v1/traffic/view/:id for websocket', () => {
      it('should include wsMessages for websocket entries', async () => {
        await request(app)
          .post('/v1/traffic/ws-start')
          .send({ flowId: 'flow-view', url: 'wss://example.com/ws', headers: {} });

        await request(app)
          .post('/v1/traffic/ws-message')
          .send({ flowId: 'flow-view', direction: 'send', opcode: 'text', payload: 'hello', payloadSize: 5 });

        const traffic = db.select().from(capturedTraffic).all();
        const res = await request(app).get(`/v1/traffic/view/${traffic[0].id}`);
        expect(res.status).toBe(200);
        expect(res.body.data.wsMessages).toBeDefined();
        expect(res.body.data.wsMessages).toHaveLength(1);
        expect(res.body.data.wsMessages[0].payload).toBe('hello');
      });
    });
  });

  describe('POST /v1/traffic/request-started', () => {
    it('should broadcast traffic-request-started message', async () => {
      const res = await request(app)
        .post('/v1/traffic/request-started')
        .send({
          flowId: 'flow-abc-123',
          deviceId: 'DEV001',
          sessionId: null,
          method: 'GET',
          url: 'https://api.example.com/slow',
          headers: { 'Accept': 'application/json' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(mockBroadcastToAll).toHaveBeenCalledOnce();
      const msg = mockBroadcastToAll.mock.calls[0][0];
      expect(msg.type).toBe('traffic-request-started');
      expect(msg.flowId).toBe('flow-abc-123');
      expect(msg.deviceId).toBe('DEV001');
      expect(msg.requestMethod).toBe('GET');
      expect(msg.requestUrl).toBe('https://api.example.com/slow');
      expect(msg.requestHeaders).toBe(JSON.stringify({ 'Accept': 'application/json' }));
      expect(msg.timestamp).toBeDefined();
    });

    it('should return 400 without flowId', async () => {
      const res = await request(app)
        .post('/v1/traffic/request-started')
        .send({ url: 'https://example.com' });

      expect(res.status).toBe(400);
    });

    it('should return 400 without url', async () => {
      const res = await request(app)
        .post('/v1/traffic/request-started')
        .send({ flowId: 'flow-1' });

      expect(res.status).toBe(400);
    });

    it('should skip broadcast for hidden domains', async () => {
      // Insert a hidden domain
      db.insert(schema.hiddenDomains).values({ domain: 'hidden.example.com', createdAt: new Date() }).run();

      const res = await request(app)
        .post('/v1/traffic/request-started')
        .send({
          flowId: 'flow-hidden',
          deviceId: null,
          sessionId: null,
          method: 'GET',
          url: 'https://hidden.example.com/api',
          headers: {},
        });

      expect(res.status).toBe(200);
      expect(res.body.hidden).toBe(true);
      expect(mockBroadcastToAll).not.toHaveBeenCalled();
    });

    it('should skip broadcast for subdomain of hidden domain', async () => {
      db.insert(schema.hiddenDomains).values({ domain: 'example.com', createdAt: new Date() }).run();

      const res = await request(app)
        .post('/v1/traffic/request-started')
        .send({
          flowId: 'flow-sub',
          url: 'https://sub.example.com/path',
          method: 'POST',
          headers: {},
        });

      expect(res.status).toBe(200);
      expect(res.body.hidden).toBe(true);
      expect(mockBroadcastToAll).not.toHaveBeenCalled();
    });

    it('should not persist anything to the database', async () => {
      await request(app)
        .post('/v1/traffic/request-started')
        .send({
          flowId: 'flow-no-persist',
          url: 'https://api.example.com/test',
          method: 'GET',
          headers: {},
        });

      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic).toHaveLength(0);
    });
  });

  describe('POST /v1/traffic/ingest flowId in broadcast', () => {
    it('should include flowId in traffic-entry broadcast when id is present', async () => {
      await request(app)
        .post('/v1/traffic/ingest')
        .send({
          id: 'mitmproxy-flow-xyz',
          request: {
            method: 'GET',
            url: 'https://api.example.com/data',
            headers: {},
          },
          response: {
            status: 200,
            body: '{"ok":true}',
          },
        });

      expect(mockBroadcastToAll).toHaveBeenCalledOnce();
      const msg = mockBroadcastToAll.mock.calls[0][0];
      expect(msg.entry.flowId).toBe('mitmproxy-flow-xyz');
    });

    it('should have undefined flowId when id is not in body', async () => {
      await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: {
            method: 'GET',
            url: 'https://api.example.com/data',
            headers: {},
          },
          response: {
            status: 200,
            body: '{}',
          },
        });

      expect(mockBroadcastToAll).toHaveBeenCalledOnce();
      const msg = mockBroadcastToAll.mock.calls[0][0];
      expect(msg.entry.flowId).toBeUndefined();
    });
  });

  describe('POST /v1/traffic/intercept', () => {
    it('returns pass when no registry provided', async () => {
      // Default app has no registry
      const res = await request(app)
        .post('/v1/traffic/intercept')
        .send({ deviceId: 'dev-1', phase: 'request', guid: 'f1', method: 'GET', url: 'https://example.com', hostname: 'example.com', path: '/', headers: {}, body: null });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('pass');
    });

    it('returns pass when no hooks registered', async () => {
      const registry = new TrafficHookRegistry();
      clearEndpoints();
      registerTrafficEndpoints(db as any, registry);
      const appWithRegistry = express();
      appWithRegistry.use(express.json());
      appWithRegistry.use(getApiRouter());

      const res = await request(appWithRegistry)
        .post('/v1/traffic/intercept')
        .send({ deviceId: 'dev-1', phase: 'request', guid: 'f1', method: 'GET', url: 'https://example.com', hostname: 'example.com', path: '/', headers: {}, body: null });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('pass');
    });

    it('returns modify when matching hook modifies request', async () => {
      const registry = new TrafficHookRegistry();
      registry.registerHook('dev-1', { hostname: /example/ }, async (req) => {
        return { ...req, headers: { ...req.headers, 'X-Injected': 'yes' } };
      });

      clearEndpoints();
      registerTrafficEndpoints(db as any, registry);
      const appWithRegistry = express();
      appWithRegistry.use(express.json());
      appWithRegistry.use(getApiRouter());

      const res = await request(appWithRegistry)
        .post('/v1/traffic/intercept')
        .send({ deviceId: 'dev-1', phase: 'request', guid: 'f1', method: 'GET', url: 'https://example.com/path', hostname: 'example.com', path: '/path', headers: {}, body: null });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('modify');
      expect(res.body.headers['X-Injected']).toBe('yes');
    });

    it('returns block when matching hook blocks', async () => {
      const registry = new TrafficHookRegistry();
      registry.registerHook('dev-1', { hostname: /example/ }, async () => null);

      clearEndpoints();
      registerTrafficEndpoints(db as any, registry);
      const appWithRegistry = express();
      appWithRegistry.use(express.json());
      appWithRegistry.use(getApiRouter());

      const res = await request(appWithRegistry)
        .post('/v1/traffic/intercept')
        .send({ deviceId: 'dev-1', phase: 'request', guid: 'f1', method: 'GET', url: 'https://example.com', hostname: 'example.com', path: '/', headers: {}, body: null });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('block');
    });

    it('returns pass when deviceId is missing', async () => {
      const registry = new TrafficHookRegistry();
      registry.registerHook('dev-1', { hostname: /example/ }, async () => null);

      clearEndpoints();
      registerTrafficEndpoints(db as any, registry);
      const appWithRegistry = express();
      appWithRegistry.use(express.json());
      appWithRegistry.use(getApiRouter());

      const res = await request(appWithRegistry)
        .post('/v1/traffic/intercept')
        .send({ phase: 'request', guid: 'f1', method: 'GET', url: 'https://example.com', hostname: 'example.com', path: '/', headers: {}, body: null });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('pass');
    });

    it('handles response phase', async () => {
      const registry = new TrafficHookRegistry();
      registry.registerHook('dev-1', { hostname: /example/ }, undefined, async (resp) => {
        return { ...resp, status: 418 };
      });

      clearEndpoints();
      registerTrafficEndpoints(db as any, registry);
      const appWithRegistry = express();
      appWithRegistry.use(express.json());
      appWithRegistry.use(getApiRouter());

      const res = await request(appWithRegistry)
        .post('/v1/traffic/intercept')
        .send({ deviceId: 'dev-1', phase: 'response', guid: 'f1', method: 'GET', url: 'https://example.com', hostname: 'example.com', path: '/', headers: {}, body: null, status: 200, responseHeaders: {}, responseBody: 'ok' });

      expect(res.status).toBe(200);
      expect(res.body.action).toBe('modify');
      expect(res.body.status).toBe(418);
    });
  });

  describe('Hostname extraction at ingest', () => {
    it('should extract hostname from URL and store it', async () => {
      await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: { method: 'GET', url: 'https://api.example.com/v1/users', headers: {} },
          response: { status: 200, body: '{}' },
        });

      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic).toHaveLength(1);
      expect(traffic[0].hostname).toBe('api.example.com');
    });

    it('should set hostname to null for an invalid URL', async () => {
      await request(app)
        .post('/v1/traffic/ingest')
        .send({
          request: { method: 'GET', url: 'not-a-valid-url', headers: {} },
          response: { status: 200, body: '{}' },
        });

      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic).toHaveLength(1);
      expect(traffic[0].hostname).toBeNull();
    });
  });

  describe('Hostname SQL push-down on /v1/traffic/list', () => {
    beforeEach(() => {
      const now = new Date();

      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://api.example.com/v1/users',
        hostname: 'api.example.com',
        responseStatus: 200,
        responseBody: '{"users":[]}',
        capturedAt: now,
      }).run();

      db.insert(capturedTraffic).values({
        requestMethod: 'POST',
        requestUrl: 'https://cdn.example.com/assets/main.js',
        hostname: 'cdn.example.com',
        responseStatus: 200,
        responseBody: 'var x=1;',
        capturedAt: new Date(now.getTime() - 1000),
      }).run();

      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://api.other.io/health',
        hostname: 'api.other.io',
        responseStatus: 200,
        responseBody: '{"ok":true}',
        capturedAt: new Date(now.getTime() - 2000),
      }).run();

      db.insert(capturedTraffic).values({
        requestMethod: 'GET',
        requestUrl: 'https://unrelated.net/page',
        hostname: 'unrelated.net',
        responseStatus: 200,
        responseBody: '<html></html>',
        capturedAt: new Date(now.getTime() - 3000),
      }).run();
    });

    it('should filter by plain hostname via SQL LIKE (no regex metacharacters)', async () => {
      const res = await request(app).get('/v1/traffic/list?hostname=api.example.com');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0].requestUrl).toBe('https://api.example.com/v1/users');
      expect(res.body.data.total).toBe(1);
    });

    it('should filter by regex hostname via JS fallback', async () => {
      const res = await request(app).get('/v1/traffic/list?hostname=.*example.*');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
      const urls = res.body.data.items.map((i: any) => i.requestUrl);
      expect(urls).toContain('https://api.example.com/v1/users');
      expect(urls).toContain('https://cdn.example.com/assets/main.js');
    });

    it('should return empty array for non-matching hostname', async () => {
      const res = await request(app).get('/v1/traffic/list?hostname=nonexistent.com');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(0);
      expect(res.body.data.total).toBe(0);
    });

    it('should use SQL path for simple subdomain substring match', async () => {
      // "example.com" is a plain hostname (no regex meta), so it goes through SQL LIKE
      const res = await request(app).get('/v1/traffic/list?hostname=example.com');

      expect(res.status).toBe(200);
      // LIKE %example.com% matches both api.example.com and cdn.example.com
      expect(res.body.data.items).toHaveLength(2);
    });

    it('should use JS fallback for hostname with regex pipe operator', async () => {
      const res = await request(app).get('/v1/traffic/list?hostname=api\\.example\\.com|api\\.other\\.io');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(2);
      const urls = res.body.data.items.map((i: any) => i.requestUrl);
      expect(urls).toContain('https://api.example.com/v1/users');
      expect(urls).toContain('https://api.other.io/health');
    });
  });

  describe('HAR import hostname extraction', () => {
    it('should populate hostname on imported HAR entries', () => {
      const harJson = {
        log: {
          entries: [
            {
              startedDateTime: '2026-01-01T00:00:00Z',
              request: { method: 'GET', url: 'https://imported.example.com/api/data', headers: [] },
              response: { status: 200, headers: [], content: { text: '{}' } },
            },
            {
              startedDateTime: '2026-01-01T00:00:01Z',
              request: { method: 'POST', url: 'https://other-host.io/submit', headers: [] },
              response: { status: 201, headers: [], content: { text: '{"id":1}' } },
            },
          ],
        },
      };

      const result = importSessionHar(db, harJson, 'Test HAR');
      expect(result.trafficCount).toBe(2);

      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic).toHaveLength(2);

      const hostnames = traffic.map((t) => t.hostname).sort();
      expect(hostnames).toEqual(['imported.example.com', 'other-host.io']);
    });

    it('should set hostname to null for invalid URLs in HAR entries', () => {
      const harJson = {
        log: {
          entries: [
            {
              startedDateTime: '2026-01-01T00:00:00Z',
              request: { method: 'GET', url: 'not-a-url', headers: [] },
              response: { status: 200, headers: [], content: { text: '' } },
            },
          ],
        },
      };

      const result = importSessionHar(db, harJson, 'Bad URL HAR');
      expect(result.trafficCount).toBe(1);

      const traffic = db.select().from(capturedTraffic).all();
      expect(traffic[0].hostname).toBeNull();
    });
  });
});
