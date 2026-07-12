/**
 * scrcpy control protocol — single-byte type prefix per message.
 *
 * RESET_VIDEO instructs the encoder to emit an immediate IDR keyframe on
 * the next frame. The message body is empty; this is the entire wire
 * payload (no length prefix, no fields).
 *
 * Source: scrcpy/server/src/main/java/com/genymobile/scrcpy/control/
 *         ControlMessage.java — TYPE_RESET_VIDEO. Added in v2.7 as ordinal
 *         17; verified unchanged (still 17) through v3.3.1, which is the
 *         version we spawn (see SCRCPY_VERSION in vendor-manager.ts).
 */
export const RESET_VIDEO_BYTE = 0x11;
