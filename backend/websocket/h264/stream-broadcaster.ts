import type { WebSocket } from 'ws';
import { parseNalUnits, NalType, NalUnit } from './nal-parser';
import { encodeFrame, FrameMsgType, MAX_FRAME_ID } from './wire-format';
import {
  decideAction, newViewerState, ViewerState, BackpressureState, FrameKind,
} from './backpressure';

export interface BroadcasterOptions {
  onResetRequested?: (viewerId: string) => void;
  /** Fired when a viewer joins, so the caller can ask the encoder for an
   *  immediate IDR. Without this, a viewer joining a running stream waits up
   *  to a full GOP (i-frame-interval) before its first decodable frame. */
  onKeyframeWanted?: (viewerId: string) => void;
  /** Periodic count of video frames (IDR + non-IDR) ingested from scrcpy —
   *  i.e. the encoder's actual output rate, before any per-viewer drops. */
  onIngestStats?: (info: { fps: number; frames: number }) => void;
}

const INGEST_STATS_INTERVAL_MS = 2000;

interface Viewer {
  ws: WebSocket;
  state: ViewerState;
  hasReceivedKeyframe: boolean;
  /** Per-viewer monotonic frame ID. Allocated for every frame considered for
   *  this viewer (sent or dropped) so a downstream gap detector can observe
   *  drops directly. Wraps at MAX_FRAME_ID. */
  nextFrameId: number;
}

export class StreamBroadcaster {
  private viewers = new Map<string, Viewer>();
  private cachedSps: Buffer | null = null;
  private cachedPps: Buffer | null = null;
  private leftover = Buffer.alloc(0);
  private opts: BroadcasterOptions;
  private now: () => number;
  private ingestFrames = 0;
  private ingestStatsStartMs: number | null = null;

  constructor(now: () => number = () => Date.now(), opts: BroadcasterOptions = {}) {
    this.now = now;
    this.opts = opts;
  }

  addViewer(viewerId: string, ws: WebSocket): void {
    this.viewers.set(viewerId, {
      ws,
      state: newViewerState(),
      hasReceivedKeyframe: false,
      nextFrameId: 1,
    });
    if (this.cachedSps && this.cachedPps) {
      const config = Buffer.concat([
        this.cachedSps,
        this.cachedPps,
      ]);
      this.sendToViewer(viewerId, FrameMsgType.CONFIG, config);
    }
    // Ask the encoder for a fresh IDR so this viewer gets a decodable frame
    // without waiting for the next natural keyframe. Cached config alone is
    // not decodable until a keyframe follows.
    this.opts.onKeyframeWanted?.(viewerId);
  }

  removeViewer(viewerId: string): void {
    this.viewers.delete(viewerId);
  }

  hasViewer(viewerId: string): boolean {
    return this.viewers.has(viewerId);
  }

  reset(): void {
    this.viewers.clear();
    this.cachedSps = null;
    this.cachedPps = null;
    this.leftover = Buffer.alloc(0);
  }

