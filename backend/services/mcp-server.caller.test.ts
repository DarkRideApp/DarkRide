import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { clearEndpoints, registerEndpoint } from '../api/api-service';
import { AiToolRegistry } from './ai-tools';
import { registerApiGetTool } from './api-get-tool';
import { mountMcpSseServer } from './mcp-server';

// mountMcpSseServer only reads the mcp_enabled setting from the db.
const fakeDb: any = {
  select: () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) }),
};

function appWith(authUser: any) {
  const registry = new AiToolRegistry();
  registerApiGetTool(registry);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authUser) (req as any).authUser = authUser;
    next();
  });
  mountMcpSseServer(app, registry, fakeDb);
  return app;
}

/** The streamable transport answers with either JSON or one SSE frame. */
function parseRpc(res: request.Response): any {
  if (res.headers['content-type']?.includes('application/json')) return res.body;
  const line = res.text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line!.slice('data: '.length));
}

function callApiGet(app: express.Express, args: Record<string, unknown>) {
  return request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'darkride_api_get', arguments: args },
    });
}

describe('darkride_api_get over MCP', () => {
  beforeEach(() => {
    clearEndpoints();
    registerEndpoint('GET', '/disney-menus/status', (req, res) => {
      res.json({ who: req.authUser?.username, via: req.authUser?.via });
    });
    registerEndpoint('GET', '/v1/credentials/list', (_req, res) => {
      res.json({ data: [{ password: 'hunter2' }] });
    });
  });

  it('hands the authenticated MCP user to the route as its caller', async () => {
    const app = appWith({
      userId: 4,
      username: 'cube',
      via: 'apikey',
      effectiveScopes: new Set(['core.admin:*']),
    });
    const res = await callApiGet(app, { path: '/disney-menus/status' });
    expect(res.status).toBe(200);
    const rpc = parseRpc(res);
    expect(rpc.result.isError).toBeUndefined();
    expect(JSON.parse(rpc.result.content[0].text)).toEqual({
      status: 200,
      body: { who: 'cube', via: 'apikey' },
    });
  });

  it('refuses a credentials route even for an admin', async () => {
    const app = appWith({
      userId: 4,
      username: 'cube',
      via: 'apikey',
      effectiveScopes: new Set(['core.admin:*']),
    });
    const rpc = parseRpc(await callApiGet(app, { path: '/v1/credentials/list' }));
    const out = JSON.parse(rpc.result.content[0].text);
    expect(out.status).toBe(403);
    expect(rpc.result.content[0].text).not.toContain('hunter2');
  });

  it('reports a bad path as a tool error, not a crash', async () => {
    const app = appWith({
      userId: 4,
      username: 'cube',
      via: 'apikey',
      effectiveScopes: new Set(['core.admin:*']),
    });
    const rpc = parseRpc(await callApiGet(app, { path: '//evil.example/x' }));
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result.content[0].text).toMatch(/Invalid path/);
  });

  it('answers 401 without an authenticated user', async () => {
    const res = await callApiGet(appWith(undefined), { path: '/disney-menus/status' });
    expect(res.status).toBe(401);
  });
});
