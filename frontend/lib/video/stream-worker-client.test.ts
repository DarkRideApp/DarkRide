import { describe, it, expect, vi } from 'vitest';
import { createStreamWorkerClient } from './stream-worker-client';

function fakeWorker() {
  return {
    onmessage: null as ((e: { data: any }) => void) | null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
}

function fakeCanvas() {
  const off = { _offscreen: true };
  return { off, transferControlToOffscreen: vi.fn(() => off) };
}

function setup() {
  const worker = fakeWorker();
  const canvas = fakeCanvas();
  const cb = { onKeyframe: vi.fn(), onConfig: vi.fn(), onRendered: vi.fn() };
  const client = createStreamWorkerClient(canvas as any, cb, () => worker as any);
  return { worker, canvas, cb, client };
}

describe('createStreamWorkerClient', () => {
  it('transfers the canvas and posts init with the offscreen in the transfer list', () => {
    const { worker, canvas } = setup();
    expect(canvas.transferControlToOffscreen).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith(
      { type: 'init', canvas: canvas.off },
      [canvas.off],
    );
  });

  it('forwards binary frames to the worker', () => {
    const { worker, client } = setup();
    const data = new ArrayBuffer(14);
    client.feedBinary(data);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'frame', data });
  });

  it('routes a worker keyframe message to onKeyframe', () => {
    const { worker, cb } = setup();
    worker.onmessage!({ data: { type: 'keyframe', reason: 'gap', gap: 3 } });
    expect(cb.onKeyframe).toHaveBeenCalledWith('gap', 3);
  });

  it('routes a worker config message to onConfig', () => {
    const { worker, cb } = setup();
    worker.onmessage!({ data: { type: 'config' } });
    expect(cb.onConfig).toHaveBeenCalledTimes(1);
  });

  it('routes a worker rendered message to onRendered', () => {
    const { worker, cb } = setup();
    worker.onmessage!({ data: { type: 'rendered' } });
    expect(cb.onRendered).toHaveBeenCalledTimes(1);
  });

  it('close posts close and terminates the worker', () => {
    const { worker, client } = setup();
    client.close();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'close' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('reset posts reset', () => {
    const { worker, client } = setup();
    client.reset();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'reset' });
  });
});
