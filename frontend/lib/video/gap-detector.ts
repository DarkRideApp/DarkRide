import { MAX_FRAME_ID } from './wire-format';

export interface FeedResult {
  /** True when this is the first frame fed; gap is meaningless. */
  firstFrame: boolean;
  /** Number of frame IDs missing between the previous frame and this one.
   *  0 = monotonic with no gap. Negative = regression (received frameId is
   *  ≤ the previous one); only happens at wraparound or genuine reordering. */
  gap: number;
  /** True iff the broadcaster's wire counter wrapped between the previous
   *  frame and this one. Computed only when the gap, modulo wrap, is small
   *  relative to the wrap distance — otherwise we treat it as a real regression. */
  wrapped: boolean;
}

/**
 * Tracks the last seen wire-format frameId and reports gaps. Pure state — no
 * I/O, no timers. Designed to be called from the WebSocket binary handler
 * before the chunk is handed to the decoder.
 *
 * Wraparound: at 60fps a uint32 counter takes ~828 days to wrap, so this is
 * theoretical for any single session. We still handle it explicitly: if a
 * received frameId is well below the previous one *and* the implied wrap
 * distance is small, we treat it as a wrap rather than a regression.
 */
export class GapDetector {
  private lastFrameId: number | null = null;

  /** Heuristic threshold for distinguishing wrap from regression. A gap larger
   *  than this implies the broadcaster's counter was reset (e.g. stream
   *  restart), not a wrap. A regression smaller than this implies genuine
   *  reordering, not a wrap. */
  static readonly WRAP_THRESHOLD = 1_000_000;

  feed(frameId: number): FeedResult {
    if (this.lastFrameId === null) {
      this.lastFrameId = frameId;
      return { firstFrame: true, gap: 0, wrapped: false };
    }

    const prev = this.lastFrameId;
    let gap: number;
    let wrapped = false;

    if (frameId > prev) {
      // Forward — gap = received - prev - 1. Either monotonic (gap=0) or drops in between.
      gap = frameId - prev - 1;
    } else if (frameId === prev) {
      // Same ID twice — abnormal (duplicate); report as zero gap, stays put.
      gap = 0;
    } else {
      // frameId < prev. Either wraparound or a genuine regression/reset.
      // The broadcaster wraps MAX_FRAME_ID → 1 (skipping 0), so the count of
      // missing IDs across the wrap is (MAX − prev) on the high side plus
      // (frameId − 1) on the low side.
      const wrapImpliedGap = (MAX_FRAME_ID - prev) + (frameId - 1);
      if (wrapImpliedGap < GapDetector.WRAP_THRESHOLD) {
        gap = wrapImpliedGap;
        wrapped = true;
      } else {
        // Treat as regression — broadcaster counter was reset, or out-of-order delivery.
        gap = frameId - prev; // negative
      }
    }

    this.lastFrameId = frameId;
    return { firstFrame: false, gap, wrapped };
  }

  /** Reset the detector — call when the underlying stream is intentionally
   *  reset (e.g. user-triggered stream restart) so the next frame is treated
   *  as a fresh start rather than a giant regression. */
  reset(): void {
    this.lastFrameId = null;
  }

  get last(): number | null {
    return this.lastFrameId;
  }
}
