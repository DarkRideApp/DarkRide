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

  it('triggers RESET_PENDING after 10s in DROPPING', () => {
    const state = makeState({ state: BackpressureState.DROPPING, droppingSinceMs: 1000 });
    const result = decideAction(state, 'delta', 11_001, HIGH_WATER + 1);
    expect(result.action).toBe('reset');
    expect(result.next.state).toBe(BackpressureState.RESET_PENDING);
  });

  it('triggers RESET_PENDING after 5 dropped keyframes', () => {
    const state = makeState({
      state: BackpressureState.DROPPING,
      droppingSinceMs: 500,
      droppedKeyframes: 4,
    });
    const result = decideAction(state, 'keyframe', 1000, HIGH_WATER + 1);
    expect(result.action).toBe('reset');
    expect(result.next.droppedKeyframes).toBe(5);
  });

  it('triggers RESET_PENDING immediately at HARD_CAP regardless of state', () => {
    const result = decideAction(makeState(), 'delta', 1000, HARD_CAP + 1);
    expect(result.action).toBe('reset');
  });

  it('config frames always send', () => {
    const result = decideAction(makeState(), 'config', 1000, 100);
    expect(result.action).toBe('send');
  });
});
