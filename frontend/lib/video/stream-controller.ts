import { decodeFrame, FrameMsgType, WireVersionMismatchError, WIRE_VERSION } from './wire-format';
import type { DecodedFrame } from './wire-format';
import { H264Decoder } from './h264-decoder';
import { GapDetector } from './gap-detector';
import { KeyframeTrigger, type KeyframeReason } from './keyframe-trigger';

/** Minimal decoder surface the controller drives. H264Decoder satisfies it. */
export interface IDecoder {
  push(frame: DecodedFrame): void;
  close(): void;
  reset(): void;
}

export interface DecoderCallbacks {
  onFrame: (frame: VideoFrame) => void;
  onError: (e: Error) => void;
  onResetRequested?: () => void;
}

/** Where decoded frames are painted. The renderer owns closing the frame. */
export interface StreamRenderer {
  drawFrame(frame: VideoFrame): void;
}

export interface StreamControllerCallbacks {
  /** Ask the backend to emit a fresh IDR. `gap` is the observed frame-id gap
   *  for 'gap' reasons, 0 otherwise. */
  requestKeyframe: (reason: KeyframeReason, gap: number) => void;
  onConfig?: () => void;
  onKeyframe?: () => void;
  onGap?: (info: { gap: number; frameId: number; msgType: number; wrapped: boolean }) => void;
  onRegression?: (info: { previous: number | null; received: number }) => void;
  onError?: (e: Error) => void;
  onWireVersionMismatch?: (info: { received: number; expected: number }) => void;
}

export interface StreamControllerDeps {
  createDecoder?: (cb: DecoderCallbacks) => IDecoder;
  now?: () => number;
  watchdogTimeoutMs?: number;
}

export interface StreamStats {
  totalGaps: number;
  totalMissed: number;
  regressions: number;
  wraps: number;
  keyframeRequests: number;
  watchdogFires: number;
}

/**
 * Owns the decode + keyframe-recovery orchestration for one H.264 stream:
 * frame parsing, gap detection, keyframe requests (gap / decode-error /
 * watchdog), and handing decoded frames to a renderer. Deliberately free of
 * DOM, WebSocket, and timers so it can run identically on the main thread or
 * inside a Worker — the adapter supplies the renderer, the keyframe-request
 * transport, and drives checkWatchdog() on an interval.
 */
export class StreamController {
  private readonly decoder: IDecoder;
  private readonly gapDetector = new GapDetector();
  private readonly trigger: KeyframeTrigger;
  private readonly now: () => number;
  private readonly watchdogTimeoutMs: number;
  private lastKeyframeAtMs: number;
  private pendingGap = 0;
  readonly stats: StreamStats = {
    totalGaps: 0, totalMissed: 0, regressions: 0, wraps: 0,
    keyframeRequests: 0, watchdogFires: 0,
  };

  constructor(
    private readonly renderer: StreamRenderer,
    private readonly callbacks: StreamControllerCallbacks,
    deps: StreamControllerDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.watchdogTimeoutMs = deps.watchdogTimeoutMs ?? 8000;
    this.lastKeyframeAtMs = this.now();

    this.trigger = new KeyframeTrigger((reason) => {
      this.stats.keyframeRequests += 1;
      this.callbacks.requestKeyframe(reason, this.pendingGap);
      this.pendingGap = 0;
    });

    const createDecoder = deps.createDecoder ?? ((cb) => new H264Decoder(cb));
    this.decoder = createDecoder({
      onFrame: (frame) => this.renderer.drawFrame(frame),
      onError: (e) => this.callbacks.onError?.(e),
      onResetRequested: () => this.fire('decode-error'),
    });
  }

  /** Parse one wire-format binary message and drive detection + decode. */
  feedBinary(data: ArrayBuffer): void {
    let frame: DecodedFrame;
    try {
      frame = decodeFrame(data);
    } catch (e) {
      if (e instanceof WireVersionMismatchError) {
        this.callbacks.onWireVersionMismatch?.({ received: e.received, expected: WIRE_VERSION });
      } else {
        this.callbacks.onError?.(e as Error);
      }
      return;
    }

    const result = this.gapDetector.feed(frame.frameId);
    if (!result.firstFrame) {
      if (result.gap > 0) {
        this.stats.totalGaps += 1;
        this.stats.totalMissed += result.gap;
        if (result.wrapped) this.stats.wraps += 1;
        this.callbacks.onGap?.({
          gap: result.gap, frameId: frame.frameId, msgType: frame.msgType, wrapped: result.wrapped,
        });
        this.fire('gap', result.gap);
      } else if (result.gap < 0) {
        this.stats.regressions += 1;
        this.callbacks.onRegression?.({ previous: this.gapDetector.last, received: frame.frameId });
      }
    }

    if (frame.msgType === FrameMsgType.CONFIG) this.callbacks.onConfig?.();
    if (frame.msgType === FrameMsgType.KEYFRAME) {
      this.lastKeyframeAtMs = this.now();
      this.callbacks.onKeyframe?.();
    }
    this.decoder.push(frame);
  }

  /** Fire a watchdog keyframe request if no keyframe has arrived recently. */
  checkWatchdog(): void {
    if (this.now() - this.lastKeyframeAtMs > this.watchdogTimeoutMs) {
      this.stats.watchdogFires += 1;
      this.fire('watchdog');
    }
  }

  /** Reset detection state after an intentional stream restart. */
  reset(): void {
    this.gapDetector.reset();
    this.trigger.reset();
    this.lastKeyframeAtMs = this.now();
  }

  close(): void {
    this.decoder.close();
  }

  private fire(reason: KeyframeReason, gap = 0): void {
    this.pendingGap = gap;
    this.trigger.maybeFire(reason, gap);
    this.pendingGap = 0;
  }
}
