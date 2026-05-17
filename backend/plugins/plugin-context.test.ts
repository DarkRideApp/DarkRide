import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HookBusImpl } from '@darkrideapp/plugin-sdk';
import { PluginContextImpl, createEmptyContributions } from '../plugins/plugin-context';
import { __resetPluginScopesForTests, isSupportedScope } from '../auth/scopes-registry';
import { createLoggers } from '../logs';

describe('ctx.ai', () => {
  let ctx: PluginContextImpl;
  let fakeFactory: any;

  beforeEach(() => {
    fakeFactory = {
      forPluginInternal: vi.fn((name, scopes) => ({
        identity: { identityType: 'plugin', actorUserId: 1, effectiveScopes: scopes, onBehalfOfPlugin: name },
        handleMessage: vi.fn(),
      })),
      forPluginActingForInternal: vi.fn((name, uid, scopes) => ({
        identity: {
          identityType: 'plugin-acting-for-user',
          actorUserId: uid,
          effectiveScopes: ['core.apk:read'],
          onBehalfOfPlugin: name,
          actingForUserId: uid,
        },
        handleMessage: vi.fn(),
      })),
    };
    ctx = new PluginContextImpl('example', new HookBusImpl(), createEmptyContributions());
    ctx.setAiFactory(fakeFactory);
    ctx.setAiScopes(['mcp', 'core.apk:read']);
  });

  it('agent() returns a bound plugin agent', () => {
    const agent = ctx.ai.agent();
    expect(agent.identity.identityType).toBe('plugin');
    expect(agent.identity.onBehalfOfPlugin).toBe('example');
    expect(agent.identity.effectiveScopes).toEqual(['mcp', 'core.apk:read']);
    expect(fakeFactory.forPluginInternal).toHaveBeenCalledWith('example', ['mcp', 'core.apk:read'], undefined);
  });

  it('forUser() returns an intersected agent tagged for delegation', () => {
    const agent = ctx.ai.forUser(42);
    expect(agent.identity.identityType).toBe('plugin-acting-for-user');
    expect(agent.identity.actingForUserId).toBe(42);
    expect(agent.identity.onBehalfOfPlugin).toBe('example');
    expect(fakeFactory.forPluginActingForInternal).toHaveBeenCalledWith('example', 42, ['mcp', 'core.apk:read'], undefined);
  });

  it('throws from agent() when plugin has no aiScopes', () => {
    const bare = new PluginContextImpl('no-ai', new HookBusImpl(), createEmptyContributions());
    bare.setAiFactory(fakeFactory);
    bare.setAiScopes([]);
    expect(() => bare.ai.agent()).toThrow(/no-ai.*aiScopes/i);
  });

  it('throws from forUser() when plugin has no aiScopes', () => {
    const bare = new PluginContextImpl('no-ai', new HookBusImpl(), createEmptyContributions());
    bare.setAiFactory(fakeFactory);
    bare.setAiScopes([]);
    expect(() => bare.ai.forUser(42)).toThrow(/no-ai.*aiScopes/i);
  });

  it('agent({ tier }) threads tier option to the factory', () => {
    ctx.ai.agent({ tier: 'Low' });
    expect(fakeFactory.forPluginInternal).toHaveBeenCalledWith('example', ['mcp', 'core.apk:read'], { tier: 'Low' });
  });

  it('forUser({ tier }) threads tier option to the factory', () => {
    ctx.ai.forUser(42, { tier: 'Low' });
    expect(fakeFactory.forPluginActingForInternal).toHaveBeenCalledWith('example', 42, ['mcp', 'core.apk:read'], { tier: 'Low' });
  });

  it('listTiers() returns tier info from the injected store', () => {
    const fakeStore = {
      list: vi.fn().mockReturnValue([
        { id: 1, name: 'High', sortOrder: 0, isHardcoded: true, enabledModelCount: 2, createdAt: 0, updatedAt: 0 },
        { id: 2, name: 'Low', sortOrder: 1, isHardcoded: true, enabledModelCount: 0, createdAt: 0, updatedAt: 0 },
      ]),
    };
    ctx.setAiTierStore(fakeStore as any);
    expect(ctx.ai.listTiers()).toEqual([
      { name: 'High', sortOrder: 0, isHardcoded: true, enabledModelCount: 2 },
      { name: 'Low', sortOrder: 1, isHardcoded: true, enabledModelCount: 0 },
    ]);
  });
});

