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
  /** Chunks queued in the underlying codec awaiting output (backlog signal). */
  readonly decodeQueueSize?: number;
}

/** A rolling sample of stream health, emitted ~once per statsIntervalMs. */
export interface StreamSample {
  fps: number;
  /** Mean glass-to-glass latency (now − frame capture ts) over the window, ms.
   *  Meaningful only when backend and client clocks are comparable (dev: same
   *  machine). Rising latency ⇒ a growing backlog somewhere in the path. */
  avgLatencyMs: number;
  maxLatencyMs: number;
  frames: number;
  decodeQueueSize: number;
  /** ms since the last painted frame; -1 if none yet. A large/growing value is
   *  a stall (no frames arriving), distinct from low-but-nonzero fps. */
  msSinceLastFrame: number;
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
  /** Periodic health sample for diagnostics. */
  onStats?: (sample: StreamSample) => void;
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
 * transport, and drives tick() on an interval (watchdog + stats).
 */
export class StreamController {
  private readonly decoder: IDecoder;
  private readonly gapDetector = new GapDetector();
  private readonly trigger: KeyframeTrigger;
  private readonly now: () => number;
  private readonly watchdogTimeoutMs: number;
  private lastKeyframeAtMs: number;
  private pendingGap = 0;
  private lastFrameAtMs = 0;
  private statsWindowStartMs: number;
  private statsFrames = 0;
  private statsLatencySum = 0;
  private statsLatencyMax = 0;
  private statsLatencyCount = 0;
  // Watchdog backoff: once fired, wait longer each time until a keyframe
  // arrives, so a dead/asleep stream isn't hammered with RESET_VIDEO every tick.
  private watchdogBackoffMs = 0;
  private nextWatchdogFireMs = 0;
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
    this.statsWindowStartMs = this.lastKeyframeAtMs;

    this.trigger = new KeyframeTrigger((reason) => {
      this.emitKeyframeRequest(reason, this.pendingGap);
      this.pendingGap = 0;
    });

    const createDecoder = deps.createDecoder ?? ((cb) => new H264Decoder(cb));
    this.decoder = createDecoder({
      onFrame: (frame) => this.handleDecoded(frame),
      onError: (e) => this.callbacks.onError?.(e),
      onResetRequested: () => this.fire('decode-error'),
    });
  }

  /** Accumulate a stats sample for the painted frame, then render it. Latency
   *  uses the VideoFrame timestamp (µs) carried through from capture. The
   *  sample is emitted later by tick(), so stalls (no frames) still report. */
  private handleDecoded(frame: VideoFrame): void {
    if (this.callbacks.onStats) {
      const t = this.now();
      const ts = frame.timestamp;
      if (typeof ts === 'number' && ts > 0) {
        const latency = t - ts / 1000;
        this.statsLatencySum += latency;
        if (latency > this.statsLatencyMax) this.statsLatencyMax = latency;
        this.statsLatencyCount += 1;
      }
      this.statsFrames += 1;
      this.lastFrameAtMs = t;
    }
    this.renderer.drawFrame(frame);
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
      // Recovery: stream is healthy again, so reset the watchdog backoff.
      this.watchdogBackoffMs = 0;
      this.nextWatchdogFireMs = 0;
      this.callbacks.onKeyframe?.();
    }
    this.decoder.push(frame);
  }

  /** Driven on an interval by the adapter. Emits a stats sample (so stalls are
   *  visible even with no frames) and runs the watchdog with backoff. */
  tick(): void {
    const now = this.now();

    if (this.callbacks.onStats) {
      const elapsed = now - this.statsWindowStartMs;
      if (elapsed > 0) {
        this.callbacks.onStats({
          fps: (this.statsFrames * 1000) / elapsed,
          avgLatencyMs: this.statsLatencyCount ? this.statsLatencySum / this.statsLatencyCount : 0,
          maxLatencyMs: this.statsLatencyMax,
          frames: this.statsFrames,
          decodeQueueSize: this.decoder.decodeQueueSize ?? 0,
          msSinceLastFrame: this.lastFrameAtMs ? now - this.lastFrameAtMs : -1,
        });
      }
      this.statsWindowStartMs = now;
      this.statsFrames = 0;
      this.statsLatencySum = 0;
      this.statsLatencyMax = 0;
      this.statsLatencyCount = 0;
    }

    // The watchdog has its own backoff, so it emits directly rather than
    // through the trigger's burst-debounce (which would double-gate it).
    if (now - this.lastKeyframeAtMs > this.watchdogTimeoutMs && now >= this.nextWatchdogFireMs) {
      this.stats.watchdogFires += 1;
      this.emitKeyframeRequest('watchdog', 0);
      this.watchdogBackoffMs = this.watchdogBackoffMs ? Math.min(this.watchdogBackoffMs * 2, 60000) : 2000;
      this.nextWatchdogFireMs = now + this.watchdogBackoffMs;
    }
  }

  /** Reset detection state after an intentional stream restart. */
  reset(): void {
    this.gapDetector.reset();
    this.trigger.reset();
    this.lastKeyframeAtMs = this.now();
    this.watchdogBackoffMs = 0;
    this.nextWatchdogFireMs = 0;
  }

  close(): void {
    this.decoder.close();
  }

  private fire(reason: KeyframeReason, gap = 0): void {
    this.pendingGap = gap;
    this.trigger.maybeFire(reason, gap);
    this.pendingGap = 0;
  }

  private emitKeyframeRequest(reason: KeyframeReason, gap: number): void {
    this.stats.keyframeRequests += 1;
    this.callbacks.requestKeyframe(reason, gap);
  }
}
