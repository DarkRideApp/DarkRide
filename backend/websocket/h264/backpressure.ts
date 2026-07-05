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

export const HIGH_WATER = 2 * 1024 * 1024;     // 2 MB — enter DROPPING
export const LOW_WATER = 256 * 1024;            // 256 KB — resume on next keyframe
export const HARD_CAP = 8 * 1024 * 1024;        // 8 MB (kept for callers/telemetry)

export function newViewerState(): ViewerState {
  return { state: BackpressureState.NORMAL, droppingSinceMs: 0, droppedKeyframes: 0 };
}

export interface DecideResult {
  action: Action;
  next: ViewerState;
}

/**
 * Pure decision function for one frame to one viewer, based on the viewer's
 * current state and its WebSocket's bufferedAmount.
 *
 * A slow viewer (buffer past HIGH_WATER) enters DROPPING: we send it nothing
 * until its buffer drains below LOW_WATER, then resync it on the next keyframe.
 * Because DROPPING sends nothing, bufferedAmount can only fall while dropping —
 * memory is self-bounded, so there is no need to ever restart the shared
 * encoder. We deliberately never return 'reset': restarting scrcpy because one
 * viewer fell behind stalls the stream for *every* viewer (the "stuck for ages"
 * failure) for no memory-safety benefit. A persistently slow viewer simply sees
 * keyframe-rate video until it catches up, and recovers on its own.
 */
export function decideAction(
  current: ViewerState,
  kind: FrameKind,
  nowMs: number,
  bufferedAmount: number,
): DecideResult {
  // Config messages are tiny and required before a viewer can decode — always send.
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

  // DROPPING (and any legacy RESET_PENDING): drop until the buffer drains, then
  // resync on a keyframe. Never escalates to a stream restart.
  if (kind === 'keyframe' && bufferedAmount < LOW_WATER) {
    return {
      action: 'send',
      next: { state: BackpressureState.NORMAL, droppingSinceMs: 0, droppedKeyframes: 0 },
    };
  }
  const droppedKeyframes = current.droppedKeyframes + (kind === 'keyframe' ? 1 : 0);
  return { action: 'drop', next: { ...current, state: BackpressureState.DROPPING, droppedKeyframes } };
}
