import { describe, it, expect, vi } from 'vitest';
import { createCanvasRenderer } from './canvas-renderer';

function fakeCanvas() {
  const ctx = { drawImage: vi.fn() };
  return { width: 0, height: 0, getContext: vi.fn(() => ctx), _ctx: ctx };
}

describe('createCanvasRenderer', () => {
  it('draws a VideoFrame and closes it', () => {
    const canvas = fakeCanvas();
    const r = createCanvasRenderer(() => canvas as any);
    const frame = { displayWidth: 100, displayHeight: 200, close: vi.fn() } as any;
    r.drawFrame(frame);
    expect(canvas._ctx.drawImage).toHaveBeenCalledWith(frame, 0, 0);
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it('resizes the canvas to the frame dimensions', () => {
    const canvas = fakeCanvas();
    const r = createCanvasRenderer(() => canvas as any);
    r.drawFrame({ displayWidth: 640, displayHeight: 480, close: vi.fn() } as any);
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
  });

  it('closes the frame even when there is no canvas (never leaks decoder slots)', () => {
    const r = createCanvasRenderer(() => null);
    const frame = { displayWidth: 1, displayHeight: 1, close: vi.fn() } as any;
    r.drawFrame(frame);
    expect(frame.close).toHaveBeenCalledTimes(1);
  });

  it('draws an ImageBitmap and closes it', () => {
    const canvas = fakeCanvas();
    const r = createCanvasRenderer(() => canvas as any);
    const bmp = { width: 320, height: 240, close: vi.fn() } as any;
    r.drawBitmap(bmp);
    expect(canvas._ctx.drawImage).toHaveBeenCalledWith(bmp, 0, 0);
    expect(canvas.width).toBe(320);
    expect(bmp.close).toHaveBeenCalledTimes(1);
  });
});
