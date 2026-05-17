export enum FrameMsgType {
  CONFIG = 0,
  KEYFRAME = 1,
  DELTA = 2,
}

export const WIRE_VERSION = 2;
export const HEADER_SIZE = 14; // 1 version + 1 msgType + 8 timestamp + 4 frameId

export const MAX_FRAME_ID = 0xFFFFFFFF;

/**
 * Encode a binary frame message (wire format v2):
 *   [0]      version (uint8) = WIRE_VERSION
 *   [1]      msgType (uint8) — CONFIG=0, KEYFRAME=1, DELTA=2
 *   [2..9]   captureTimestamp (uint64 BE, ms)
 *   [10..13] frameId (uint32 BE) — per-viewer monotonic, wraps at 2^32
 *   [14..]   NAL data (Annex-B, with start code prefix)
 *
 * frameId is allocated by the broadcaster for every frame it considers — sent
 * or dropped — so a downstream gap detector can observe drops directly.
 */
export function encodeFrame(
  msgType: FrameMsgType,
  timestampMs: bigint,
  frameId: number,
  nalData: Buffer,
): Buffer {
  const out = Buffer.allocUnsafe(HEADER_SIZE + nalData.length);
  out[0] = WIRE_VERSION;
  out[1] = msgType;
  out.writeBigUInt64BE(timestampMs, 2);
  out.writeUInt32BE(frameId >>> 0, 10);
  nalData.copy(out, HEADER_SIZE);
  return out;
}
