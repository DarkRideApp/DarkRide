import { describe, it, expect } from 'vitest';
import { encodeFrame, FrameMsgType, HEADER_SIZE, WIRE_VERSION } from './wire-format';

describe('encodeFrame', () => {
  it('encodes a config frame with SPS+PPS payload', () => {
    const payload = Buffer.from([0x67, 0x42, 0x00, 0x1e, 0x68, 0xce]);
    const ts = 1714400000123n;
    const out = encodeFrame(FrameMsgType.CONFIG, ts, 1, payload);
    expect(out.length).toBe(HEADER_SIZE + payload.length);
    expect(out[0]).toBe(WIRE_VERSION);
    expect(out[1]).toBe(FrameMsgType.CONFIG);
    expect(out.readBigUInt64BE(2)).toBe(ts);
    expect(out.readUInt32BE(10)).toBe(1);
    expect(out.subarray(HEADER_SIZE).equals(payload)).toBe(true);
  });

  it('encodes a keyframe with msgType=1', () => {
    const out = encodeFrame(FrameMsgType.KEYFRAME, 0n, 42, Buffer.from([0xab]));
    expect(out[0]).toBe(WIRE_VERSION);
    expect(out[1]).toBe(FrameMsgType.KEYFRAME);
    expect(out.readUInt32BE(10)).toBe(42);
  });

  it('encodes a delta frame with msgType=2', () => {
    const out = encodeFrame(FrameMsgType.DELTA, 0n, 7, Buffer.from([0xcd]));
    expect(out[1]).toBe(FrameMsgType.DELTA);
    expect(out.readUInt32BE(10)).toBe(7);
  });

  it('handles empty payload', () => {
    const out = encodeFrame(FrameMsgType.DELTA, 42n, 99, Buffer.alloc(0));
    expect(out.length).toBe(HEADER_SIZE);
    expect(out.readUInt32BE(10)).toBe(99);
  });

  it('encodes maximum frameId (2^32 - 1) without overflow', () => {
    const out = encodeFrame(FrameMsgType.DELTA, 0n, 0xFFFFFFFF, Buffer.alloc(0));
    expect(out.readUInt32BE(10)).toBe(0xFFFFFFFF);
  });
});
