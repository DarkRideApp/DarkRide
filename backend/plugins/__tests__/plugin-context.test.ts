import { describe, it, expect, vi } from 'vitest';
import { PluginContextImpl } from '../plugin-context';
import { HookBusImpl } from '@darkrideapp/plugin-sdk';

vi.mock('../../api/api-service', () => ({
  registerEndpoint: vi.fn(),
}));

function createTestContext(name = 'test-plugin') {
  const hookBus = new HookBusImpl();
  const collected = {
    nav: [] as any[],
    pages: [] as any[],
    routes: [] as any[],
    aiTools: [] as any[],
    aiContexts: [] as any[],
    tools: [] as any[],
    toolContexts: [] as any[],
    jobs: [] as any[],
    settings: [] as any[],
    commands: [] as any[],
    notificationEvents: [] as any[],
    protocolDecoders: [] as any[],
    dbTables: {} as Record<string, unknown>,
  };
  const ctx = new PluginContextImpl(name, hookBus, collected);
  return { ctx, hookBus, collected };
}

describe('PluginContextImpl', () => {
  it('collects nav items', () => {
    const { ctx, collected } = createTestContext();
    ctx.nav([{ group: 'Tools', label: 'Test', path: '/test', icon: 'box' }]);
    expect(collected.nav).toHaveLength(1);
    expect(collected.nav[0].group).toBe('Tools');
  });

  it('collects AI tools', () => {
    const { ctx, collected } = createTestContext();
    ctx.aiTools([{
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {},
      context: ['test'],
      execute: async () => ({}),
    }]);
    expect(collected.aiTools).toHaveLength(1);
    expect(collected.aiTools[0].name).toBe('test_tool');
  });

  it('collects settings', () => {
    const { ctx, collected } = createTestContext();
    ctx.settingsDefs([{ key: 'test_key', label: 'Test Key', type: 'string' }]);
    expect(collected.settings).toHaveLength(1);
  });

  it('exposes hook bus with define/on', () => {
    const { ctx, hookBus } = createTestContext();
    const handler = vi.fn();
    ctx.hooks.define('test-plugin:ready', { status: 'string' });
    ctx.hooks.on('some:event', handler);

    hookBus.emit('some:event', { data: 1 });

    expect(handler).toHaveBeenCalledWith({ data: 1 });
    expect(hookBus.getDefinedHooks()).toContainEqual({
      name: 'test-plugin:ready',
      schema: { status: 'string' },
    });
  });

  it('collects routes setup function', () => {
    const { ctx, collected } = createTestContext();
    const setup = vi.fn();
    ctx.routes(setup);
    expect(collected.routes).toHaveLength(1);
    expect(collected.routes[0]).toBe(setup);
  });

  it('collects tools', () => {
    const { ctx, collected } = createTestContext();
    ctx.tools([{
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {},
      contexts: ['test'],
      execute: async () => ({}),
    }]);
    expect(collected.tools).toHaveLength(1);
    expect(collected.tools[0].name).toBe('test_tool');
  });

  it('collects tool contexts', () => {
    const { ctx, collected } = createTestContext();
    ctx.toolContexts([{ id: 'test', label: 'Test', tools: ['test_tool'] }]);
    expect(collected.toolContexts).toHaveLength(1);
  });

  describe('ctx.api()', () => {
    it('invokes the setup callback with an object that has all HTTP method helpers', async () => {
      const { registerEndpoint } = await import('../../api/api-service');
      const { ctx } = createTestContext();

      let capturedApi: any;
      ctx.api((api) => { capturedApi = api; });

      expect(typeof capturedApi.get).toBe('function');
      expect(typeof capturedApi.post).toBe('function');
      expect(typeof capturedApi.put).toBe('function');
      expect(typeof capturedApi.delete).toBe('function');
      expect(typeof capturedApi.patch).toBe('function');
    });

    it('delegates api.get() to registerEndpoint with GET verb', async () => {
      const { registerEndpoint } = await import('../../api/api-service');
      const { ctx } = createTestContext();
      const handler = vi.fn();
      const opts = { requires: ['some:scope'] };

      ctx.api((api) => {
        api.get('/test/path', handler, opts);
      });

      expect(registerEndpoint).toHaveBeenCalledWith('GET', '/test/path', handler, opts);
    });

    it('delegates api.post() to registerEndpoint with POST verb', async () => {
      const { registerEndpoint } = await import('../../api/api-service');
      const { ctx } = createTestContext();
      const handler = vi.fn();

      ctx.api((api) => { api.post('/test/create', handler); });

      expect(registerEndpoint).toHaveBeenCalledWith('POST', '/test/create', handler, undefined);
    });

    it('delegates api.put() to registerEndpoint with PUT verb', async () => {
      const { registerEndpoint } = await import('../../api/api-service');
      const { ctx } = createTestContext();
      const handler = vi.fn();

      ctx.api((api) => { api.put('/test/:id', handler); });

      expect(registerEndpoint).toHaveBeenCalledWith('PUT', '/test/:id', handler, undefined);
    });

    it('delegates api.delete() to registerEndpoint with DELETE verb', async () => {
      const { registerEndpoint } = await import('../../api/api-service');
      const { ctx } = createTestContext();
      const handler = vi.fn();

      ctx.api((api) => { api.delete('/test/:id', handler); });

      expect(registerEndpoint).toHaveBeenCalledWith('DELETE', '/test/:id', handler, undefined);
    });

    it('delegates api.patch() to registerEndpoint with PATCH verb', async () => {
      const { registerEndpoint } = await import('../../api/api-service');
      const { ctx } = createTestContext();
      const handler = vi.fn();

      ctx.api((api) => { api.patch('/test/:id', handler); });

      expect(registerEndpoint).toHaveBeenCalledWith('PATCH', '/test/:id', handler, undefined);
    });
  });

  describe('ctx.dispatcher', () => {
    it('throws a clear error when accessed before wiring', () => {
      const { ctx } = createTestContext();
      expect(() => ctx.dispatcher).toThrow('ctx.dispatcher not available until plugin is fully loaded');
    });

    it('returns the wired api after setDispatcherApi()', () => {
      const { ctx } = createTestContext();
      const fakeDispatcher = { register: vi.fn(), unregister: vi.fn(), dispatch: vi.fn() } as any;
      ctx.setDispatcherApi(fakeDispatcher);
      expect(ctx.dispatcher).toBe(fakeDispatcher);
    });
  });
});
