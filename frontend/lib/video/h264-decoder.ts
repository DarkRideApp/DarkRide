import { DecodedFrame, FrameMsgType } from './wire-format';

export interface H264DecoderOptions {
  onFrame: (frame: VideoFrame) => void;
  onError: (e: Error) => void;
  /** Called when the decoder requests an upstream keyframe. Fires whenever
   *  the decoder resets itself — explicitly via reset() or implicitly when
   *  a decode() call throws. The DeviceViewer wires this to KeyframeTrigger. */
  onResetRequested?: () => void;
}

/**
 * Wraps WebCodecs VideoDecoder. Accepts CONFIG/KEYFRAME/DELTA messages from
 * the backend, configures on first SPS, queues pre-config frames, and decodes
 * once configured.
 *
 * In Annex-B mode (no `description` field on configure()), Chrome's WebCodecs
 * does NOT carry SPS+PPS state across EncodedVideoChunks — every IDR chunk
 * must be a self-contained access unit. The backend emits CONFIG and KEYFRAME
 * separately; we cache the most recent CONFIG bytes and prepend them to each
 * KEYFRAME chunk before submitting to decoder.decode().
 *
 * Recovery: reset() (or an internally-caught decode() throw) closes the
 * underlying VideoDecoder, recreates and reconfigures it from cached
 * SPS+PPS, and gates DELTAs until the next KEYFRAME arrives. The
 * onResetRequested callback fires once per reset so the caller can
 * request an upstream keyframe.
 */
export class H264Decoder {
  private decoder: VideoDecoder | null = null;
  private pendingChunks: EncodedVideoChunk[] = [];
  private hasKeyframe = false;
  private cachedConfig: Uint8Array | null = null;
  private pendingKeyframe = false;
  private opts: H264DecoderOptions;

  constructor(opts: H264DecoderOptions) {
    this.opts = opts;
  }

  push(frame: DecodedFrame): void {
    if (frame.msgType === FrameMsgType.CONFIG) {
      this.cachedConfig = new Uint8Array(frame.nalData);
      this.configureFromSps(frame.nalData);
      return;
    }

    // Drop DELTAs while we're waiting for a fresh keyframe after reset.
    if (this.pendingKeyframe && frame.msgType === FrameMsgType.DELTA) {
      return;
    }

    // For KEYFRAME, prepend cached SPS+PPS so the chunk is a complete access
    // unit (Annex-B requirement for WebCodecs without a description config).
    let chunkData: ArrayBuffer = frame.nalData;
    if (frame.msgType === FrameMsgType.KEYFRAME && this.cachedConfig) {
      const nal = new Uint8Array(frame.nalData);
      const merged = new Uint8Array(this.cachedConfig.length + nal.length);
      merged.set(this.cachedConfig, 0);
      merged.set(nal, this.cachedConfig.length);
      chunkData = merged.buffer;
    }

    const chunk = new EncodedVideoChunk({
      type: frame.msgType === FrameMsgType.KEYFRAME ? 'key' : 'delta',
      timestamp: Number(frame.timestampMs) * 1000, // microseconds
      data: chunkData,
    });

    if (frame.msgType === FrameMsgType.KEYFRAME) {
      this.hasKeyframe = true;
      this.pendingKeyframe = false;
    } else if (!this.hasKeyframe) {
      // Delta arrived before any keyframe — undecodable, drop.
      return;
    }

    if (this.decoder?.state === 'configured') {
      try {
        this.decoder.decode(chunk);
      } catch (e: any) {
        this.opts.onError(e);
        // Decoder is now in a corrupt state. Recreate it and ask upstream
        // for a fresh keyframe so we can resume cleanly.
        this.reset();
      }
    } else {
      this.pendingChunks.push(chunk);
    }
  }

  /**
   * Tear down the underlying VideoDecoder and recreate it from cached
   * SPS+PPS. Drops any queued chunks (they're bound to the dead decoder).
   * Sets pendingKeyframe so DELTAs are dropped until the next IDR. Fires
   * onResetRequested.
   */
  reset(): void {
    this.markDecoderDead();
    if (this.cachedConfig) {
      this.configureFromSps(this.cachedConfig.buffer.slice(
        this.cachedConfig.byteOffset,
        this.cachedConfig.byteOffset + this.cachedConfig.byteLength,
      ));
    }
  }

  /**
   * Drop the underlying VideoDecoder reference (closing it if still open),
   * clear queued state, and signal the caller to request a fresh keyframe.
   * Distinct from reset() in that it does NOT eagerly recreate the decoder;
   * a subsequent CONFIG will create a fresh one. Used by the async error
   * recovery path where the browser has already moved the decoder to
   * 'closed' and trying to reuse it throws.
   */
  private markDecoderDead(): void {
    if (this.decoder) {
      try { this.decoder.close(); } catch { /* may already be closed */ }
    }
    this.decoder = null;
    this.pendingChunks = [];
    this.hasKeyframe = false;
    this.pendingKeyframe = true;
    this.opts.onResetRequested?.();
  }

  close(): void {
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch { /* ignore */ }
    }
    this.decoder = null;
    this.pendingChunks = [];
    this.hasKeyframe = false;
    this.pendingKeyframe = false;
    this.cachedConfig = null;
  }

  private configureFromSps(configData: ArrayBuffer): void {
    const profileIdc = findProfileIdc(new Uint8Array(configData));
    const codecString = profileIdc ? `avc1.${profileIdc.toString(16).padStart(6, '0').toUpperCase()}` : 'avc1.42E01E';

    if (!this.decoder) {
      // Capture the decoder identity in the closure so a late async error
      // from a previously-replaced decoder doesn't tear down its successor.
      // Without this guard, an explicit reset() followed by the OLD decoder's
      // async error callback would nuke the fresh replacement and loop.
      let myDecoder: VideoDecoder | null = null;
      myDecoder = new VideoDecoder({
        output: (frame) => { this.opts.onFrame(frame); },
        error: (e) => {
          this.opts.onError(e);
          // WebCodecs has moved this decoder to 'closed' and won't recover.
          // Only act if we're still the active decoder.
          if (this.decoder === myDecoder) {
            this.markDecoderDead();
          }
        },
      });
      this.decoder = myDecoder;
    }

    try {
      this.decoder.configure({ codec: codecString, optimizeForLatency: true });
    } catch (e: any) {
      this.opts.onError(e);
      // The decoder is unusable (typically closed). Drop our reference so
      // the next CONFIG builds a fresh one instead of looping on a dead
      // codec, and ask upstream for a keyframe to drive that next CONFIG.
      this.markDecoderDead();
      return;
    }

    // Replay any pending chunks
    for (const chunk of this.pendingChunks) {
      try {
        this.decoder.decode(chunk);
      } catch (e: any) {
        this.opts.onError(e);
      }
    }
    this.pendingChunks = [];
  }
}

/**
 * Find the SPS NAL unit in Annex-B config data and extract
 * profile_idc / profile_iop / level_idc to build the avc1.XXXXXX codec string.
 */
function findProfileIdc(data: Uint8Array): number | null {
  for (let i = 0; i + 6 < data.length; i++) {
    const sc4 = data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1;
    const sc3 = !sc4 && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (!sc4 && !sc3) continue;
    const headerOff = i + (sc4 ? 4 : 3);
    if ((data[headerOff] & 0x1f) === 7) {
      const profileIdc = data[headerOff + 1];
      const profileIop = data[headerOff + 2];
      const levelIdc = data[headerOff + 3];
      return (profileIdc << 16) | (profileIop << 8) | levelIdc;
    }
  }
  return null;
}
