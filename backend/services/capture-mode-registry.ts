import type { CaptureSubsystemStatus } from '../../shared/types/websocket';

export type SubsystemKey = keyof CaptureSubsystemStatus;
export type SubsystemState = 'pending' | 'ok' | 'skipped' | 'warning' | 'error';

/**
 * Everything a capture-mode handler needs to wire one device's capture.
 * Built host-side per startCapture call. Handlers must not assume a provider
 * instance exists — physical devices arrive via the bare ADB tracker with no
 * managed instance.
 */
export interface CaptureModeContext {
  deviceId: string;
  sessionId: number;
  platform: 'android' | 'ios';
  mode: string;
  mitmOptions: Record<string, unknown>;
  /** Report a subsystem status transition. Per-key narrowed: each subsystem
   *  only accepts the states valid for it (e.g. mitmproxy has no 'warning'). */
  setSubsystem: <K extends SubsystemKey>(key: K, status: CaptureSubsystemStatus[K]) => void;
}

export interface CaptureModeResult {
  tunnelActivated: boolean;
  emuHttpProxy?: { host: string; port: number };
}

export type CaptureHandler = (ctx: CaptureModeContext) => Promise<CaptureModeResult>;

/**
 * Per-mode dispatcher for capture wiring. Built host-side per `startCapture`
 * call. The orchestrator builds a {@link CaptureModeContext} for the device,
 * looks up the handler registered for `ctx.mode`, and invokes it to wire up
 * the capture pipeline. Handlers return a {@link CaptureModeResult} the host
 * uses to track tunnel state and any emulator HTTP proxy endpoint.
 *
 * Built-in modes (`wireguard`, `ios-bridge`) ship in core (Task 5/6). The
 * thin SDK `DeviceProviderContribution.captureHandler` stays a forward
 * declaration; no plugin contributes a handler today, so this is a host
 * concern. See spec §5.
 */
export interface CaptureModeRegistry {
  register(mode: string, handler: CaptureHandler): void;
  has(mode: string): boolean;
  dispatch(ctx: CaptureModeContext): Promise<CaptureModeResult>;
}

export function createCaptureModeRegistry(): CaptureModeRegistry {
  const handlers = new Map<string, CaptureHandler>();
  return {
    register(mode, handler) {
      if (handlers.has(mode)) {
        throw new Error(`Capture mode "${mode}" is already registered`);
      }
      handlers.set(mode, handler);
    },
    has(mode) {
      return handlers.has(mode);
    },
    async dispatch(ctx) {
      const handler = handlers.get(ctx.mode);
      if (!handler) {
        throw new Error(`No capture handler registered for mode "${ctx.mode}"`);
      }
      return handler(ctx);
    },
  };
}
