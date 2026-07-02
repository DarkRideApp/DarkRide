import type { KeyframeReason } from './keyframe-trigger';
import type { WorkerInMsg, WorkerOutMsg } from './stream-worker-protocol';

export interface StreamWorkerClientCallbacks {
  onKeyframe: (reason: KeyframeReason, gap: number) => void;
  onConfig: () => void;
  onRendered?: () => void;
}

export interface StreamWorkerClient {
  feedBinary(data: ArrayBuffer): void;
  feedJpeg(data: ArrayBuffer): void;
  reset(): void;
  close(): void;
}

/** A canvas that can hand its rendering surface to a worker. */
interface TransferableCanvas {
  transferControlToOffscreen(): OffscreenCanvas;
}

/**
 * Main-thread handle to the stream worker. Transfers the canvas's rendering
 * surface to the worker (decode + paint run off the main thread) and relays
 * worker events back to React via callbacks. `createWorker` is injectable for
 * tests; the default spins up the real module worker.
 */
export function createStreamWorkerClient(
  canvas: TransferableCanvas,
  callbacks: StreamWorkerClientCallbacks,
  createWorker: () => Worker = defaultCreateWorker,
): StreamWorkerClient {
  const worker = createWorker();
  worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
    const msg = e.data;
    if (msg.type === 'keyframe') callbacks.onKeyframe(msg.reason, msg.gap);
    else if (msg.type === 'config') callbacks.onConfig();
    else if (msg.type === 'rendered') callbacks.onRendered?.();
  };

  const off = canvas.transferControlToOffscreen();
  post({ type: 'init', canvas: off }, [off]);

  function post(msg: WorkerInMsg, transfer?: Transferable[]): void {
    worker.postMessage(msg, transfer ?? []);
  }

  return {
    // Do NOT transfer `data`: the WebSocket layer may reuse its receive buffer.
    // structured-clone copies it, leaving the caller's buffer intact.
    feedBinary(data: ArrayBuffer): void { worker.postMessage({ type: 'frame', data }); },
    feedJpeg(data: ArrayBuffer): void { worker.postMessage({ type: 'jpeg', data }); },
    reset(): void { worker.postMessage({ type: 'reset' }); },
    close(): void {
      worker.postMessage({ type: 'close' });
      worker.terminate();
    },
  };
}

function defaultCreateWorker(): Worker {
  return new Worker(new URL('./stream-worker.ts', import.meta.url), { type: 'module' });
}
