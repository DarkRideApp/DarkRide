import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '../../test-utils/create-test-db';
import { settings as settingsSchema } from '../../db/schema';
import { mountMcpSseServer } from '../mcp-server';
import { AiToolRegistry } from '../ai-tools';

function authStub(scopes: string[]) {
  return (req: any, _res: any, next: any) => {
    req.authUser = {
      userId: 1,
      username: 'tester',
      effectiveScopes: new Set(scopes),
      via: 'test',
    };
    next();
  };
}

async function callMcp(app: express.Express, body: any) {
  // MCP HTTP Streamable transport expects these Accept headers; without them
  // the SDK responds 406 before the request handler runs.
  return request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
    .send(body);
}

function parseSse(body: string): any {
  // Streamable responses come back as a single SSE `data: { … }` line.
  const line = body.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`No SSE data line in body: ${body}`);
  return JSON.parse(line.slice('data: '.length));
}

describe('MCP server — unauthenticated response', () => {
  let app: express.Express;
  let db: any;
  let registry: AiToolRegistry;

  beforeEach(() => {
    db = createTestDb([settingsSchema]);
    registry = new AiToolRegistry();
    app = express();
    app.use(express.json());
    mountMcpSseServer(app, registry, db);
  });

  it('returns 401 with WWW-Authenticate header pointing to resource metadata', async () => {
    const res = await request(app).post('/mcp').send({});
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);
  });

  it('does not attempt to run MCP when no authUser', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(401);
  });
});

// ─── Regression: plugin-installed MCP tools must be live after one restart ─────
//
// Launch checklist #7 used to say "first plugin install that registers MCP
// tools needs two restarts (one to load, one to activate after permission
// accepted)." The architecture has since shifted to a stateless MCP server
// that reads the live `AiToolRegistry` on every request, so a plugin tool
// registered after the server is mounted (mirroring the index.ts boot
// sequence: mount MCP early, register plugin tools after pluginManager.startAll)
// must show up on the very next `tools/list` and be invocable via `tools/call`.
//
// This test pins that behaviour so a regression to the old snapshot-at-boot
// model would fail loudly.
describe('MCP server — plugin tool visibility after a single restart', () => {
  let app: express.Express;
  let db: any;
  let registry: AiToolRegistry;
  let pluginToolCalls: any[];

  beforeEach(() => {
    db = createTestDb([settingsSchema]);
    registry = new AiToolRegistry();
    pluginToolCalls = [];
    app = express();
    app.use(express.json());
    // Order mirrors backend/index.ts: MCP mounts BEFORE plugin tools register.
    app.use(authStub(['core.admin:*']));
    mountMcpSseServer(app, registry, db);

    // Now plugins "load" and contribute their tools (post-mount, like
    // index.ts:1075-1093 after pluginManager.startAll()).
    registry.register({
      name: 'demo-plugin.list_workflows',
      description: 'List GitHub Actions workflows for the watched repo',
      context: ['demo-plugin'],
      inputSchema: { type: 'object', properties: {} },
      execute: async (args: any) => {
        pluginToolCalls.push(args);
        return { workflows: ['ci.yml', 'release.yml'] };
      },
    });
  });

  it('lists plugin tools registered after MCP mount on first tools/list', async () => {
    const res = await callMcp(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(res.status).toBe(200);
    const payload = parseSse(res.text);
    const names = payload.result.tools.map((t: any) => t.name);
    expect(names).toContain('demo-plugin.list_workflows');
  });

  it('invokes plugin tools via tools/call on the same boot — no second restart', async () => {
    const res = await callMcp(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'demo-plugin.list_workflows',
        arguments: { dryRun: true },
      },
    });

    expect(res.status).toBe(200);
    const payload = parseSse(res.text);
    expect(payload.result.isError).not.toBe(true);
    expect(pluginToolCalls).toHaveLength(1);
    expect(pluginToolCalls[0]).toEqual({ dryRun: true });

    const text = payload.result.content[0].text;
    expect(JSON.parse(text)).toEqual({ workflows: ['ci.yml', 'release.yml'] });
  });

  it('reflects a tool registered AFTER the first tools/list, without remounting', async () => {
    // First request — only the initially-registered plugin tool is present.
    const firstList = await callMcp(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    });
    const firstNames = parseSse(firstList.text).result.tools.map((t: any) => t.name);
    expect(firstNames).toContain('demo-plugin.list_workflows');
    expect(firstNames).not.toContain('maps.refresh_tiles');

    // Simulate consent-grant-triggered tool registration: a plugin's tool
    // becomes available after the user approves its scopes, without a
    // server remount.
    registry.register({
      name: 'maps.refresh_tiles',
      description: 'Refresh map tile cache',
      context: ['maps'],
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    });

    const secondList = await callMcp(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: {},
    });
    const secondNames = parseSse(secondList.text).result.tools.map((t: any) => t.name);
    expect(secondNames).toContain('maps.refresh_tiles');
  });
});
