import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'http';
import request from 'supertest';
import express from 'express';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerProxiedRequestEndpoints } from './proxied-requests';
import { ProxiedRequestService } from '../services/proxied-request-service';
import { createTestDb } from '../test-utils/create-test-db';

// Mock DNS lookup so SSRF check doesn't block the loopback echo server used in tests
vi.mock('dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('dns')>();
  return {
    ...original,
    lookup: (_hostname: string, callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
      // Return a public IP for all test lookups — avoids false-positive SSRF blocks
      callback(null, '93.184.216.34', 4);
    },
  };
});

let echoServer: http.Server;
let echoPort: number;

beforeAll(async () => {
  echoServer = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/redirected' });
      res.end();
      return;
    }
    if (req.url === '/redirected') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ redirected: true }));
      return;
    }
    if (req.url === '/echo' || req.url?.startsWith('/echo')) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body || null,
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => {
    echoServer.listen(0, '127.0.0.1', () => {
      echoPort = (echoServer.address() as any).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => echoServer.close(() => resolve()));
});

function createApp(db: BetterSQLite3Database<typeof schema>, service: ProxiedRequestService) {
  clearEndpoints();
  registerProxiedRequestEndpoints(db as any, service);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('Proxied Request API Endpoints', () => {
  let db: BetterSQLite3Database<typeof schema>;
  let service: ProxiedRequestService;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    service = new ProxiedRequestService(db as any, { maxConcurrency: 5 });
    service.start();
    app = createApp(db, service);
  });

  describe('POST /v1/proxied-request', () => {
    it('should reject missing url', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ proxy: { type: 'inline', url: 'http://proxy:8080' } });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('url is required');
    });

    it('should reject invalid url', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ url: 'not-a-url', proxy: { type: 'inline', url: 'http://proxy:8080' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('not a valid URL');
    });

    it('should reject missing proxy', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ url: 'http://example.com' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('proxy is required');
    });

    it('should reject invalid proxy type', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ url: 'http://example.com', proxy: { type: 'invalid' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('proxy.type');
    });

    it('should reject proxyId type with non-integer id', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ url: 'http://example.com', proxy: { type: 'proxyId', proxyId: 'abc' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('proxyId must be an integer');
    });

    it('should reject nordvpn type without country', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ url: 'http://example.com', proxy: { type: 'nordvpn' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('country is required');
    });

    it('should reject inline type without url', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ url: 'http://example.com', proxy: { type: 'inline' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('proxy.url is required');
    });

    it('should reject inline type with invalid proxy url', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ url: 'http://example.com', proxy: { type: 'inline', url: 'bad-url' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('proxy.url is not a valid URL');
    });

    it('should reject captureSession type without deviceId', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({ url: 'http://example.com', proxy: { type: 'captureSession' } });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('proxy.deviceId is required');
    });

    it('should accept captureSession type and fall back to direct when not capturing', async () => {
      // No egress resolver wired on the service → device is "not capturing" →
      // the request still runs (direct) and reaches the echo server.
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({
          url: `http://127.0.0.1:${echoPort}/echo`,
          proxy: { type: 'captureSession', deviceId: 'DEV001' },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(200);
    });

    it('should reject an invalid tlsProfile value', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({
          url: 'http://example.com',
          proxy: { type: 'direct' },
          tlsProfile: 'safari',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tlsProfile');
    });

    it('should accept a valid tlsProfile value', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({
          url: `http://127.0.0.1:${echoPort}/echo`,
          proxy: { type: 'direct' },
          tlsProfile: 'chrome',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should return 502 on proxy/network error (sync)', async () => {
      const res = await request(app)
        .post('/v1/proxied-request')
        .send({
          url: `http://127.0.0.1:${echoPort}/echo`,
          proxy: { type: 'proxyId', proxyId: 999 },
        });

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });

    it('should return 202 with job for async mode', async () => {
      const res = await request(app)
        .post('/v1/proxied-request?async=true')
        .send({
          url: `http://127.0.0.1:${echoPort}/echo`,
          proxy: { type: 'inline', url: `http://127.0.0.1:${echoPort}` },
        });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBeTruthy();
      expect(['pending', 'running']).toContain(res.body.data.status);
    });
  });

  describe('GET /v1/proxied-request/job/:id', () => {
    it('should return 404 for non-existent job', async () => {
      const res = await request(app).get('/v1/proxied-request/job/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('should return job details', async () => {
      // Create an async job
      const postRes = await request(app)
        .post('/v1/proxied-request?async=true')
        .send({
          url: `http://127.0.0.1:${echoPort}/echo`,
          proxy: { type: 'inline', url: `http://127.0.0.1:${echoPort}` },
        });

      const jobId = postRes.body.data.id;
      const res = await request(app).get(`/v1/proxied-request/job/${jobId}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(jobId);
    });
  });

  describe('POST /v1/proxied-request/batch', () => {
    it('should reject non-array requests', async () => {
      const res = await request(app)
        .post('/v1/proxied-request/batch')
        .send({ requests: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('must be an array');
    });

    it('should reject empty requests array', async () => {
      const res = await request(app)
        .post('/v1/proxied-request/batch')
        .send({ requests: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('must not be empty');
    });

    it('should reject more than 100 requests', async () => {
      const requests = Array.from({ length: 101 }, (_, i) => ({
        url: `http://example.com/${i}`,
        proxy: { type: 'inline', url: 'http://proxy:8080' },
      }));

      const res = await request(app)
        .post('/v1/proxied-request/batch')
        .send({ requests });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Maximum 100');
    });

    it('should reject if any request in batch is invalid', async () => {
      const res = await request(app)
        .post('/v1/proxied-request/batch')
        .send({
          requests: [
            { url: 'http://example.com', proxy: { type: 'inline', url: 'http://proxy:8080' } },
            { url: 'bad-url', proxy: { type: 'inline', url: 'http://proxy:8080' } },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('index 1');
    });

    it('should return 202 with jobs for async batch', async () => {
      const res = await request(app)
        .post('/v1/proxied-request/batch')
        .send({
          requests: [
            { url: `http://127.0.0.1:${echoPort}/echo?i=0`, proxy: { type: 'inline', url: `http://127.0.0.1:${echoPort}` } },
            { url: `http://127.0.0.1:${echoPort}/echo?i=1`, proxy: { type: 'inline', url: `http://127.0.0.1:${echoPort}` } },
          ],
          async: true,
        });

      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.jobs).toHaveLength(2);
      expect(res.body.data.jobs[0].index).toBe(0);
      expect(res.body.data.jobs[0].jobId).toBeTruthy();
      expect(res.body.data.jobs[1].index).toBe(1);
    });
  });

  describe('GET /v1/proxied-request/status', () => {
    it('should return service status', async () => {
      const res = await request(app).get('/v1/proxied-request/status');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('queueLength');
      expect(res.body.data).toHaveProperty('activeCount');
      expect(res.body.data).toHaveProperty('maxConcurrency');
      expect(res.body.data.maxConcurrency).toBe(5);
    });
  });
});
