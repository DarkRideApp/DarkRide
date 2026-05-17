/**
 * scrcpy 2.7 control protocol — single-byte type prefix per message.
 *
 * RESET_VIDEO instructs the encoder to emit an immediate IDR keyframe on
 * the next frame. The message body is empty; this is the entire wire
 * payload (no length prefix, no fields).
 *
 * Source: scrcpy/server/src/main/java/com/genymobile/scrcpy/control/
 *         ControlMessage.java — TYPE_RESET_VIDEO = 17 in v2.7.
 */
export const RESET_VIDEO_BYTE = 0x11;