  /**
   * Ingest a chunk of Annex-B H.264 from scrcpy. Parses NAL units, caches the
   * latest SPS/PPS, broadcasts CONFIG before any KEYFRAME so the decoder is
   * configured first, and then KEYFRAME / DELTA frames per viewer (subject to
   * backpressure). Trailing 0x00 bytes are held back to handle a partial start
   * code split across chunk boundaries.
   */
  ingest(chunk: Buffer): void {
    // NAL boundaries can fall on TCP segment boundaries. We hold back trailing
    // 0x00 bytes — up to 3 — that might be the prefix of an incoming start code
    // (00 01, 00 00 01, or 00 00 00 01). Anything else is safe to parse: a NAL
    // payload byte that happens to be non-zero cannot be the start of a code.
    const buf = Buffer.concat([this.leftover, chunk]);

    let holdback = 0;
    while (holdback < 3 && holdback < buf.length && buf[buf.length - 1 - holdback] === 0x00) {
      holdback++;
    }
    this.leftover = holdback > 0 ? Buffer.from(buf.subarray(buf.length - holdback)) : Buffer.alloc(0);
    const complete = buf.subarray(0, buf.length - holdback);

    const units = parseNalUnits(complete);
    if (units.length === 0) return;

    let pendingSps: NalUnit | null = null;
    let pendingPps: NalUnit | null = null;

    for (const u of units) {
      if (u.type === NalType.SPS) {
        pendingSps = u;
        this.cachedSps = withStartCode(u.data);
        continue;
      }
      if (u.type === NalType.PPS) {
        pendingPps = u;
        this.cachedPps = withStartCode(u.data);
        continue;
      }
      if (u.type === NalType.IDR) {
        // When SPS+PPS accompany the IDR, emit CONFIG first so viewers
        // receive decoder config before the keyframe in every case.
        if (pendingSps && pendingPps) {
          const config = Buffer.concat([withStartCode(pendingSps.data), withStartCode(pendingPps.data)]);
          this.broadcast(FrameMsgType.CONFIG, config);
        }
        this.broadcast(FrameMsgType.KEYFRAME, withStartCode(u.data));
        this.ingestFrames++;
        pendingSps = null;
        pendingPps = null;
        continue;
      }
      if (u.type === NalType.NON_IDR) {
        this.broadcast(FrameMsgType.DELTA, withStartCode(u.data));
        this.ingestFrames++;
        continue;
      }
      // Ignore SEI, AUD, etc.
    }

    // If SPS+PPS arrived without an IDR in this batch, send config-only so
    // late-joining viewers also get fresh config when SPS/PPS rotate.
    if (pendingSps && pendingPps) {
      const config = Buffer.concat([withStartCode(pendingSps.data), withStartCode(pendingPps.data)]);
      this.broadcast(FrameMsgType.CONFIG, config);
    }

    this.maybeEmitIngestStats();
  }

  /** Emit encoder output rate ~once per interval. Measures scrcpy's actual
   *  frame delivery, independent of viewers or per-viewer backpressure. */
  private maybeEmitIngestStats(): void {
    if (!this.opts.onIngestStats) return;
    const now = this.now();
    if (this.ingestStatsStartMs === null) { this.ingestStatsStartMs = now; return; }
    const elapsed = now - this.ingestStatsStartMs;
    if (elapsed < INGEST_STATS_INTERVAL_MS) return;
    this.opts.onIngestStats({ fps: (this.ingestFrames * 1000) / elapsed, frames: this.ingestFrames });
    this.ingestStatsStartMs = now;
    this.ingestFrames = 0;
  }

  private broadcast(msgType: FrameMsgType, nalData: Buffer): void {
    for (const [viewerId] of this.viewers) {
      this.sendToViewer(viewerId, msgType, nalData);
    }
  }

  private sendToViewer(viewerId: string, msgType: FrameMsgType, nalData: Buffer): void {
    const viewer = this.viewers.get(viewerId);
    if (!viewer || viewer.ws.readyState !== 1) return;

    const kind: FrameKind = msgType === FrameMsgType.CONFIG ? 'config'
      : msgType === FrameMsgType.KEYFRAME ? 'keyframe' : 'delta';

    // Allocate a frameId for every frame considered, regardless of whether we
    // actually send it. A downstream viewer sees the gap between the last sent
    // frameId and the next one, which is how drops here become observable
    // upstream of the WebSocket.
    const frameId = viewer.nextFrameId;
    viewer.nextFrameId = viewer.nextFrameId >= MAX_FRAME_ID ? 1 : viewer.nextFrameId + 1;

    const result = decideAction(viewer.state, kind, this.now(), viewer.ws.bufferedAmount);
    viewer.state = result.next;

    if (result.action === 'reset') {
      this.opts.onResetRequested?.(viewerId);
      return;
    }
    if (result.action === 'drop') return;

    // Don't send delta frames to a viewer that hasn't yet received a keyframe.
    if (kind === 'delta' && !viewer.hasReceivedKeyframe) return;

    const message = encodeFrame(msgType, BigInt(this.now()), frameId, nalData);
    viewer.ws.send(message);
    if (kind === 'keyframe') viewer.hasReceivedKeyframe = true;
  }

  /** All viewers in NORMAL state. Returns false when no viewers (no health data to make a claim). */
  isHealthy(): boolean {
    if (this.viewers.size === 0) return false;
    for (const v of this.viewers.values()) {
      if (v.state.state !== BackpressureState.NORMAL) return false;
    }
    return true;
  }
}

const SC4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);

function withStartCode(nalData: Buffer): Buffer {
  return Buffer.concat([SC4, nalData]);
}

