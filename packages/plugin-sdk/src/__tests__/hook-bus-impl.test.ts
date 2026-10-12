import { describe, it, expect, vi } from 'vitest';
import { HookBusImpl } from '../hook-bus-impl';

describe('HookBusImpl.define / getDefinedHooks', () => {
  it('records a hook definition with its schema and description', () => {
    const bus = new HookBusImpl();
    bus.define('apk:analyzed', [
      { field: 'apkVersionId', type: 'number', description: "The analyzed APK version's id" },
    ], 'Fires once an APK version finishes its full analysis pipeline.');

    expect(bus.getDefinedHooks()).toEqual([
      {
        name: 'apk:analyzed',
        schema: [{ field: 'apkVersionId', type: 'number', description: "The analyzed APK version's id" }],
        description: 'Fires once an APK version finishes its full analysis pipeline.',
      },
    ]);
  });

  it('returns every defined hook, in declaration order, across multiple define calls', () => {
    const bus = new HookBusImpl();
    bus.define('a', [], 'first');
    bus.define('b', [], 'second');
    expect(bus.getDefinedHooks().map(d => d.name)).toEqual(['a', 'b']);
  });

  it('getDefinedHooks returns a fresh array each call — a caller mutating the result cannot corrupt internal state', () => {
    const bus = new HookBusImpl();
    bus.define('a', [], 'x');
    const first = bus.getDefinedHooks();
    first.push({ name: 'fake', schema: [], description: 'injected' });
    expect(bus.getDefinedHooks()).toHaveLength(1);
  });

  it('define does not affect on/off/emit — a defined-but-unsubscribed hook firing calls no handlers and does not throw', () => {
    const bus = new HookBusImpl();
    bus.define('apk:analyzed', [], 'x');
    expect(() => bus.emit('apk:analyzed', { apkVersionId: 1 })).not.toThrow();
  });

  it('on/off/emit are unaffected by this change — a subscribed handler still receives emitted args', () => {
    const bus = new HookBusImpl();
    const handler = vi.fn();
    bus.on('apk:analyzed', handler);
    bus.emit('apk:analyzed', { apkVersionId: 42 });
    expect(handler).toHaveBeenCalledWith({ apkVersionId: 42 });
  });

  // Regression guard: real, already-compiled plugins (darkride-plugin-maps, -couchbase-tpw,
  // -mdesync, -attractions-io) call define() with the pre-existing documented signature —
  // define(name, Record<string,string>) or define(name) with no schema at all. Plugins run
  // in-process against this host's live HookBusImpl, so what matters is the arguments their
  // already-shipped JS actually passes at runtime, not what SDK version they were built
  // against. A caller on the old shape must normalize safely, not corrupt getDefinedHooks()
  // into a non-array schema that crashes the editor's SchemaFieldListEditor (fields.map).
  it('normalizes a legacy Record<string,string> schema into SchemaField[], with an empty per-field description', () => {
    const bus = new HookBusImpl();
    (bus.define as any)('maps:tile-downloaded', { versionId: 'number' });
    expect(bus.getDefinedHooks()).toEqual([
      { name: 'maps:tile-downloaded', schema: [{ field: 'versionId', type: 'number', description: '' }], description: '' },
    ]);
  });

  it('normalizes a legacy call with no schema at all into an empty array', () => {
    const bus = new HookBusImpl();
    (bus.define as any)('my-plugin:item-created');
    expect(bus.getDefinedHooks()).toEqual([
      { name: 'my-plugin:item-created', schema: [], description: '' },
    ]);
  });

  it('a legacy multi-field Record preserves every field, in declaration order', () => {
    const bus = new HookBusImpl();
    (bus.define as any)('mdesync:reconcile-complete', { ruleId: 'number', missing: 'number', stale: 'number' });
    expect(bus.getDefinedHooks()[0].schema).toEqual([
      { field: 'ruleId', type: 'number', description: '' },
      { field: 'missing', type: 'number', description: '' },
      { field: 'stale', type: 'number', description: '' },
    ]);
  });

  // Two core services (e.g. capture-session-manager.ts and automation-runner.ts) both emit
  // 'session:created' and both call define() for it in their own setHookBus(). Without
  // dedupe, that pushed two catalog rows for the same name — the frontend event picker would
  // show "Fires automatically on: session:created" twice.
  it('calling define() twice for the same name replaces the catalog entry rather than duplicating it', () => {
    const bus = new HookBusImpl();
    bus.define('session:created', [{ field: 'deviceId', type: 'string', description: 'old' }], 'first description');
    bus.define('session:created', [{ field: 'deviceId', type: 'string', description: 'new' }], 'second description');

    expect(bus.getDefinedHooks()).toEqual([
      {
        name: 'session:created',
        schema: [{ field: 'deviceId', type: 'string', description: 'new' }],
        description: 'second description',
      },
    ]);
  });

  it('redefining a name keeps its original position in declaration order', () => {
    const bus = new HookBusImpl();
    bus.define('a', [], 'first');
    bus.define('b', [], 'second');
    bus.define('a', [], 'first redefined');
    expect(bus.getDefinedHooks().map(d => d.name)).toEqual(['a', 'b']);
  });
});

describe('HookBusImpl.emit — undefined-event visibility', () => {
  it('warns when an event is emitted that was never define()\'d', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bus = new HookBusImpl();
      bus.emit('ghost:event', { x: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghost:event'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not warn when the event was defined first', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bus = new HookBusImpl();
      bus.define('known:event', [], 'x');
      bus.emit('known:event', { x: 1 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns only once per undefined name, not on every emit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bus = new HookBusImpl();
      bus.emit('ghost:event', {});
      bus.emit('ghost:event', {});
      bus.emit('ghost:event', {});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
