import { describe, it, expect } from 'vitest';
import { decideAction, BackpressureState, ViewerState, HIGH_WATER, LOW_WATER, HARD_CAP } from './backpressure';

function makeState(overrides: Partial<ViewerState> = {}): ViewerState {
  return {
    state: BackpressureState.NORMAL,
    droppingSinceMs: 0,
    droppedKeyframes: 0,
    ...overrides,
  };
}

describe('decideAction', () => {
  it('sends a delta frame in NORMAL when bufferedAmount is low', () => {
    const result = decideAction(makeState(), 'delta', 1000, 100_000);
    expect(result.action).toBe('send');
    expect(result.next.state).toBe(BackpressureState.NORMAL);
  });

  it('transitions NORMAL → DROPPING when bufferedAmount crosses HIGH', () => {
    const result = decideAction(makeState(), 'delta', 1000, HIGH_WATER + 1);
    expect(result.action).toBe('drop');
    expect(result.next.state).toBe(BackpressureState.DROPPING);
    expect(result.next.droppingSinceMs).toBe(1000);
  });

  it('drops delta frames while in DROPPING', () => {
    const state = makeState({ state: BackpressureState.DROPPING, droppingSinceMs: 500 });
    const result = decideAction(state, 'delta', 1000, 100);
    expect(result.action).toBe('drop');
    expect(result.next.state).toBe(BackpressureState.DROPPING);
  });

  it('drops keyframe in DROPPING when buffer not yet drained', () => {
    const state = makeState({ state: BackpressureState.DROPPING, droppingSinceMs: 500 });
    const result = decideAction(state, 'keyframe', 1000, LOW_WATER + 1);
    expect(result.action).toBe('drop');
    expect(result.next.droppedKeyframes).toBe(1);
  });

  it('resumes on keyframe when buffer drained below LOW', () => {
    const state = makeState({ state: BackpressureState.DROPPING, droppingSinceMs: 500 });
    const result = decideAction(state, 'keyframe', 1000, LOW_WATER - 1);
    expect(result.action).toBe('send');
    expect(result.next.state).toBe(BackpressureState.NORMAL);
  });

  it('keeps dropping (never resets) after a long time in DROPPING', () => {
    // A slow viewer must never restart the shared encoder — it just keeps
    // dropping until its buffer drains, then resyncs on a keyframe.
    const state = makeState({ state: BackpressureState.DROPPING, droppingSinceMs: 1000 });
    const result = decideAction(state, 'delta', 11_001, HIGH_WATER + 1);
    expect(result.action).toBe('drop');
    expect(result.next.state).toBe(BackpressureState.DROPPING);
  });

  it('keeps dropping (never resets) after many dropped keyframes', () => {
    const state = makeState({
      state: BackpressureState.DROPPING,
      droppingSinceMs: 500,
      droppedKeyframes: 4,
    });
    const result = decideAction(state, 'keyframe', 1000, HIGH_WATER + 1);
    expect(result.action).toBe('drop');
    expect(result.next.state).toBe(BackpressureState.DROPPING);
    expect(result.next.droppedKeyframes).toBe(5);
  });

  it('drops (does not reset) even at HARD_CAP — resyncs on a drained keyframe', () => {
    const result = decideAction(makeState(), 'delta', 1000, HARD_CAP + 1);
    expect(result.action).toBe('drop');
    expect(result.next.state).toBe(BackpressureState.DROPPING);
  });

  it('never returns a reset action under sustained congestion', () => {
    let state = makeState();
    // Hammer it with 500 congested frames across a long span; must never reset.
    for (let i = 0; i < 500; i++) {
      const kind = i % 60 === 0 ? 'keyframe' as const : 'delta' as const;
      const r = decideAction(state, kind, 1000 + i * 33, HIGH_WATER * 2);
      expect(r.action).not.toBe('reset');
      state = r.next;
    }
  });

  it('config frames always send', () => {
    const result = decideAction(makeState(), 'config', 1000, 100);
    expect(result.action).toBe('send');
  });
});
