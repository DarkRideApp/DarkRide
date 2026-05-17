import { describe, it, expect } from 'vitest';
import { decodeFrame, FrameMsgType, HEADER_SIZE, WIRE_VERSION, WireVersionMismatchError } from './wire-format';

function buildMessage(msgType: number, ts: bigint, frameId: number, payload: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_SIZE + payload.length);
  const view = new DataView(buf);
  view.setUint8(0, WIRE_VERSION);
  view.setUint8(1, msgType);
  view.setBigUint64(2, ts, false);
  view.setUint32(10, frameId, false);
  new Uint8Array(buf, HEADER_SIZE).set(payload);
  return buf;
}

describe('decodeFrame', () => {
  it('decodes a config frame', () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const msg = buildMessage(0, 1714400000123n, 1, payload);
    const f = decodeFrame(msg);
    expect(f.msgType).toBe(FrameMsgType.CONFIG);
    expect(f.timestampMs).toBe(1714400000123n);
    expect(f.frameId).toBe(1);
    expect(new Uint8Array(f.nalData)).toEqual(payload);
  });

  it('decodes a keyframe', () => {
    const msg = buildMessage(1, 0n, 42, new Uint8Array([0x12]));
    const f = decodeFrame(msg);
    expect(f.msgType).toBe(FrameMsgType.KEYFRAME);
    expect(f.frameId).toBe(42);
  });

  it('decodes a delta frame', () => {
    const msg = buildMessage(2, 0n, 7, new Uint8Array([0x34]));
    const f = decodeFrame(msg);
    expect(f.msgType).toBe(FrameMsgType.DELTA);
    expect(f.frameId).toBe(7);
  });

  it('decodes maximum frameId without sign loss', () => {
    const msg = buildMessage(2, 0n, 0xFFFFFFFF, new Uint8Array([]));
    expect(decodeFrame(msg).frameId).toBe(0xFFFFFFFF);
  });

  it('throws on under-size buffer', () => {
    expect(() => decodeFrame(new ArrayBuffer(5))).toThrow();
  });

  it('throws WireVersionMismatchError when version byte is wrong', () => {
    const buf = new ArrayBuffer(HEADER_SIZE);
    new DataView(buf).setUint8(0, 99); // wrong version
    expect(() => decodeFrame(buf)).toThrow(WireVersionMismatchError);
  });
});
