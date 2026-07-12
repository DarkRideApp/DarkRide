import type { StreamRenderer } from './stream-controller';

/** A canvas that both HTMLCanvasElement and OffscreenCanvas satisfy. */
export interface DrawableCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): { drawImage(image: CanvasImageSource, dx: number, dy: number): void } | null;
}

export interface BitmapRenderer extends StreamRenderer {
  /** Draw a decoded still (polling/minicap JPEG path) and release it. */
  drawBitmap(bitmap: ImageBitmap): void;
}

/**
 * Renderer that paints decoded frames to a 2D canvas and always releases the
 * source (VideoFrame / ImageBitmap) afterwards — holding frames open exhausts
 * the decoder's GPU-backed pool and stalls it. `getCanvas` is a thunk so the
 * same renderer survives the canvas ref changing across React renders. Works
 * unchanged against an OffscreenCanvas inside a Worker.
 */
export function createCanvasRenderer(getCanvas: () => DrawableCanvas | null): BitmapRenderer {
  return {
    drawFrame(frame: VideoFrame): void {
      try {
        const canvas = getCanvas();
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
        if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
        ctx.drawImage(frame, 0, 0);
      } finally {
        frame.close();
      }
    },
    drawBitmap(bitmap: ImageBitmap): void {
      try {
        const canvas = getCanvas();
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
    },
  };
}
