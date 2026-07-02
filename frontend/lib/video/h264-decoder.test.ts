import { describe, it, expect, vi, beforeEach } from 'vitest';
import { H264Decoder } from './h264-decoder';
import { FrameMsgType } from './wire-format';

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  state = 'unconfigured';
  configCalls: any[] = [];
  decodeCalls: any[] = [];
  output: (frame: any) => void;
  error: (e: Error) => void;
  constructor(init: any) {
    this.output = init.output;
    this.error = init.error;
    FakeVideoDecoder.instances.push(this);
  }
  configure(cfg: any) {
    this.configCalls.push(cfg);
    this.state = 'configured';
  }
  decode(chunk: any) {
    this.decodeCalls.push(chunk);
  }
  close() { this.state = 'closed'; }
  reset() { this.decodeCalls = []; this.state = 'unconfigured'; }
}

class FakeEncodedVideoChunk {
  type: string;
  timestamp: number;
  data: ArrayBuffer;
  constructor(init: any) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

beforeEach(() => {
  FakeVideoDecoder.instances = [];
  (global as any).VideoDecoder = FakeVideoDecoder;
  (global as any).EncodedVideoChunk = FakeEncodedVideoChunk;
});

describe('H264Decoder', () => {
  it('configures decoder on first config frame', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });

    expect(FakeVideoDecoder.instances[0].configCalls).toHaveLength(1);
    expect(FakeVideoDecoder.instances[0].configCalls[0].codec).toMatch(/^avc1\./);
  });

  it('queues keyframes received before config and replays after configure', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const kf = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
    d.push({ msgType: FrameMsgType.KEYFRAME, timestampMs: 100n, nalData: kf.buffer });

    expect(FakeVideoDecoder.instances[0]?.decodeCalls.length ?? 0).toBe(0);

    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });

    expect(FakeVideoDecoder.instances[0].decodeCalls).toHaveLength(1);
    expect(FakeVideoDecoder.instances[0].decodeCalls[0].type).toBe('key');
  });

  it('drops delta frames received before first keyframe', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });

    const delta = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41, 0x99]);
    d.push({ msgType: FrameMsgType.DELTA, timestampMs: 200n, nalData: delta.buffer });

    expect(FakeVideoDecoder.instances[0].decodeCalls).toHaveLength(0);
  });

  it('forwards delta frames after first keyframe', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });

    const kf = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
    d.push({ msgType: FrameMsgType.KEYFRAME, timestampMs: 100n, nalData: kf.buffer });

    const delta = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41, 0x99]);
    d.push({ msgType: FrameMsgType.DELTA, timestampMs: 200n, nalData: delta.buffer });

    expect(FakeVideoDecoder.instances[0].decodeCalls).toHaveLength(2);
    expect(FakeVideoDecoder.instances[0].decodeCalls[1].type).toBe('delta');
  });

  it('prepends cached CONFIG bytes to keyframe chunks (annex-b self-contained AU)', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const config = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40, 0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: config.buffer });

    const kfNal = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0xab, 0xcd]);
    d.push({ msgType: FrameMsgType.KEYFRAME, timestampMs: 100n, nalData: kfNal.buffer });

    const submitted = new Uint8Array(FakeVideoDecoder.instances[0].decodeCalls[0].data);
    expect(submitted.length).toBe(config.length + kfNal.length);
    expect(submitted[0]).toBe(0x00); // start code
    expect(submitted[config.length + 4]).toBe(0x65); // IDR header preserved at right offset
  });

  it('does NOT prepend cached CONFIG to delta chunks', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const config = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: config.buffer });
    const kfNal = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
    d.push({ msgType: FrameMsgType.KEYFRAME, timestampMs: 100n, nalData: kfNal.buffer });
    const deltaNal = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41, 0x99]);
    d.push({ msgType: FrameMsgType.DELTA, timestampMs: 200n, nalData: deltaNal.buffer });

    const deltaSubmitted = new Uint8Array(FakeVideoDecoder.instances[0].decodeCalls[1].data);
    expect(deltaSubmitted.length).toBe(deltaNal.length);
  });

  it('reports the underlying decoder queue depth (0 when unconfigured)', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    expect(d.decodeQueueSize).toBe(0);
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });
    (FakeVideoDecoder.instances[0] as any).decodeQueueSize = 7;
    expect(d.decodeQueueSize).toBe(7);
  });

  it('close() releases the underlying VideoDecoder', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });
    d.close();
    expect(FakeVideoDecoder.instances[0].state).toBe('closed');
  });

  it('reset() closes the underlying decoder, recreates it, and re-configures from cached SPS+PPS', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });

    expect(FakeVideoDecoder.instances).toHaveLength(1);
    expect(FakeVideoDecoder.instances[0].state).toBe('configured');

    d.reset();

    expect(FakeVideoDecoder.instances[0].state).toBe('closed');
    expect(FakeVideoDecoder.instances).toHaveLength(2);
    expect(FakeVideoDecoder.instances[1].state).toBe('configured');
    expect(FakeVideoDecoder.instances[1].configCalls[0].codec).toMatch(/^avc1\./);
  });

  it('drops DELTA frames after reset() until the next KEYFRAME arrives', () => {
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn() });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    const kf = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
    const delta = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41, 0x99]);

    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });
    d.push({ msgType: FrameMsgType.KEYFRAME, timestampMs: 100n, nalData: kf.buffer });
    d.push({ msgType: FrameMsgType.DELTA, timestampMs: 200n, nalData: delta.buffer });
    expect(FakeVideoDecoder.instances[0].decodeCalls).toHaveLength(2);

    d.reset();

    d.push({ msgType: FrameMsgType.DELTA, timestampMs: 300n, nalData: delta.buffer });
    expect(FakeVideoDecoder.instances[1].decodeCalls).toHaveLength(0);

    d.push({ msgType: FrameMsgType.KEYFRAME, timestampMs: 400n, nalData: kf.buffer });
    d.push({ msgType: FrameMsgType.DELTA, timestampMs: 500n, nalData: delta.buffer });
    expect(FakeVideoDecoder.instances[1].decodeCalls).toHaveLength(2);
    expect(FakeVideoDecoder.instances[1].decodeCalls[0].type).toBe('key');
    expect(FakeVideoDecoder.instances[1].decodeCalls[1].type).toBe('delta');
  });

  it('reset() invokes the onResetRequested callback exactly once', () => {
    const onResetRequested = vi.fn();
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn(), onResetRequested });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });
    d.reset();
    expect(onResetRequested).toHaveBeenCalledTimes(1);
  });

  it('a decode() throw triggers an internal reset and onResetRequested', () => {
    const onResetRequested = vi.fn();
    const onError = vi.fn();
    const d = new H264Decoder({ onFrame: vi.fn(), onError, onResetRequested });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    const kf = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65, 0x88]);
    const delta = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x41, 0x99]);

    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });
    d.push({ msgType: FrameMsgType.KEYFRAME, timestampMs: 100n, nalData: kf.buffer });

    FakeVideoDecoder.instances[0].decode = () => { throw new Error('boom'); };
    d.push({ msgType: FrameMsgType.DELTA, timestampMs: 200n, nalData: delta.buffer });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResetRequested).toHaveBeenCalledTimes(1);
    expect(FakeVideoDecoder.instances).toHaveLength(2);
    expect(FakeVideoDecoder.instances[0].state).toBe('closed');
  });

  it('async VideoDecoder error callback marks the decoder dead and fires onResetRequested', () => {
    // Regression for the "stops after ~10s" symptom: WebCodecs delivers
    // unrecoverable decode failures via the async error callback (not a
    // synchronous decode() throw) and transitions the decoder to 'closed'.
    // Previously this only logged via onError; the closed decoder was left
    // in place, and every subsequent CONFIG kept calling configure() on the
    // dead instance ("Cannot call 'decode' on a closed codec") forever.
    const onResetRequested = vi.fn();
    const onError = vi.fn();
    const d = new H264Decoder({ onFrame: vi.fn(), onError, onResetRequested });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });

    // Simulate WebCodecs async error: the browser closes the decoder, then
    // fires the error callback.
    const dead = FakeVideoDecoder.instances[0];
    dead.state = 'closed';
    dead.error(new Error('Decoding error.'));

    expect(onError).toHaveBeenCalled();
    expect(onResetRequested).toHaveBeenCalledTimes(1);

    // Next CONFIG must build a NEW VideoDecoder, not call configure on the
    // closed one (which would throw and leave us in the failure loop).
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 1000n, nalData: sps.buffer });

    expect(FakeVideoDecoder.instances).toHaveLength(2);
    expect(FakeVideoDecoder.instances[1].state).toBe('configured');
  });

  it('a stale decoder firing its error callback after reset must not tear down the replacement', () => {
    // reset() runs synchronously (e.g. from the DeviceViewer effect) and
    // swaps in a fresh decoder. Later, the OLD decoder's error callback
    // fires asynchronously. The handler must not nuke the replacement,
    // since the error refers to a decoder that's already been discarded.
    const onResetRequested = vi.fn();
    const d = new H264Decoder({ onFrame: vi.fn(), onError: vi.fn(), onResetRequested });
    const sps = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1e, 0x96, 0x35, 0x40]);
    d.push({ msgType: FrameMsgType.CONFIG, timestampMs: 0n, nalData: sps.buffer });

    const oldDecoder = FakeVideoDecoder.instances[0];

    d.reset();
    expect(onResetRequested).toHaveBeenCalledTimes(1);
    expect(FakeVideoDecoder.instances).toHaveLength(2);

    // OLD decoder's async error arrives late, referring to the dead instance.
    oldDecoder.state = 'closed';
    oldDecoder.error(new Error('Decoding error.'));

    expect(onResetRequested).toHaveBeenCalledTimes(1); // no extra reset
    expect(FakeVideoDecoder.instances).toHaveLength(2); // no extra instance
    expect(FakeVideoDecoder.instances[1].state).toBe('configured');
  });
});
