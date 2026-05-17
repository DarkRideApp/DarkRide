import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import express from 'express';
import { WebSocket } from 'ws';
import { setupWebSocket, getConnectedClients } from './index';
import { registerEndpoint, clearEndpoints } from '../api/api-service';
import { registerWebsocketEndpoint, clearWebsocketHandlers } from './handlers';

let httpServer: HttpServer;
let port: number;

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

beforeAll(async () => {
  clearEndpoints();
  clearWebsocketHandlers();

  const app = express();
  app.use(express.json());
  httpServer = createServer(app);
  setupWebSocket(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
});

beforeEach(() => {
  clearEndpoints();
  clearWebsocketHandlers();
});

describe('WebSocket Server', () => {
  it('should accept connections', async () => {
    const ws = await connectWs();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(getConnectedClients().size).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  it('rejects a WS upgrade from a disallowed Origin (CSWSH defence)', async () => {
    // Origin from a hostile site; not in any plausible default allowlist.
    // The ws library surfaces a non-101 upgrade response through the
    // `unexpected-response` event (some versions raise `error` instead).
    // Either path is acceptable; the only failure mode is the connection
    // succeeding.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`, {
        headers: { Origin: 'http://evil.example' },
      });
      ws.on('open', () => {
        ws.close();
        reject(new Error('Expected rejection, got open'));
      });
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(403);
        resolve();
      });
      ws.on('error', () => {
        // Reject path that doesn't surface as unexpected-response — fine.
        resolve();
      });
    });
  });

  it('accepts a WS upgrade from an allow-listed Origin (Vite dev port)', async () => {
    // Default allowlist always includes http://localhost:5173 (the Vite dev
    // port) so the dev experience works out of the box. Use that here to
    // avoid depending on the random test port.
    const ws = new WebSocket(`ws://localhost:${port}/ws`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('should clean up on disconnect', async () => {
    const ws = await connectWs();
    const sizeBefore = getConnectedClients().size;
    ws.close();
    // Wait for close event to propagate
    await new Promise((r) => setTimeout(r, 100));
    expect(getConnectedClients().size).toBe(sizeBefore - 1);
  });

  it('should return error for invalid JSON', async () => {
    const ws = await connectWs();
    ws.send('not json');
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.error).toBe('Invalid JSON');
    ws.close();
  });

  it('should return error for missing action', async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({ foo: 'bar' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.error).toBe('Missing action field');
    ws.close();
  });

  it('should return error for unknown action', async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({ action: 'nonexistent' }));
    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('error');
    expect(msg.error).toContain('Unknown action');
    ws.close();
  });
});

describe('REST-over-WebSocket routing', () => {
  it('should route restapi action to registered endpoint and return response with matching id', async () => {
    registerEndpoint('GET', '/v1/proxy/list', (_req, res) => {
      res.json([{ id: 1, url: 'http://proxy.com' }]);
    });

    const ws = await connectWs();
    ws.send(JSON.stringify({
      action: 'restapi',
      method: 'GET',
      path: '/v1/proxy/list',
      body: null,
      id: 'req-123',
    }));

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('restapi');
    expect(msg.id).toBe('req-123');
    expect(msg.status).toBe(200);
    expect(msg.body).toEqual([{ id: 1, url: 'http://proxy.com' }]);
    ws.close();
  });

  it('should handle path params in WebSocket restapi requests', async () => {
    registerEndpoint('GET', '/v1/proxy/view/:id', (req, res) => {
      res.json({ proxyId: req.params.id });
    });

    const ws = await connectWs();
    ws.send(JSON.stringify({
      action: 'restapi',
      method: 'GET',
      path: '/v1/proxy/view/42',
      body: null,
      id: 'req-456',
    }));

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('restapi');
    expect(msg.id).toBe('req-456');
    expect(msg.body).toEqual({ proxyId: '42' });
    ws.close();
  });

  it('should handle POST with body over WebSocket', async () => {
    registerEndpoint('POST', '/v1/items', (req, res) => {
      res.status(201).json({ name: req.body.name });
    });

    const ws = await connectWs();
    ws.send(JSON.stringify({
      action: 'restapi',
      method: 'POST',
      path: '/v1/items',
      body: { name: 'new item' },
      id: 'req-789',
    }));

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('restapi');
    expect(msg.id).toBe('req-789');
    expect(msg.status).toBe(201);
    expect(msg.body).toEqual({ name: 'new item' });
    ws.close();
  });

  it('should return 404 for unregistered WebSocket restapi paths', async () => {
    const ws = await connectWs();
    ws.send(JSON.stringify({
      action: 'restapi',
      method: 'GET',
      path: '/v1/nonexistent',
      body: null,
      id: 'req-404',
    }));

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('restapi');
    expect(msg.id).toBe('req-404');
    expect(msg.status).toBe(404);
    ws.close();
  });
});

describe('WebSocket-only endpoints', () => {
  it('should route to registered WebSocket handlers', async () => {
    registerWebsocketEndpoint('ping', (_message, socket) => {
      socket.send(JSON.stringify({ type: 'pong' }));
    });

    const ws = await connectWs();
    ws.send(JSON.stringify({ action: 'ping' }));

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('pong');
    ws.close();
  });

  it('should pass full message to handler', async () => {
    registerWebsocketEndpoint('echo', (message, socket) => {
      socket.send(JSON.stringify({ type: 'echo', data: message.data }));
    });

    const ws = await connectWs();
    ws.send(JSON.stringify({ action: 'echo', data: 'hello' }));

    const msg = await waitForMessage(ws);
    expect(msg.type).toBe('echo');
    expect(msg.data).toBe('hello');
    ws.close();
  });
});
