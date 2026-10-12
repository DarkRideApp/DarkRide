import { describe, it, expect } from 'vitest';
import { clampToViewport } from './viewportClamp';

describe('clampToViewport', () => {
  const viewport = { width: 1280, height: 720 };
  const size = { width: 300, height: 400 };

  it('leaves a position unchanged when the popover already fits fully on screen', () => {
    expect(clampToViewport({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 });
  });

  it('pulls the right edge back on screen when x would overflow', () => {
    const result = clampToViewport({ x: 1200, y: 100 }, size, viewport);
    expect(result.x).toBe(1280 - 300 - 8);
  });

  it('pulls the bottom edge back on screen when y would overflow', () => {
    const result = clampToViewport({ x: 100, y: 650 }, size, viewport);
    expect(result.y).toBe(720 - 400 - 8);
  });

  it('never pushes a position negative, even if the popover is wider than the viewport', () => {
    const hugePopover = { width: 2000, height: 2000 };
    const result = clampToViewport({ x: 5, y: 5 }, hugePopover, viewport);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
  });

  it('respects a custom margin', () => {
    const result = clampToViewport({ x: 1200, y: 100 }, size, viewport, 20);
    expect(result.x).toBe(1280 - 300 - 20);
  });
});
