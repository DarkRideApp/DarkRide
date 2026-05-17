import { describe, it, expect } from 'vitest';
import { GapDetector } from './gap-detector';
import { MAX_FRAME_ID } from './wire-format';

describe('GapDetector', () => {
  it('first frame reports firstFrame=true and zero gap', () => {
    const d = new GapDetector();
    const r = d.feed(1);
    expect(r.firstFrame).toBe(true);
    expect(r.gap).toBe(0);
    expect(r.wrapped).toBe(false);
  });

  it('reports zero gap for monotonic increments', () => {
    const d = new GapDetector();
    d.feed(1);
    expect(d.feed(2).gap).toBe(0);
    expect(d.feed(3).gap).toBe(0);
    expect(d.feed(4).gap).toBe(0);
  });

  it('reports the correct gap when frames are missing', () => {
    const d = new GapDetector();
    d.feed(1);
    expect(d.feed(2).gap).toBe(0);
    expect(d.feed(5).gap).toBe(2);  // 3 and 4 missing
    expect(d.feed(6).gap).toBe(0);
    expect(d.feed(106).gap).toBe(99);
  });

  it('does not double-count: each subsequent gap is relative to the previous frame, not the last gap', () => {
    const d = new GapDetector();
    d.feed(1);
    expect(d.feed(10).gap).toBe(8);
    expect(d.feed(20).gap).toBe(9);
  });

  it('handles a duplicate frameId as zero gap and stays put', () => {
    const d = new GapDetector();
    d.feed(1);
    d.feed(5);
    const r = d.feed(5);
    expect(r.gap).toBe(0);
    expect(d.feed(6).gap).toBe(0);
  });

  it('detects wraparound correctly', () => {
    const d = new GapDetector();
    d.feed(MAX_FRAME_ID - 2);
    expect(d.feed(MAX_FRAME_ID - 1).gap).toBe(0);
    expect(d.feed(MAX_FRAME_ID).gap).toBe(0);
    const wrapped = d.feed(1); // crossed the boundary, lost frameId 0
    expect(wrapped.wrapped).toBe(true);
    expect(wrapped.gap).toBe(0);  // MAX_FRAME_ID → 1 with no missing IDs
  });

  it('detects wraparound with a gap, accounting for skipped 0', () => {
    const d = new GapDetector();
    d.feed(MAX_FRAME_ID - 5);
    // Broadcaster sends MAX-4, MAX-3, MAX-2, MAX-1, MAX, then wraps to 1, 2, 3.
    // From prev=MAX-5 to frameId=3, missing IDs are: MAX-4, MAX-3, MAX-2, MAX-1, MAX, 1, 2 = 7 IDs.
    const wrapped = d.feed(3);
    expect(wrapped.wrapped).toBe(true);
    expect(wrapped.gap).toBe(7);
  });

  it('treats a large backwards jump as regression, not wrap', () => {
    const d = new GapDetector();
    d.feed(1_000_000);
    const r = d.feed(5);
    // Wrap-implied gap (MAX_FRAME_ID - 1_000_000 + 5) is enormous → regression.
    expect(r.wrapped).toBe(false);
    expect(r.gap).toBeLessThan(0);
  });

  it('reset() returns the detector to first-frame state', () => {
    const d = new GapDetector();
    d.feed(100);
    d.feed(101);
    d.reset();
    expect(d.feed(50).firstFrame).toBe(true);
  });

  it('exposes the last seen frameId', () => {
    const d = new GapDetector();
    expect(d.last).toBeNull();
    d.feed(1);
    expect(d.last).toBe(1);
    d.feed(5);
    expect(d.last).toBe(5);
  });
});
