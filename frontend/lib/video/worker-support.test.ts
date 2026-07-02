import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { streamWorkerEnabled, supportsOffscreenWorker } from './worker-support';

describe('streamWorkerEnabled', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  it('defaults to ON when the flag is unset', () => {
    expect(streamWorkerEnabled()).toBe(true);
  });

  it('is OFF when explicitly opted out with "0"', () => {
    localStorage.setItem('darkride:stream-worker', '0');
    expect(streamWorkerEnabled()).toBe(false);
  });

  it('stays ON for any non-"0" value', () => {
    localStorage.setItem('darkride:stream-worker', '1');
    expect(streamWorkerEnabled()).toBe(true);
  });

  it('defaults to ON when localStorage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(streamWorkerEnabled()).toBe(true);
    spy.mockRestore();
  });
});

describe('supportsOffscreenWorker', () => {
  const g = globalThis as any;
  let savedOffscreen: any;
  let savedWorker: any;

  beforeEach(() => {
    savedOffscreen = g.OffscreenCanvas;
    savedWorker = g.Worker;
  });
  afterEach(() => {
    g.OffscreenCanvas = savedOffscreen;
    g.Worker = savedWorker;
    delete (HTMLCanvasElement.prototype as any).transferControlToOffscreen;
  });

  it('is false when OffscreenCanvas is missing', () => {
    delete g.OffscreenCanvas;
    expect(supportsOffscreenWorker()).toBe(false);
  });

  it('is true when Worker, OffscreenCanvas, and transferControlToOffscreen all exist', () => {
    g.Worker = class {};
    g.OffscreenCanvas = class {};
    (HTMLCanvasElement.prototype as any).transferControlToOffscreen = () => ({});
    expect(supportsOffscreenWorker()).toBe(true);
  });
});
