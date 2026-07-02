import type { KeyframeReason } from './keyframe-trigger';

/** Messages the main thread sends to the stream worker. */
export type WorkerInMsg =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'frame'; data: ArrayBuffer }   // wire-format H.264 binary frame
  | { type: 'jpeg'; data: ArrayBuffer }     // polling/minicap still (JPEG bytes)
  | { type: 'reset' }
  | { type: 'close' };

/** Messages the worker posts back to the main thread. */
export type WorkerOutMsg =
  | { type: 'keyframe'; reason: KeyframeReason; gap: number }
  | { type: 'config' }
  | { type: 'rendered' };  // first successful paint — main thread's health signal

export const WATCHDOG_INTERVAL_MS = 1000;
