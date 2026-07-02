const STREAM_WORKER_KEY = 'darkride:stream-worker';

/**
 * Whether the off-main-thread (Worker + OffscreenCanvas) decode path is enabled.
 * Default ON. Opt out per-browser with `localStorage['darkride:stream-worker'] = '0'`
 * (useful if the worker path misbehaves — the main-thread path is the fallback).
 */
export function streamWorkerEnabled(): boolean {
  try {
    return localStorage.getItem(STREAM_WORKER_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Whether the browser can run the Worker/OffscreenCanvas decode path at all. */
export function supportsOffscreenWorker(): boolean {
  return typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
}
