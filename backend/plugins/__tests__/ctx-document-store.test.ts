import { describe, it, expect } from 'vitest';
import { definePlugin, HookBusImpl } from '@darkrideapp/plugin-sdk';
import { createInMemoryDocStore } from '@darkrideapp/plugin-sdk/test-utils';
import { PluginContextImpl, createEmptyContributions } from '../plugin-context';

describe('ctx.documentStore — lifecycle guard', () => {
  it('(a) throws before wiring: accessing documentStore on an unwired PluginContextImpl throws', () => {
    // Construct PluginContextImpl directly WITHOUT calling setDocumentStore —
    // this mirrors what happens during register() before wireCoreServices runs.
    const hookBus = new HookBusImpl();
    const ctx = new PluginContextImpl('test-plugin', hookBus, createEmptyContributions());

    expect(() => ctx.documentStore).toThrow(
      'documentStore not available',
    );
  });

  it('(a) error message names the plugin', () => {
    const hookBus = new HookBusImpl();
    const ctx = new PluginContextImpl('my-plugin', hookBus, createEmptyContributions());

    expect(() => ctx.documentStore).toThrow('Plugin "my-plugin"');
  });
});

describe('ctx.documentStore — start() round-trip', () => {
  it('(b) putDoc/getDoc round-trips through the injected DocStoreApi from start()', async () => {
    const ds = createInMemoryDocStore();

    let readBack: unknown = undefined;

    const testPlugin = definePlugin({
      name: 'docstore-roundtrip',
      version: '1.0.0',
      register(_ctx) {
        // deliberately empty — we only use start()
      },
      async start(ctx) {
        await ctx.documentStore.putDoc('docstore_start_test_key', { ok: true });
        readBack = await ctx.documentStore.getDoc('docstore_start_test_key');
      },
    });

    // Drive PluginManager directly (the filesystem harness only accepts a
    // pluginDir path), mirroring how plugin-lifecycle.test.ts exercises start().
    const { PluginManager } = await import('../plugin-manager');
    const mgr = new PluginManager();
    mgr.loadPlugin(testPlugin);
    mgr.wirePluginLoadedCheck();

    // Wire only documentStore (the minimum needed for this test)
    mgr.wireCoreServices({
      cloudStorage: {} as any,
      notify: () => {},
      runner: {} as any,
      fileSync: {} as any,
      settings: {} as any,
      cloudFiles: {} as any,
      automations: {} as any,
      websocket: {} as any,
      apks: {} as any,
      paths: {} as any,
      dispatcher: {} as any,
      documentStore: ds,
    });

    await mgr.startAll();

    // Round-trip assertion
    expect(readBack).toEqual({ ok: true });

    // Confirm the INJECTED instance was actually used (not a separate in-memory store)
    expect(ds._store.has('docstore_start_test_key')).toBe(true);
    expect(ds._store.get('docstore_start_test_key')).toEqual({ ok: true });

    await mgr.stopAll();
  });
});
