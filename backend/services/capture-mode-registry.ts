import type { CaptureHandler, DeviceProviderInstance, NetworkConfig } from '@darkrideapp/plugin-sdk';

/**
 * Per-mode dispatcher for capture wiring. Each `DeviceProvider` declares
 * its `NetworkConfig.mode` via `getNetworkConfig(id)`; the orchestrator
 * looks up the registered handler for that mode and invokes it to wire
 * up the capture pipeline for the instance.
 *
 * Built-in modes (`wireguard`, `ios-bridge`) ship in core. Plugin
 * providers can register their own modes via `ctx.deviceProviders([...])`.
 * See spec §5.
 */
export interface CaptureModeRegistry {
  register(mode: string, handler: CaptureHandler): void;
  has(mode: string): boolean;
  dispatch(instance: DeviceProviderInstance, config: NetworkConfig): Promise<void>;
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
    async dispatch(instance, config) {
      const handler = handlers.get(config.mode);
      if (!handler) {
        throw new Error(`No capture handler registered for mode "${config.mode}"`);
      }
      await handler(instance, config);
    },
  };
}
