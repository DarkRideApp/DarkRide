import { describe, it, expect } from 'vitest';
import { definePlugin } from '@darkrideapp/plugin-sdk';
import { PluginManager } from '../plugin-manager';

describe('PluginManager lifecycle — happy path', () => {
  it('startAll calls start() in topological order; stopAll in reverse', async () => {
    const calls: string[] = [];
    const mgr = new PluginManager();

    mgr.loadPlugin(definePlugin({
      name: 'a', version: '1.0.0',
      register: () => {},
      start: async () => { calls.push('start:a'); },
      stop: async () => { calls.push('stop:a'); },
    }));
    mgr.loadPlugin(definePlugin({
      name: 'b', version: '1.0.0',
      dependencies: ['a'],
      register: () => {},
      start: async () => { calls.push('start:b'); },
      stop: async () => { calls.push('stop:b'); },
    }));
    mgr.loadPlugin(definePlugin({
      name: 'c', version: '1.0.0',
      dependencies: ['b'],
      register: () => {},
      start: async () => { calls.push('start:c'); },
      stop: async () => { calls.push('stop:c'); },
    }));

    await mgr.startAll();
    expect(calls).toEqual(['start:a', 'start:b', 'start:c']);

    await mgr.stopAll();
    expect(calls).toEqual([
      'start:a', 'start:b', 'start:c',
      'stop:c', 'stop:b', 'stop:a',
    ]);
  });

  it('plugins without start()/stop() are skipped', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'no-lifecycle', version: '1.0.0', register: () => {},
    }));
    await expect(mgr.startAll()).resolves.toBeUndefined();
    await expect(mgr.stopAll()).resolves.toBeUndefined();
  });
});

describe('PluginManager lifecycle — failure modes', () => {
  it('rejects with structured error when start() throws', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'crashes', version: '1.0.0',
      register: () => {},
      start: async () => { throw new Error('boom'); },
    }));
    await expect(mgr.startAll()).rejects.toThrow(/Plugin "crashes" failed to start: boom/);
  });

  it('does not call subsequent plugins\' start() after a failure', async () => {
    const calls: string[] = [];
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'a', version: '1.0.0',
      register: () => {},
      start: async () => { calls.push('a'); throw new Error('boom'); },
    }));
    mgr.loadPlugin(definePlugin({
      name: 'b', version: '1.0.0',
      dependencies: ['a'],
      register: () => {},
      start: async () => { calls.push('b'); },
    }));
    await expect(mgr.startAll()).rejects.toThrow();
    expect(calls).toEqual(['a']);
  });

  it('rejects with timeout when start() exceeds startTimeoutMs', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'slow', version: '1.0.0',
      startTimeoutMs: 50,
      register: () => {},
      start: () => new Promise(() => {}), // never resolves
    }));
    await expect(mgr.startAll()).rejects.toThrow(/exceeded 50ms/);
  });

  it('cycle is detected (existing getLoadOrder behaviour, surfaced via startAll)', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'a', version: '1.0.0', dependencies: ['b'],
      register: () => {}, start: async () => {},
    }));
    mgr.loadPlugin(definePlugin({
      name: 'b', version: '1.0.0', dependencies: ['a'],
      register: () => {}, start: async () => {},
    }));
    await expect(mgr.startAll()).rejects.toThrow(/[Cc]ircular dependency/);
  });

  it('missing required dep is detected', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'consumer', version: '1.0.0', dependencies: ['ghost'],
      register: () => {}, start: async () => {},
    }));
    await expect(mgr.startAll()).rejects.toThrow(/Missing required dependency.*ghost/);
  });
});

describe('PluginManager lifecycle — service registry', () => {
  it('peer() succeeds when required dep has exposed', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'provider', version: '1.0.0',
      register: () => {},
      start: async (ctx) => { ctx.exposeService({ value: 42 }); },
    }));
    let observed: number | null = null;
    mgr.loadPlugin(definePlugin({
      name: 'consumer', version: '1.0.0',
      dependencies: ['provider'],
      register: () => {},
      start: async (ctx) => {
        const svc = ctx.peer<{ value: number }>('provider');
        observed = svc.value;
      },
    }));
    await mgr.startAll();
    expect(observed).toBe(42);
  });

  it('peer() throws when required dep failed to expose', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'silent', version: '1.0.0',
      register: () => {}, start: async () => {},
    }));
    mgr.loadPlugin(definePlugin({
      name: 'consumer', version: '1.0.0',
      dependencies: ['silent'],
      register: () => {},
      start: async (ctx) => { ctx.peer('silent'); },
    }));
    await expect(mgr.startAll()).rejects.toThrow(/has not exposed a service/);
  });

  it('peer() throws with helpful message when target is not loaded', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'consumer', version: '1.0.0',
      register: () => {},
      start: async (ctx) => { ctx.peer('not-loaded'); },
    }));
    await expect(mgr.startAll()).rejects.toThrow(/not loaded.*Add "not-loaded" to dependencies/);
  });

  it('hasPeer reflects optional dep absence/presence', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'opt-provider', version: '1.0.0',
      register: () => {},
      start: async (ctx) => { ctx.exposeService({ ok: true }); },
    }));
    let consumerSawPeer: boolean | null = null;
    mgr.loadPlugin(definePlugin({
      name: 'opt-consumer', version: '1.0.0',
      optionalDependencies: ['opt-provider'],
      register: () => {},
      start: async (ctx) => { consumerSawPeer = ctx.hasPeer('opt-provider'); },
    }));
    await mgr.startAll();
    expect(consumerSawPeer).toBe(true);
  });

  it('exposeService throws on double-expose', async () => {
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'doubler', version: '1.0.0',
      register: () => {},
      start: async (ctx) => {
        ctx.exposeService({});
        ctx.exposeService({});
      },
    }));
    await expect(mgr.startAll()).rejects.toThrow(/exposeService more than once/);
  });
});

describe('PluginManager lifecycle — shutdown', () => {
  it('stop() failures are logged but do not halt subsequent stops', async () => {
    const calls: string[] = [];
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'a', version: '1.0.0',
      register: () => {},
      start: async () => {},
      stop: async () => { calls.push('stop:a'); },
    }));
    mgr.loadPlugin(definePlugin({
      name: 'b', version: '1.0.0',
      dependencies: ['a'],
      register: () => {},
      start: async () => {},
      stop: async () => { calls.push('stop:b'); throw new Error('boom-on-stop'); },
    }));
    await mgr.startAll();
    await mgr.stopAll(); // must not throw
    expect(calls).toEqual(['stop:b', 'stop:a']);
  });

  it('only plugins whose start() resolved get stop() called', async () => {
    const calls: string[] = [];
    const mgr = new PluginManager();
    mgr.loadPlugin(definePlugin({
      name: 'a', version: '1.0.0',
      register: () => {},
      start: async () => {},
      stop: async () => { calls.push('stop:a'); },
    }));
    mgr.loadPlugin(definePlugin({
      name: 'b', version: '1.0.0',
      dependencies: ['a'],
      register: () => {},
      start: async () => { throw new Error('boom'); },
      stop: async () => { calls.push('stop:b'); }, // should NOT run
    }));
    await expect(mgr.startAll()).rejects.toThrow();
    await mgr.stopAll();
    expect(calls).toEqual(['stop:a']);
  });
});
