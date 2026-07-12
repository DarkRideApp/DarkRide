const STREAM_WORKER_KEY = 'darkride:stream-worker';

/**
 * Whether the off-main-thread (Worker + OffscreenCanvas) decode path is enabled.
 *
 * Default OFF (opt in per-browser with `localStorage['darkride:stream-worker'] = '1'`).
 * The worker path decodes + paints entirely off the main thread, but on some
 * setups the transferred OffscreenCanvas composites to screen far slower than
 * it is drawn — decode/stats report ~30fps at low latency yet the visible frame
 * only refreshes every few seconds. The main-thread path (H264Decoder + a
 * regular 2D canvas) renders reliably and is more than fast enough for a single
 * device view, so it is the default until the worker compositing is proven
 * smooth on real hardware.
 */
export function streamWorkerEnabled(): boolean {
  try {
    return localStorage.getItem(STREAM_WORKER_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether the browser can run the Worker/OffscreenCanvas decode path at all. */
export function supportsOffscreenWorker(): boolean {
  return typeof Worker !== 'undefined'
    && typeof OffscreenCanvas !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
}
