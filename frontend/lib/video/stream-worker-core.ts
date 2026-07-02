import { StreamController, type StreamRenderer, type StreamControllerCallbacks, type StreamControllerDeps } from './stream-controller';
import { createCanvasRenderer, type BitmapRenderer, type DrawableCanvas } from './canvas-renderer';
import { WATCHDOG_INTERVAL_MS, type WorkerInMsg, type WorkerOutMsg } from './stream-worker-protocol';

interface ControllerLike {
  feedBinary(data: ArrayBuffer): void;
  checkWatchdog(): void;
  reset(): void;
  close(): void;
}

export interface StreamWorkerDeps {
  createController?: (renderer: StreamRenderer, callbacks: StreamControllerCallbacks, deps?: StreamControllerDeps) => ControllerLike;
  createRenderer?: (canvas: OffscreenCanvas) => BitmapRenderer;
  decodeJpeg?: (data: ArrayBuffer) => Promise<ImageBitmap>;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
  now?: () => number;
}

/**
 * Pure message pump for the stream worker. Kept free of worker globals
 * (postMessage/onmessage/OffscreenCanvas/createImageBitmap) so it is unit
 * testable; the worker entry file injects the real implementations. Owns a
 * StreamController + renderer for one device stream inside the worker, so
 * decode and paint never touch the main thread.
 */
export function createStreamWorkerCore(
  post: (msg: WorkerOutMsg) => void,
  deps: StreamWorkerDeps = {},
) {
  const createController = deps.createController
    ?? ((renderer, callbacks, cdeps) => new StreamController(renderer, callbacks, cdeps));
  const createRenderer = deps.createRenderer
    ?? ((canvas: OffscreenCanvas) => createCanvasRenderer(() => canvas as unknown as DrawableCanvas));
  const decodeJpeg = deps.decodeJpeg
    ?? ((data: ArrayBuffer) => createImageBitmap(new Blob([data], { type: 'image/jpeg' })));
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h));

  let controller: ControllerLike | null = null;
  let renderer: BitmapRenderer | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let announcedRender = false;

  function announceOnce(): void {
    if (announcedRender) return;
    announcedRender = true;
    post({ type: 'rendered' });
  }

  function handle(msg: WorkerInMsg): void {
    switch (msg.type) {
      case 'init': {
        const base = createRenderer(msg.canvas);
        // Wrap so the main thread learns the first paint actually happened —
        // its cue that worker rendering is live (self-heal fallback otherwise).
        renderer = {
          drawFrame: (f) => { base.drawFrame(f); announceOnce(); },
          drawBitmap: (b) => { base.drawBitmap(b); announceOnce(); },
        };
        controller = createController(
          renderer,
          {
            requestKeyframe: (reason, gap) => post({ type: 'keyframe', reason, gap }),
            onConfig: () => post({ type: 'config' }),
            onStats: (sample) => post({ type: 'stats', sample }),
          },
          { now: deps.now },
        );
        watchdog = setIntervalFn(() => controller?.checkWatchdog(), WATCHDOG_INTERVAL_MS);
        break;
      }
      case 'frame':
        controller?.feedBinary(msg.data);
        break;
      case 'jpeg':
        decodeJpeg(msg.data).then((bmp) => renderer?.drawBitmap(bmp)).catch(() => { /* drop bad frame */ });
        break;
      case 'reset':
        controller?.reset();
        break;
      case 'close':
        if (watchdog !== null) { clearIntervalFn(watchdog); watchdog = null; }
        controller?.close();
        controller = null;
        renderer = null;
        break;
    }
  }

  return { handle };
}
