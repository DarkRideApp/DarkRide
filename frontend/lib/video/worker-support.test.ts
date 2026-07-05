import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { streamWorkerEnabled, supportsOffscreenWorker } from './worker-support';

describe('streamWorkerEnabled', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  it('defaults to OFF when the flag is unset', () => {
    expect(streamWorkerEnabled()).toBe(false);
  });

  it('is ON only when explicitly opted in with "1"', () => {
    localStorage.setItem('darkride:stream-worker', '1');
    expect(streamWorkerEnabled()).toBe(true);
  });

  it('stays OFF for any non-"1" value', () => {
    localStorage.setItem('darkride:stream-worker', '0');
    expect(streamWorkerEnabled()).toBe(false);
  });

  it('defaults to OFF when localStorage is unavailable', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(streamWorkerEnabled()).toBe(false);
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
