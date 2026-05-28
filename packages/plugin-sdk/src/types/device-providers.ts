/** State machine for a managed device instance. See spec §7.1. */
export type DeviceInstanceState =
  /** Image is being pulled. Container hasn't been created yet (no runtime id). */
  | 'pulling'
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

/**
 * The discriminated mode string a provider declares for an instance.
 * The two built-in modes (`wireguard`, `ios-bridge`) ship in core; the
 * `(string & {})` arm preserves IntelliSense autocomplete for those
 * while still permitting plugin-defined modes like `'corellium-tunnel'`.
 *
 * This is the well-known "widened literal" pattern: a typo like
 * `'wireguad'` will not satisfy the built-in literal arms and TypeScript
 * narrowing surfaces the mistake at the assignment site.
 */
export type NetworkMode = 'wireguard' | 'ios-bridge' | (string & {});

/** Discriminated network configuration for an instance. */
export type NetworkConfig =
  | { mode: 'wireguard' }
  | { mode: 'ios-bridge' }
  | { mode: NetworkMode; [key: string]: unknown };

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

/**
 * Aggregated image-pull progress. Providers that materialise a container
 * image (currently docker-android) push this to the orchestrator so the
 * UI can render one stable percentage instead of per-layer noise.
 */
export interface PullProgress {
  /** 0..100, or null before the total is known. */
  percent: number | null;
  /** Human-readable phrase, e.g. "Downloading 1.2 GB / 2.4 GB · 5 of 12 layers complete". */
  phase: string;
  bytesDone: number;
  bytesTotal: number;
  completedLayers: number;
  totalLayers: number;
}

/** Hooks the orchestrator can pass into createInstance. All optional. */
export interface CreateInstanceOpts {
  /** Invoked at ~500ms intervals during a backing-image pull, if any. */
  onPullProgress?: (progress: PullProgress) => void;
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
    /** Inclusive min for type='number'. The UI renders a validation hint. */
    min?: number;
    /** Inclusive max for type='number'. The UI renders a validation hint. */
    max?: number;
    /** Numeric step for type='number' (defaults to 1). */
    step?: number;
    /** Placeholder for type='string'. */
    placeholder?: string;
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
  createInstance?(spec: CreateInstanceSpec, opts?: CreateInstanceOpts): Promise<DeviceProviderInstance>;

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

/**
 * What a plugin passes to `ctx.deviceProviders([...])` to register one or more
 * managed-device providers. The host collects these and adds them to its
 * provider registry alongside the built-in `adb-device` / `avd` / `docker-android`
 * / `ios-device` providers.
 */
export interface DeviceProviderContribution {
  /** Stable provider id (must not collide with built-ins). */
  id: string;
  displayName: string;
  /** Network mode the host should use when capturing traffic from this provider's instances. */
  networkMode: NetworkMode;
  /** The DeviceProvider implementation (called by the registry/manager). */
  implementation: DeviceProvider;
  /** Per-mode capture handler, invoked during capture-session setup. */
  captureHandler: CaptureHandler;
  /** Coarse-grained capability hints surfaced in the UI. */
  capabilities: {
    canCreate: boolean;
    canDelete: boolean;
  };
}
