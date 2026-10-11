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
});
