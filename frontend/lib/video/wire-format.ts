export enum FrameMsgType {
  CONFIG = 0,
  KEYFRAME = 1,
  DELTA = 2,
}

export const WIRE_VERSION = 2;
export const HEADER_SIZE = 14;
export const MAX_FRAME_ID = 0xFFFFFFFF;

export interface DecodedFrame {
  msgType: FrameMsgType;
  timestampMs: bigint;
  frameId: number;
  nalData: ArrayBuffer;
}

export class WireVersionMismatchError extends Error {
  readonly received: number;
  readonly expected: number = WIRE_VERSION;
  constructor(received: number) {
    super(`Wire format version mismatch: received ${received}, expected ${WIRE_VERSION}`);
    this.name = 'WireVersionMismatchError';
    this.received = received;
  }
}

/**
 * Decode a binary frame message (wire format v2):
 *   [0]      version (uint8) = WIRE_VERSION
 *   [1]      msgType (uint8)
 *   [2..9]   captureTimestamp (uint64 BE, ms)
 *   [10..13] frameId (uint32 BE)
 *   [14..]   NAL data
 *
 * Throws WireVersionMismatchError when the version byte does not match. This
 * surfaces backend/frontend protocol drift (e.g. during dev-time HMR) as a
 * typed error rather than mis-parsing the body as garbage.
 */
export function decodeFrame(buf: ArrayBuffer): DecodedFrame {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error(`Frame buffer too small: ${buf.byteLength} bytes`);
  }
  const view = new DataView(buf);
  const version = view.getUint8(0);
  if (version !== WIRE_VERSION) {
    throw new WireVersionMismatchError(version);
  }
  const msgType = view.getUint8(1) as FrameMsgType;
  const timestampMs = view.getBigUint64(2, false);
  const frameId = view.getUint32(10, false);
  const nalData = buf.slice(HEADER_SIZE);
  return { msgType, timestampMs, frameId, nalData };
}
