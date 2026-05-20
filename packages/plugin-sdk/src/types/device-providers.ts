/** State machine for a managed device instance. See spec §7.1. */
export type DeviceInstanceState =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'error';

/** Per-provider availability check result. */
export interface ProviderAvailability {
  available: boolean;
  /** When `available=false`, a human-readable reason. */
  reason?: string;
  /** When `available=false`, an actionable hint (e.g. "Install Android Studio"). */
  installHint?: string;
}

/** The discriminated network mode a provider declares for an instance. */
export type NetworkConfig =
  | { mode: 'wireguard' }
  | { mode: 'ios-bridge' }
  | { mode: string; [key: string]: unknown };

/** What a provider reports about a single instance it manages. */
export interface DeviceProviderInstance {
  /** Provider-scoped ID — stable across restarts (AVD name, container ID, iOS UDID, adb serial). */
  id: string;
  displayName: string;
  state: DeviceInstanceState;
  /** ADB serial when the instance is running; absent for stopped/created. */
  serial?: string;
  spawnedByDarkride: boolean;
  /** Provider-specific blob persisted as JSON in device_instances.spawn_metadata. */
  metadata?: Record<string, unknown>;
  /** Structured error if state is 'error'. */
  lastError?: string;
}

/** Caller-supplied spec to spawn a new instance. Provider-specific keys live under `config`. */
export interface CreateInstanceSpec {
  displayName: string;
  /** Free-form per-provider config — validated by getCreateFormSchema. */
  config: Record<string, unknown>;
}

/** Returned from startInstance once the instance is reachable. */
export interface RunningInstance {
  id: string;
  serial: string;
}

/** JSON-schema-shaped description of a provider's createInstance form. */
export interface CreateFormSchema {
  fields: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'select' | 'boolean';
    required?: boolean;
    default?: string | number | boolean;
    options?: Array<{ value: string; label: string }>; // for type='select'
    help?: string;
  }>;
}

/** Handler that wires capture for a specific NetworkConfig.mode. */
export type CaptureHandler = (
  instance: DeviceProviderInstance,
  config: NetworkConfig,
) => Promise<void>;

/** The single contract every device source implements. See spec §4.1. */
export interface DeviceProvider {
  /** Stable provider identifier: 'adb-device' | 'avd' | 'docker-android' | 'ios-device' | <plugin>. */
  id: string;
  displayName: string;

  /** Detect whether prerequisites are present on this host. */
  isAvailable(): Promise<ProviderAvailability>;

  /** List every instance this provider knows about (BYOE + our spawns). */
  listInstances(): Promise<DeviceProviderInstance[]>;

  /**
   * Spawn a new instance from a provider-specific spec. Providers that can
   * only observe (adb-device, ios-device) leave this undefined.
   */
  createInstance?(spec: CreateInstanceSpec): Promise<DeviceProviderInstance>;

  /** Start a previously-created (or stopped) instance. No-op for observe-only providers. */
  startInstance(id: string): Promise<RunningInstance>;

  /** Stop a running instance. No-op at provider level for BYOE; kills for spawned. */
  stopInstance(id: string): Promise<void>;

  /** Delete an instance permanently. Optional. Refuses while running. */
  deleteInstance?(id: string): Promise<void>;

  /** How capture traffic flows for this instance. */
  getNetworkConfig(id: string): NetworkConfig;

  /** Form schema for the wizard, if this provider supports createInstance. */
  getCreateFormSchema?(): Promise<CreateFormSchema>;
}