describe('ctx.logger', () => {
  it('returns a logger object with log and error', () => {
    const ctx = new PluginContextImpl('ctxlogger-plugin-a', new HookBusImpl(), createEmptyContributions());
    const logger = ctx.logger();
    expect(typeof logger.log).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('scopes by pluginName when no subsystem given', () => {
    // createLoggers caches by systemId — ctx.logger() must register under
    // the plugin name so other call sites requesting that id get the
    // same instance.
    const ctx = new PluginContextImpl('ctxlogger-plugin-b', new HookBusImpl(), createEmptyContributions());
    expect(ctx.logger()).toBe(createLoggers('ctxlogger-plugin-b'));
  });

  it('namespaces subsystem loggers as pluginName:subsystem', () => {
    const ctx = new PluginContextImpl('ctxlogger-plugin-c', new HookBusImpl(), createEmptyContributions());
    expect(ctx.logger('sync')).toBe(createLoggers('ctxlogger-plugin-c:sync'));
    expect(ctx.logger('replica')).toBe(createLoggers('ctxlogger-plugin-c:replica'));
  });

  it('caches per-subsystem — repeated calls return the same instance', () => {
    const ctx = new PluginContextImpl('ctxlogger-plugin-d', new HookBusImpl(), createEmptyContributions());
    expect(ctx.logger('x')).toBe(ctx.logger('x'));
    expect(ctx.logger()).toBe(ctx.logger());
  });
});

describe('ctx.scopes', () => {
  beforeEach(() => __resetPluginScopesForTests());

  it('registers scopes under the plugin prefix', () => {
    const ctx = new PluginContextImpl('widgets', new HookBusImpl(), createEmptyContributions());
    ctx.scopes([
      { key: 'plugin.widgets:read', label: 'Read', description: 'Read.', category: 'Widgets' },
    ]);
    expect(isSupportedScope('plugin.widgets:read')).toBe(true);
  });

  it('throws if plugin tries to register scopes outside its prefix', () => {
    const ctx = new PluginContextImpl('widgets', new HookBusImpl(), createEmptyContributions());
    expect(() =>
      ctx.scopes([{ key: 'plugin.other:write', label: 'x', description: 'x', category: 'x' }]),
    ).toThrow(/plugin\.widgets/);
  });
});

describe('PluginContextImpl — UI slots & contributions', () => {
  function makeCtx() {
    const hooks = new HookBusImpl();
    const collected = createEmptyContributions();
    const ctx = new PluginContextImpl('plug', hooks, collected);
    return { ctx, collected };
  }

  it('uiSlots captures declarations into collected.uiSlots', () => {
    const { ctx, collected } = makeCtx();
    ctx.uiSlots([
      { id: 'plug:surface:position', kind: 'container', description: 'demo slot' },
    ]);
    expect(collected.uiSlots).toEqual([
      { id: 'plug:surface:position', kind: 'container', description: 'demo slot' },
    ]);
  });

  it('uiContributions captures declarations into collected.uiContributions', () => {
    const { ctx, collected } = makeCtx();
    ctx.uiContributions([
      { slot: 'other:surface:position', id: 'plug:card', component: 'Card' },
    ]);
    expect(collected.uiContributions).toEqual([
      { slot: 'other:surface:position', id: 'plug:card', component: 'Card' },
    ]);
  });

  it('uiSlots and uiContributions append across multiple calls', () => {
    const { ctx, collected } = makeCtx();
    ctx.uiSlots([{ id: 'a', kind: 'container', description: 'a' }]);
    ctx.uiSlots([{ id: 'b', kind: 'container', description: 'b' }]);
    ctx.uiContributions([{ slot: 'a', id: 'c1', component: 'C1' }]);
    ctx.uiContributions([{ slot: 'b', id: 'c2', component: 'C2' }]);
    expect(collected.uiSlots.map(s => s.id)).toEqual(['a', 'b']);
    expect(collected.uiContributions.map(c => c.id)).toEqual(['c1', 'c2']);
  });
});

describe('PluginContextImpl service registry', () => {
  function makeCtx(name: string) {
    const stored = new Map<string, unknown>();
    const ctx = new PluginContextImpl(name, new HookBusImpl(), createEmptyContributions());
    ctx.setServiceRegistry({
      expose: (pluginName, impl) => {
        if (stored.has(pluginName)) throw new Error(`Plugin "${pluginName}" exposed twice`);
        stored.set(pluginName, impl);
      },
      peer: <T>(_caller: string, target: string) => {
        const v = stored.get(target);
        if (v === undefined) throw new Error(`Peer "${target}" not exposed`);
        return v as T;
      },
      has: (target) => stored.has(target),
    });
    return ctx;
  }

  it('exposeService stores impl; peer retrieves it with the requested type', () => {
    interface FooApi { greet(): string; }
    const ctx = makeCtx('foo');
    const impl: FooApi = { greet: () => 'hi' };
    ctx.exposeService<FooApi>(impl);
    const fetched = ctx.peer<FooApi>('foo');
    expect(fetched.greet()).toBe('hi');
  });

  it('hasPeer reflects whether a service has been exposed', () => {
    const ctx = makeCtx('bar');
    expect(ctx.hasPeer('bar')).toBe(false);
    ctx.exposeService({ x: 1 });
    expect(ctx.hasPeer('bar')).toBe(true);
  });

  it('exposeService throws if no registry wired', () => {
    const ctx = new PluginContextImpl('orphan', new HookBusImpl(), createEmptyContributions());
    expect(() => ctx.exposeService({})).toThrow(/registry not wired/i);
  });

  it('peer throws if no registry wired', () => {
    const ctx = new PluginContextImpl('orphan', new HookBusImpl(), createEmptyContributions());
    expect(() => ctx.peer('anything')).toThrow(/registry not wired/i);
  });

  it('hasPeer returns false if no registry wired', () => {
    const ctx = new PluginContextImpl('orphan', new HookBusImpl(), createEmptyContributions());
    expect(ctx.hasPeer('anything')).toBe(false);
  });
});
