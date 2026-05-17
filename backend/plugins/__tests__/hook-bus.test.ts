import { describe, it, expect, vi } from 'vitest';
import { HookBusImpl } from '@darkrideapp/plugin-sdk';
import type { HookBus } from '@darkrideapp/plugin-sdk';

describe('HookBus', () => {
  it('emits events to all subscribers', () => {
    const bus = new HookBusImpl();
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('test:event', handler1);
    bus.on('test:event', handler2);

    bus.emit('test:event', { id: 1 });

    expect(handler1).toHaveBeenCalledWith({ id: 1 });
    expect(handler2).toHaveBeenCalledWith({ id: 1 });
  });

  it('does not call unsubscribed handlers', () => {
    const bus = new HookBusImpl();
    const handler = vi.fn();
    bus.on('test:event', handler);
    bus.off('test:event', handler);

    bus.emit('test:event', { id: 1 });

    expect(handler).not.toHaveBeenCalled();
  });

  it('handles multiple event types independently', () => {
    const bus = new HookBusImpl();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    bus.on('event-a', handlerA);
    bus.on('event-b', handlerB);

    bus.emit('event-a', 'hello');

    expect(handlerA).toHaveBeenCalledWith('hello');
    expect(handlerB).not.toHaveBeenCalled();
  });

  it('define registers a hook name for documentation', () => {
    const bus = new HookBusImpl();
    bus.define('my-plugin:data-ready', { id: 'number' });
    expect(bus.getDefinedHooks()).toContainEqual({
      name: 'my-plugin:data-ready',
      schema: { id: 'number' },
    });
  });

  it('emits to no handlers gracefully', () => {
    const bus = new HookBusImpl();
    expect(() => bus.emit('nonexistent', {})).not.toThrow();
  });

  it('catches and logs handler errors without stopping other handlers', () => {
    const bus = new HookBusImpl();
    const errorHandler = vi.fn(() => { throw new Error('boom'); });
    const goodHandler = vi.fn();
    bus.on('test:event', errorHandler);
    bus.on('test:event', goodHandler);

    bus.emit('test:event', {});

    expect(errorHandler).toHaveBeenCalled();
    expect(goodHandler).toHaveBeenCalled();
  });

  it('catches async handler rejections so they do not surface as unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);

    try {
      const bus = new HookBusImpl();
      bus.on('test:event', async () => { throw new Error('async boom'); });

      bus.emit('test:event', {});

      // Two microtask turns + a setImmediate to let any unhandled rejection settle.
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('continues emitting to other handlers after an async rejection', async () => {
    const bus = new HookBusImpl();
    const failing = vi.fn(async () => { throw new Error('async boom'); });
    const succeeding = vi.fn();
    bus.on('test:event', failing);
    bus.on('test:event', succeeding);

    bus.emit('test:event', {});
    await new Promise((r) => setImmediate(r));

    expect(failing).toHaveBeenCalled();
    expect(succeeding).toHaveBeenCalled();
  });
});

describe('HookBus interface', () => {
  it('exposes emit for plugin use', () => {
    const bus = new HookBusImpl();
    const typed: HookBus = bus;
    const received: any[] = [];
    typed.on('test:event', (payload) => { received.push(payload); });
    // This line must type-check and run:
    typed.emit('test:event', { hello: 'world' });
    expect(received).toEqual([{ hello: 'world' }]);
  });
});
