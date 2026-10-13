import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerToolApiEndpoints } from './tool-api';
import { AiToolRegistry } from '../services/ai-tools';

function createApp(registry: AiToolRegistry, scopes: string[] | null) {
  clearEndpoints();
  registerToolApiEndpoints(registry);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (scopes) {
      req.authUser = { userId: 1, username: 'u', via: 'apikey', effectiveScopes: new Set(scopes) };
    }
    next();
  });
  app.use(getApiRouter());
  return app;
}

describe('POST /v1/tools/:name', () => {
  const guarded = vi.fn(async (params: any) => ({ echoed: params }));
  const open = vi.fn(async () => 'ok');
  let registry: AiToolRegistry;

  beforeEach(() => {
    guarded.mockClear();
    open.mockClear();
    registry = new AiToolRegistry();
    registry.register({
      name: 'guarded_tool',
      description: 'needs a scope',
      inputSchema: { type: 'object', properties: {} },
      context: ['credentials'],
      requiredScope: 'core.credentials:read',
      execute: guarded,
    });
    registry.register({
      name: 'open_tool',
      description: 'no scope',
      inputSchema: { type: 'object', properties: {} },
      context: ['credentials'],
      execute: open,
    });
  });

  it('runs a tool when the caller holds its required scope', async () => {
    const res = await request(createApp(registry, ['core.credentials:read']))
      .post('/v1/tools/guarded_tool').send({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { echoed: { a: 1 } } });
  });

  it('accepts a wildcard scope that covers the requirement', async () => {
    const res = await request(createApp(registry, ['core.credentials:*']))
      .post('/v1/tools/guarded_tool').send({});
    expect(res.status).toBe(200);
  });

  it('refuses with 403 and does not run the tool when the scope is missing', async () => {
    const res = await request(createApp(registry, ['core.apk:read']))
      .post('/v1/tools/guarded_tool').send({});
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/core\.credentials:read/);
    expect(guarded).not.toHaveBeenCalled();
  });

  it('refuses a caller with no scopes at all', async () => {
    const res = await request(createApp(registry, []))
      .post('/v1/tools/guarded_tool').send({});
    expect(res.status).toBe(403);
    expect(guarded).not.toHaveBeenCalled();
  });

  it('refuses with 401 and runs nothing when the request carries no identity', async () => {
    const res = await request(createApp(registry, null))
      .post('/v1/tools/guarded_tool').send({});
    expect(res.status).toBe(401);
    expect(guarded).not.toHaveBeenCalled();
    const unguarded = await request(createApp(registry, null))
      .post('/v1/tools/open_tool').send({});
    expect(unguarded.status).toBe(401);
    expect(open).not.toHaveBeenCalled();
  });

  it('runs a tool that declares no required scope for any authenticated caller', async () => {
    const res = await request(createApp(registry, []))
      .post('/v1/tools/open_tool').send({});
    expect(res.status).toBe(200);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('still answers 404 for an unknown tool', async () => {
    const res = await request(createApp(registry, ['core.credentials:read']))
      .post('/v1/tools/nope').send({});
    expect(res.status).toBe(404);
  });

  it('still answers 500 when the tool itself throws', async () => {
    guarded.mockRejectedValueOnce(new Error('boom'));
    const res = await request(createApp(registry, ['core.credentials:read']))
      .post('/v1/tools/guarded_tool').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('boom');
  });
});
