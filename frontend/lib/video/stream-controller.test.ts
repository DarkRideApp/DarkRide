import { describe, it, expect, vi } from 'vitest';
import { StreamController } from './stream-controller';
import { FrameMsgType, HEADER_SIZE, WIRE_VERSION } from './wire-format';
import type { DecodedFrame } from './wire-format';
import type { IDecoder, DecoderCallbacks } from './stream-controller';

/** Build a wire-format v2 binary frame for feeding into the controller. */
function makeFrame(msgType: FrameMsgType, frameId: number, nal: number[] = [0x00]): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + nal.length);
  const view = new DataView(buf);
  view.setUint8(0, WIRE_VERSION);
  view.setUint8(1, msgType);
  view.setBigUint64(2, 0n, false);
  view.setUint32(10, frameId, false);
  new Uint8Array(buf).set(nal, HEADER_SIZE);
  return buf;
}

/** Fake decoder that records pushes and exposes the callbacks the controller wired. */
class FakeDecoder implements IDecoder {
  pushes: DecodedFrame[] = [];
  closed = false;
  resets = 0;
  cb: DecoderCallbacks;
  constructor(cb: DecoderCallbacks) { this.cb = cb; }
  push(f: DecodedFrame): void { this.pushes.push(f); }
  close(): void { this.closed = true; }
  reset(): void { this.resets++; }
}

function setup(overrides: { now?: () => number; watchdogTimeoutMs?: number } = {}) {
  let fake: FakeDecoder | null = null;
  const drawFrame = vi.fn();
  const requestKeyframe = vi.fn();
  const onConfig = vi.fn();
  const controller = new StreamController(
    { drawFrame },
    { requestKeyframe, onConfig },
    {
      createDecoder: (cb) => { fake = new FakeDecoder(cb); return fake; },
      now: overrides.now,
      watchdogTimeoutMs: overrides.watchdogTimeoutMs,
    },
  );
  return { controller, getFake: () => fake!, drawFrame, requestKeyframe, onConfig };
}

describe('StreamController', () => {
  it('parses a binary frame and pushes it to the decoder', () => {
    const { controller, getFake } = setup();
    controller.feedBinary(makeFrame(FrameMsgType.CONFIG, 1, [0x67]));
    expect(getFake().pushes).toHaveLength(1);
    expect(getFake().pushes[0].msgType).toBe(FrameMsgType.CONFIG);
  });

  it('calls onConfig when a CONFIG frame arrives', () => {
    const { controller, onConfig } = setup();
    controller.feedBinary(makeFrame(FrameMsgType.CONFIG, 1, [0x67]));
    expect(onConfig).toHaveBeenCalledTimes(1);
  });

  it('requests a keyframe when the frame-id gap is >= 2', () => {
    const { controller, requestKeyframe } = setup();
    controller.feedBinary(makeFrame(FrameMsgType.KEYFRAME, 1));
    controller.feedBinary(makeFrame(FrameMsgType.DELTA, 5)); // gap of 3
    expect(requestKeyframe).toHaveBeenCalledWith('gap', 3);
  });

  it('does NOT request a keyframe for a single-frame gap', () => {
    const { controller, requestKeyframe } = setup();
    controller.feedBinary(makeFrame(FrameMsgType.KEYFRAME, 1));
    controller.feedBinary(makeFrame(FrameMsgType.DELTA, 3)); // gap of 1
    expect(requestKeyframe).not.toHaveBeenCalled();
  });

  it('renders decoded frames through the renderer', () => {
    const { controller, getFake, drawFrame } = setup();
    controller.feedBinary(makeFrame(FrameMsgType.CONFIG, 1, [0x67]));
    const fakeVideoFrame = { close: vi.fn() } as any;
    getFake().cb.onFrame(fakeVideoFrame);
    expect(drawFrame).toHaveBeenCalledWith(fakeVideoFrame);
  });

  it('requests a keyframe when the decoder asks for a reset', () => {
    const { controller, getFake, requestKeyframe } = setup();
    controller.feedBinary(makeFrame(FrameMsgType.CONFIG, 1, [0x67]));
    getFake().cb.onResetRequested?.();
    expect(requestKeyframe).toHaveBeenCalledWith('decode-error', 0);
  });

  it('fires a watchdog keyframe request when no keyframe arrives within the timeout', () => {
    let t = 1000;
    const { controller, requestKeyframe } = setup({ now: () => t, watchdogTimeoutMs: 8000 });
    controller.feedBinary(makeFrame(FrameMsgType.KEYFRAME, 1));
    t = 1000 + 8001;
    controller.checkWatchdog();
    expect(requestKeyframe).toHaveBeenCalledWith('watchdog', 0);
  });

  it('does not fire the watchdog before the timeout elapses', () => {
    let t = 1000;
    const { controller, requestKeyframe } = setup({ now: () => t, watchdogTimeoutMs: 8000 });
    controller.feedBinary(makeFrame(FrameMsgType.KEYFRAME, 1));
    t = 1000 + 5000;
    controller.checkWatchdog();
    expect(requestKeyframe).not.toHaveBeenCalled();
  });

  it('a fresh KEYFRAME resets the watchdog clock', () => {
    let t = 1000;
    const { controller, requestKeyframe } = setup({ now: () => t, watchdogTimeoutMs: 8000 });
    controller.feedBinary(makeFrame(FrameMsgType.KEYFRAME, 1));
    t = 1000 + 5000;
    controller.feedBinary(makeFrame(FrameMsgType.KEYFRAME, 2)); // resets clock
    t = 1000 + 5000 + 5000; // 10s from start, but only 5s since last keyframe
    controller.checkWatchdog();
    expect(requestKeyframe).not.toHaveBeenCalled();
  });

  it('reset() makes the next frame a fresh reference (no spurious gap request)', () => {
    const { controller, requestKeyframe } = setup();
    controller.feedBinary(makeFrame(FrameMsgType.KEYFRAME, 100));
    controller.reset();
    // A far-lower frameId after reset would be a big regression; reset must
    // clear the detector so it is treated as a fresh start, not a gap.
    controller.feedBinary(makeFrame(FrameMsgType.KEYFRAME, 1));
    controller.feedBinary(makeFrame(FrameMsgType.DELTA, 2)); // gap 0
    expect(requestKeyframe).not.toHaveBeenCalled();
  });

  it('close() closes the decoder', () => {
    const { controller, getFake } = setup();
    controller.feedBinary(makeFrame(FrameMsgType.CONFIG, 1, [0x67]));
    controller.close();
    expect(getFake().closed).toBe(true);
  });

  it('surfaces a wire-version mismatch without throwing', () => {
    const onWireVersionMismatch = vi.fn();
    const controller = new StreamController(
      { drawFrame: vi.fn() },
      { requestKeyframe: vi.fn(), onWireVersionMismatch },
      { createDecoder: (cb) => new FakeDecoder(cb) },
    );
    const bad = new ArrayBuffer(HEADER_SIZE);
    new DataView(bad).setUint8(0, 99); // wrong version
    expect(() => controller.feedBinary(bad)).not.toThrow();
    expect(onWireVersionMismatch).toHaveBeenCalledWith({ received: 99, expected: WIRE_VERSION });
  });
});
