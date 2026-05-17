export enum BackpressureState {
  NORMAL = 'NORMAL',
  DROPPING = 'DROPPING',
  RESET_PENDING = 'RESET_PENDING',
}

export interface ViewerState {
  state: BackpressureState;
  droppingSinceMs: number;
  droppedKeyframes: number;
}

export type FrameKind = 'config' | 'keyframe' | 'delta';
export type Action = 'send' | 'drop' | 'reset';

export const HIGH_WATER = 2 * 1024 * 1024;     // 2 MB
export const LOW_WATER = 256 * 1024;            // 256 KB
export const HARD_CAP = 8 * 1024 * 1024;        // 8 MB
export const DROPPING_RESET_AFTER_MS = 10_000;  // 10s
export const RESET_AFTER_DROPPED_KEYFRAMES = 5;

export function newViewerState(): ViewerState {
  return { state: BackpressureState.NORMAL, droppingSinceMs: 0, droppedKeyframes: 0 };
}

export interface DecideResult {
  action: Action;
  next: ViewerState;
}

/**
 * Pure decision function for one frame to one viewer.
 * The caller passes the viewer's current state and the WebSocket's current
 * bufferedAmount; we return what action to take and the next state.
 */
export function decideAction(
  current: ViewerState,
  kind: FrameKind,
  nowMs: number,
  bufferedAmount: number,
): DecideResult {
  // Hard cap forces immediate reset regardless of current state
  if (bufferedAmount >= HARD_CAP) {
    return { action: 'reset', next: { ...current, state: BackpressureState.RESET_PENDING } };
  }

  // Config messages are tiny and required for new viewers — never drop
  if (kind === 'config') {
    return { action: 'send', next: current };
  }

  if (current.state === BackpressureState.NORMAL) {
    if (bufferedAmount >= HIGH_WATER) {
      return {
        action: 'drop',
        next: {
          state: BackpressureState.DROPPING,
          droppingSinceMs: nowMs,
          droppedKeyframes: kind === 'keyframe' ? 1 : 0,
        },
      };
    }
    return { action: 'send', next: current };
  }

  if (current.state === BackpressureState.DROPPING) {
    const elapsedDropping = nowMs - current.droppingSinceMs;
    if (elapsedDropping >= DROPPING_RESET_AFTER_MS) {
      return { action: 'reset', next: { ...current, state: BackpressureState.RESET_PENDING } };
    }
    if (kind === 'delta') {
      return { action: 'drop', next: current };
    }
    // keyframe — either resume or count it as dropped
    if (bufferedAmount < LOW_WATER) {
      return {
        action: 'send',
        next: { state: BackpressureState.NORMAL, droppingSinceMs: 0, droppedKeyframes: 0 },
      };
    }
    const droppedKeyframes = current.droppedKeyframes + 1;
    if (droppedKeyframes >= RESET_AFTER_DROPPED_KEYFRAMES) {
      return {
        action: 'reset',
        next: { ...current, state: BackpressureState.RESET_PENDING, droppedKeyframes },
      };
    }
    return { action: 'drop', next: { ...current, droppedKeyframes } };
  }

  // RESET_PENDING — drop everything until the stream restarts and state is reset by the caller
  return { action: 'drop', next: current };
}
