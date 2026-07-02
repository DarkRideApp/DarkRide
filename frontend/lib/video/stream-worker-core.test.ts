import { describe, it, expect, vi } from 'vitest';
import { createStreamWorkerCore } from './stream-worker-core';
import type { StreamControllerCallbacks } from './stream-controller';

function harness() {
  const post = vi.fn();
  const controller = { feedBinary: vi.fn(), tick: vi.fn(), reset: vi.fn(), close: vi.fn() };
  let captured: StreamControllerCallbacks | null = null;
  const renderer = { drawFrame: vi.fn(), drawBitmap: vi.fn() };
  let intervalFn: (() => void) | null = null;
  const core = createStreamWorkerCore(post, {
    createController: (_renderer, callbacks) => { captured = callbacks; return controller; },
    createRenderer: () => renderer,
    decodeJpeg: async () => ({ width: 1, height: 1, close: vi.fn() } as any),
    setIntervalFn: (fn: () => void) => { intervalFn = fn; return 1 as any; },
    clearIntervalFn: vi.fn(),
    now: () => 0,
  });
  return { core, post, controller, renderer, getCallbacks: () => captured!, getIntervalFn: () => intervalFn! };
}

const CANVAS = { transferred: true } as any;

describe('createStreamWorkerCore', () => {
  it('feeds binary frames to the controller after init', () => {
    const h = harness();
    h.core.handle({ type: 'init', canvas: CANVAS });
    const data = new ArrayBuffer(14);
    h.core.handle({ type: 'frame', data });
    expect(h.controller.feedBinary).toHaveBeenCalledWith(data);
  });

  it('posts a keyframe request when the controller asks for one', () => {
    const h = harness();
    h.core.handle({ type: 'init', canvas: CANVAS });
    h.getCallbacks().requestKeyframe('gap', 4);
    expect(h.post).toHaveBeenCalledWith({ type: 'keyframe', reason: 'gap', gap: 4 });
  });

  it('posts a config event when the controller reports CONFIG', () => {
    const h = harness();
    h.core.handle({ type: 'init', canvas: CANVAS });
    h.getCallbacks().onConfig!();
    expect(h.post).toHaveBeenCalledWith({ type: 'config' });
  });

  it('decodes and draws a polling JPEG frame', async () => {
    const h = harness();
    h.core.handle({ type: 'init', canvas: CANVAS });
    h.core.handle({ type: 'jpeg', data: new ArrayBuffer(8) });
    await Promise.resolve(); await Promise.resolve();
    expect(h.renderer.drawBitmap).toHaveBeenCalledTimes(1);
  });

  it('drives the controller tick on the interval', () => {
    const h = harness();
    h.core.handle({ type: 'init', canvas: CANVAS });
    h.getIntervalFn()();
    expect(h.controller.tick).toHaveBeenCalledTimes(1);
  });

  it('resets the controller on reset', () => {
    const h = harness();
    h.core.handle({ type: 'init', canvas: CANVAS });
    h.core.handle({ type: 'reset' });
    expect(h.controller.reset).toHaveBeenCalledTimes(1);
  });

  it('closes the controller and clears the watchdog on close', () => {
    const clearIntervalFn = vi.fn();
    const controller = { feedBinary: vi.fn(), tick: vi.fn(), reset: vi.fn(), close: vi.fn() };
    const core = createStreamWorkerCore(vi.fn(), {
      createController: () => controller,
      createRenderer: () => ({ drawFrame: vi.fn(), drawBitmap: vi.fn() }),
      decodeJpeg: async () => ({ width: 1, height: 1, close: vi.fn() } as any),
      setIntervalFn: () => 1 as any,
      clearIntervalFn,
      now: () => 0,
    });
    core.handle({ type: 'init', canvas: CANVAS });
    core.handle({ type: 'close' });
    expect(controller.close).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });

  it('ignores frames that arrive before init (no crash)', () => {
    const h = harness();
    expect(() => h.core.handle({ type: 'frame', data: new ArrayBuffer(14) })).not.toThrow();
    expect(h.controller.feedBinary).not.toHaveBeenCalled();
  });
});
