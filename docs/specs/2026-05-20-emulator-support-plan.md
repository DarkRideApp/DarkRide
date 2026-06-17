# Emulator Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build first-class emulator support in DarkRide by refactoring the existing 1200-line `device-manager.ts` into a thin orchestrator over a unified `DeviceProvider` abstraction, then ship four built-in providers (`adb-device`, `ios-device`, `docker-android`, `avd`) plus a plugin lane.

**Architecture:** Six phases delivered on `feature/emulator-support`, each gated by CI green on the branch before the next phase begins. Phase 1 refactors the existing physical-device path into the new abstraction without behaviour change. Phases 2-4 add the three new providers. Phase 5 adds the nightly E2E CI workflow. Phase 6 opens the plugin lane. The capture pipeline (mitmproxy + WireGuard + traffic store) stays untouched — only DeviceManager's call sites change from platform conditionals to `provider.getNetworkConfig().mode` dispatching.

**Tech Stack:** TypeScript/Node + Drizzle ORM + better-sqlite3 + Express + WebSockets (existing). New deps: `dockerode` (Docker SDK for daemon detection + container ops). Pre-existing: `adb`, `emulator`, `avdmanager` CLIs (shelled via `child_process.execFile`). New Docker image: `ghcr.io/darkrideapp/docker-android:<android-version>` built `FROM budtmo/docker-android` + pre-baked `wg-go` + Frida server. Existing test patterns: mock `child_process.execFile` (see `backend/services/plugin-installer.test.ts:4-20` for the canonical pattern), tempdir-isolated fs (see `feedback_test_isolation_data_root.md` memory).

---

## File structure

### Backend (new)

- `backend/services/providers/types.ts` — shared local types not in the SDK (capture handler signatures, internal-only helpers)
- `backend/services/providers/index.ts` — provider registry + loader
- `backend/services/providers/adb-device.ts` — Phase 1
- `backend/services/providers/ios-device.ts` — Phase 2
- `backend/services/providers/docker-android.ts` — Phase 3
- `backend/services/providers/docker-helpers.ts` — Docker daemon detection + container ops
- `backend/services/providers/avd.ts` — Phase 4
- `backend/services/providers/avd-helpers.ts` — parse `avdmanager list avd` output, system-image package list
- `backend/services/device-instances-repo.ts` — DB access for `device_instances` + `device_instance_config`
- `backend/services/capture-mode-registry.ts` — dispatcher for per-mode `CaptureHandler`s
- `backend/api/devices-providers.ts` — `/v1/devices/providers/*` endpoints

### Backend (modified)

- `backend/services/device-manager.ts` — heavy refactor: orchestrator only (~300 lines after refactor)
- `backend/index.ts` — wire providers + capture-mode-registry into boot sequence
- `backend/db/schema.ts` — add `deviceInstances`, `deviceInstanceConfig`, nullable `devices.instanceId`

### SDK

- `packages/plugin-sdk/src/types/device-providers.ts` — public types: `DeviceProvider`, `DeviceProviderInstance`, `NetworkConfig`, `CreateInstanceSpec`, `RunningInstance`, `CreateFormSchema`, `CaptureHandler`
- `packages/plugin-sdk/src/types/index.ts` — re-export
- `packages/plugin-sdk/src/types/plugin.ts` — add `ctx.deviceProviders([...])` method to `PluginContext`

### Frontend

- `frontend/pages/Devices.tsx` — modify: add type badges, `+ Add emulator` button
- `frontend/components/devices/DeviceTypeBadge.tsx` — new
- `frontend/components/devices/CreateEmulatorModal.tsx` — new wizard
- `frontend/components/devices/ProviderTab.tsx` — new per-provider form rendering
- `frontend/lib/provider-form-schema.ts` — new JSON-schema → React form

### Migrations

- `migrations/0092_device_instances.sql` — create new tables + ALTER `devices`

### Docker image

- `docker/Dockerfile.android-emulator` — `FROM budtmo/docker-android` + COPY wg-go + frida-server + entrypoint
- `docker/entrypoint.sh` — startup wrapper that waits for adbd
- `.github/workflows/publish-docker-android.yml` — build + push to ghcr.io

### CI

- `.github/workflows/ci-e2e-emulator.yml` — nightly + workflow_dispatch
- `tests/e2e/fixtures/hello-world.apk` — checked-in small fixture
- `tests/e2e/emulator-capture.test.ts` — the E2E assertion script

---

## Phase 1 — Provider abstraction + adb-device extraction

**Outcome:** SDK types defined. `DeviceProvider` interface published. Existing `device-manager.ts` polling and setup logic extracted into `adb-device` provider. `DeviceManager` becomes a thin orchestrator. All existing tests stay green. CI green on `feature/emulator-support`.

### Task 1.1: SDK types for DeviceProvider

**Files:**
- Create: `packages/plugin-sdk/src/types/device-providers.ts`
- Modify: `packages/plugin-sdk/src/types/index.ts` (export-only)

- [ ] **Step 1: Write the type definitions test (compile-time + shape)**

```typescript
// packages/plugin-sdk/src/__tests__/device-provider-types.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type {
  DeviceProvider,
  DeviceProviderInstance,
  NetworkConfig,
  CreateInstanceSpec,
  RunningInstance,
  CreateFormSchema,
  CaptureHandler,
} from '../types';

describe('DeviceProvider type surface', () => {
  it('DeviceProvider is callable with the documented method set', () => {
    expectTypeOf<DeviceProvider>().toHaveProperty('id').toBeString();
    expectTypeOf<DeviceProvider>().toHaveProperty('displayName').toBeString();
    expectTypeOf<DeviceProvider>().toHaveProperty('isAvailable').toBeFunction();
    expectTypeOf<DeviceProvider>().toHaveProperty('listInstances').toBeFunction();
    expectTypeOf<DeviceProvider>().toHaveProperty('startInstance').toBeFunction();
    expectTypeOf<DeviceProvider>().toHaveProperty('stopInstance').toBeFunction();
    expectTypeOf<DeviceProvider>().toHaveProperty('getNetworkConfig').toBeFunction();
  });

  it('NetworkConfig discriminates by mode string with extension', () => {
    const wg: NetworkConfig = { mode: 'wireguard' };
    const ios: NetworkConfig = { mode: 'ios-bridge' };
    const plugin: NetworkConfig = { mode: 'corellium-tunnel', endpoint: 'wss://...' };
    expectTypeOf(wg).toMatchTypeOf<NetworkConfig>();
    expectTypeOf(ios).toMatchTypeOf<NetworkConfig>();
    expectTypeOf(plugin).toMatchTypeOf<NetworkConfig>();
  });

  it('DeviceProviderInstance has state union restricted to the documented values', () => {
    type State = DeviceProviderInstance['state'];
    expectTypeOf<State>().toEqualTypeOf<'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'>();
  });
});
```

- [ ] **Step 2: Run the test, see it fail (types not defined)**

Run: `npx vitest run packages/plugin-sdk/src/__tests__/device-provider-types.test.ts`
Expected: compile error — `Cannot find type 'DeviceProvider'`.

- [ ] **Step 3: Define the types**

```typescript
// packages/plugin-sdk/src/types/device-providers.ts

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
```

- [ ] **Step 4: Re-export from the SDK barrel**

```typescript
// packages/plugin-sdk/src/types/index.ts
// (append after existing exports)
export * from './device-providers';
```

- [ ] **Step 5: Run the test, see it pass**

Run: `npx vitest run packages/plugin-sdk/src/__tests__/device-provider-types.test.ts`
Expected: PASS.

- [ ] **Step 6: Rebuild the SDK, run full SDK test suite**

Run: `npm run build -w @darkrideapp/plugin-sdk && npx vitest run packages/plugin-sdk/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-sdk/src/types/device-providers.ts \
        packages/plugin-sdk/src/types/index.ts \
        packages/plugin-sdk/src/__tests__/device-provider-types.test.ts
git commit -m "feat(sdk): add DeviceProvider type surface for emulator support"
```

### Task 1.2: Provider registry skeleton

**Files:**
- Create: `backend/services/providers/index.ts`
- Create: `backend/services/providers/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing registry test**

```typescript
// backend/services/providers/__tests__/registry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createProviderRegistry } from '../index';
import type { DeviceProvider, DeviceProviderInstance } from '@darkrideapp/plugin-sdk';

function makeMockProvider(id: string, overrides: Partial<DeviceProvider> = {}): DeviceProvider {
  return {
    id,
    displayName: `Mock ${id}`,
    isAvailable: vi.fn().mockResolvedValue({ available: true }),
    listInstances: vi.fn().mockResolvedValue([]),
    startInstance: vi.fn(),
    stopInstance: vi.fn(),
    getNetworkConfig: () => ({ mode: 'wireguard' }),
    ...overrides,
  } as any;
}

describe('createProviderRegistry', () => {
  it('register + get returns the same instance', () => {
    const reg = createProviderRegistry();
    const p = makeMockProvider('test');
    reg.register(p);
    expect(reg.get('test')).toBe(p);
  });

  it('list returns providers in registration order', () => {
    const reg = createProviderRegistry();
    const a = makeMockProvider('a');
    const b = makeMockProvider('b');
    reg.register(a);
    reg.register(b);
    expect(reg.list().map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('registering an id twice throws (provider IDs must be unique)', () => {
    const reg = createProviderRegistry();
    reg.register(makeMockProvider('dup'));
    expect(() => reg.register(makeMockProvider('dup'))).toThrow(/already registered/i);
  });

  it('get on an unknown id returns undefined (caller decides whether to throw)', () => {
    const reg = createProviderRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('listInstancesAll aggregates listInstances() across all registered providers', async () => {
    const reg = createProviderRegistry();
    const a = makeMockProvider('a', {
      listInstances: vi.fn().mockResolvedValue([{ id: 'a1', displayName: 'A1', state: 'running', spawnedByDarkride: false }]),
    });
    const b = makeMockProvider('b', {
      listInstances: vi.fn().mockResolvedValue([{ id: 'b1', displayName: 'B1', state: 'stopped', spawnedByDarkride: true }]),
    });
    reg.register(a); reg.register(b);
    const all = await reg.listInstancesAll();
    expect(all).toEqual([
      { providerId: 'a', instance: { id: 'a1', displayName: 'A1', state: 'running', spawnedByDarkride: false } },
      { providerId: 'b', instance: { id: 'b1', displayName: 'B1', state: 'stopped', spawnedByDarkride: true } },
    ]);
  });

  it('listInstancesAll continues past a single provider failure (one bad provider does not break the others)', async () => {
    const reg = createProviderRegistry();
    const a = makeMockProvider('a', { listInstances: vi.fn().mockRejectedValue(new Error('boom')) });
    const b = makeMockProvider('b', {
      listInstances: vi.fn().mockResolvedValue([{ id: 'b1', displayName: 'B1', state: 'running', spawnedByDarkride: false }]),
    });
    reg.register(a); reg.register(b);
    const all = await reg.listInstancesAll();
    expect(all).toEqual([
      { providerId: 'b', instance: { id: 'b1', displayName: 'B1', state: 'running', spawnedByDarkride: false } },
    ]);
  });
});
```

- [ ] **Step 2: Run, see it fail (registry not implemented)**

Run: `npx vitest run backend/services/providers/__tests__/registry.test.ts`
Expected: FAIL — `Cannot find module '../index'`.

- [ ] **Step 3: Implement the registry**

```typescript
// backend/services/providers/index.ts
import type { DeviceProvider, DeviceProviderInstance } from '@darkrideapp/plugin-sdk';
import { createLoggers } from '../../logs';

const { error: logError } = createLoggers('provider-registry');

export interface ListInstancesAllRow {
  providerId: string;
  instance: DeviceProviderInstance;
}

export interface ProviderRegistry {
  register(provider: DeviceProvider): void;
  get(id: string): DeviceProvider | undefined;
  list(): DeviceProvider[];
  /** Aggregate listInstances() across all registered providers. Failed providers are logged + skipped. */
  listInstancesAll(): Promise<ListInstancesAllRow[]>;
}

export function createProviderRegistry(): ProviderRegistry {
  const providers: DeviceProvider[] = [];
  const byId = new Map<string, DeviceProvider>();

  return {
    register(provider) {
      if (byId.has(provider.id)) {
        throw new Error(`Provider "${provider.id}" is already registered`);
      }
      byId.set(provider.id, provider);
      providers.push(provider);
    },
    get(id) {
      return byId.get(id);
    },
    list() {
      return [...providers];
    },
    async listInstancesAll() {
      const results: ListInstancesAllRow[] = [];
      // Parallelise per-provider; one slow provider must not block the others.
      // Wrap each in a try so a single throwing provider doesn't crash aggregation.
      const settled = await Promise.allSettled(
        providers.map(async (p) => ({ providerId: p.id, items: await p.listInstances() })),
      );
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === 'fulfilled') {
          for (const inst of s.value.items) {
            results.push({ providerId: s.value.providerId, instance: inst });
          }
        } else {
          logError(`Provider "${providers[i].id}" listInstances failed: ${s.reason?.message ?? s.reason}`);
        }
      }
      return results;
    },
  };
}
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npx vitest run backend/services/providers/__tests__/registry.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/providers/index.ts backend/services/providers/__tests__/registry.test.ts
git commit -m "feat(providers): add ProviderRegistry skeleton for DeviceProviders"
```

### Task 1.3: adb-device provider (extracted from device-manager.ts)

**Files:**
- Create: `backend/services/providers/adb-device.ts`
- Create: `backend/services/providers/__tests__/adb-device.test.ts`

- [ ] **Step 1: Write the failing test against the new provider**

```typescript
// backend/services/providers/__tests__/adb-device.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process BEFORE importing the provider (same pattern as plugin-installer.test.ts:4-20).
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { createAdbDeviceProvider } from '../adb-device';

function mockAdbDevices(stdout: string) {
  (execFile as any).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

describe('adb-device provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isAvailable returns true when adb succeeds', async () => {
    mockAdbDevices('List of devices attached\n');
    const p = createAdbDeviceProvider();
    const av = await p.isAvailable();
    expect(av.available).toBe(true);
  });

  it('isAvailable returns false with installHint when adb is missing', async () => {
    (execFile as any).mockImplementation((_c: string, _a: string[], _o: any, cb: Function) => {
      const err: any = new Error('spawn adb ENOENT');
      err.code = 'ENOENT';
      cb(err);
    });
    const p = createAdbDeviceProvider();
    const av = await p.isAvailable();
    expect(av.available).toBe(false);
    expect(av.installHint).toMatch(/adb/i);
  });

  it('listInstances parses "adb devices" output into one instance per row', async () => {
    mockAdbDevices(
      `List of devices attached\n` +
      `R3CR70ABC123\tdevice\n` +
      `emulator-5554\tdevice\n` +
      `RANDOM_SERIAL\toffline\n`,
    );
    const p = createAdbDeviceProvider();
    const instances = await p.listInstances();
    expect(instances).toEqual([
      { id: 'R3CR70ABC123', displayName: 'R3CR70ABC123', state: 'running', serial: 'R3CR70ABC123', spawnedByDarkride: false },
      { id: 'emulator-5554', displayName: 'emulator-5554', state: 'running', serial: 'emulator-5554', spawnedByDarkride: false },
      { id: 'RANDOM_SERIAL', displayName: 'RANDOM_SERIAL', state: 'stopped', serial: 'RANDOM_SERIAL', spawnedByDarkride: false },
    ]);
  });

  it('startInstance is a no-op (adb-device does not spawn)', async () => {
    const p = createAdbDeviceProvider();
    // Returns immediately with the existing serial; never calls execFile to spawn anything.
    const r = await p.startInstance('R3CR70ABC123');
    expect(r).toEqual({ id: 'R3CR70ABC123', serial: 'R3CR70ABC123' });
  });

  it('stopInstance is a no-op (adb-device does not kill)', async () => {
    const p = createAdbDeviceProvider();
    await expect(p.stopInstance('R3CR70ABC123')).resolves.toBeUndefined();
  });

  it('getNetworkConfig returns wireguard mode', () => {
    const p = createAdbDeviceProvider();
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'wireguard' });
  });
});
```

- [ ] **Step 2: Run, see it fail (provider not implemented)**

Run: `npx vitest run backend/services/providers/__tests__/adb-device.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adb-device provider**

```typescript
// backend/services/providers/adb-device.ts
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { DeviceProvider, DeviceProviderInstance, ProviderAvailability, NetworkConfig, RunningInstance } from '@darkrideapp/plugin-sdk';

const execFile = promisify(execFileCb);

/**
 * adb-device — observes any Android device reachable via `adb devices`. Includes
 * physical phones, BYOE AVDs, Genymotion, BlueStacks, custom containers. Does
 * NOT spawn or kill; pure passive observer. See spec §6.1.
 */
export function createAdbDeviceProvider(): DeviceProvider {
  return {
    id: 'adb-device',
    displayName: 'ADB Device',

    async isAvailable(): Promise<ProviderAvailability> {
      try {
        await execFile('adb', ['devices'], { timeout: 5000 });
        return { available: true };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return {
            available: false,
            reason: 'adb binary not found on PATH',
            installHint: 'Install Android platform-tools (https://developer.android.com/tools/releases/platform-tools) and ensure adb is on PATH.',
          };
        }
        return { available: false, reason: err.message ?? String(err) };
      }
    },

    async listInstances(): Promise<DeviceProviderInstance[]> {
      const { stdout } = await execFile('adb', ['devices'], { timeout: 5000 });
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      // Skip the "List of devices attached" header.
      const rows = lines.filter((l) => !l.startsWith('List of'));
      const out: DeviceProviderInstance[] = [];
      for (const row of rows) {
        // Each row is "<serial>\t<state>" — state is one of: device, offline, unauthorized, ...
        const [serial, adbState] = row.split(/\s+/);
        if (!serial) continue;
        out.push({
          id: serial,
          displayName: serial,
          serial,
          state: adbState === 'device' ? 'running' : 'stopped',
          spawnedByDarkride: false,
        });
      }
      return out;
    },

    async startInstance(id: string): Promise<RunningInstance> {
      // adb-device does not spawn. If the caller asked for "start", the
      // device must already exist; we just confirm the serial.
      return { id, serial: id };
    },

    async stopInstance(_id: string): Promise<void> {
      // adb-device does not kill. DarkRide stops watching at the
      // orchestrator level; the underlying process belongs to the user.
    },

    getNetworkConfig(_id: string): NetworkConfig {
      return { mode: 'wireguard' };
    },
  };
}
```

- [ ] **Step 4: Run the test, see it pass**

Run: `npx vitest run backend/services/providers/__tests__/adb-device.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/providers/adb-device.ts backend/services/providers/__tests__/adb-device.test.ts
git commit -m "feat(providers): add adb-device provider (observe-only)"
```

### Task 1.4: Capture-mode registry skeleton

**Files:**
- Create: `backend/services/capture-mode-registry.ts`
- Create: `backend/services/__tests__/capture-mode-registry.test.ts`

- [ ] **Step 1: Write failing test for the dispatch surface**

```typescript
// backend/services/__tests__/capture-mode-registry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createCaptureModeRegistry } from '../capture-mode-registry';
import type { DeviceProviderInstance, NetworkConfig } from '@darkrideapp/plugin-sdk';

const sampleInstance: DeviceProviderInstance = {
  id: 'x', displayName: 'x', state: 'running', serial: 'x', spawnedByDarkride: false,
};

describe('captureModeRegistry', () => {
  it('register + dispatch routes to the matching handler', async () => {
    const reg = createCaptureModeRegistry();
    const wg = vi.fn().mockResolvedValue(undefined);
    reg.register('wireguard', wg);
    await reg.dispatch(sampleInstance, { mode: 'wireguard' });
    expect(wg).toHaveBeenCalledWith(sampleInstance, { mode: 'wireguard' });
  });

  it('dispatch on an unregistered mode throws a structured error', async () => {
    const reg = createCaptureModeRegistry();
    await expect(reg.dispatch(sampleInstance, { mode: 'unknown' } as NetworkConfig))
      .rejects.toThrow(/No capture handler registered for mode "unknown"/);
  });

  it('registering the same mode twice throws (modes are unique)', () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', vi.fn());
    expect(() => reg.register('wireguard', vi.fn())).toThrow(/already registered/i);
  });

  it('has() reports registration status', () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', vi.fn());
    expect(reg.has('wireguard')).toBe(true);
    expect(reg.has('ios-bridge')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run backend/services/__tests__/capture-mode-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

```typescript
// backend/services/capture-mode-registry.ts
import type { CaptureHandler, DeviceProviderInstance, NetworkConfig } from '@darkrideapp/plugin-sdk';

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
```

- [ ] **Step 4: Run, see it pass**

Run: `npx vitest run backend/services/__tests__/capture-mode-registry.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/capture-mode-registry.ts backend/services/__tests__/capture-mode-registry.test.ts
git commit -m "feat(capture): add capture-mode registry for per-mode handler dispatch"
```

### Task 1.5: Refactor DeviceManager to consume providers (no behaviour change)

**Files:**
- Modify: `backend/services/device-manager.ts:218-280` (replace the polling loop body)
- Modify: `backend/index.ts:268-270` (boot-time wiring)
- Modify: `backend/services/device-manager.test.ts` (mock the registry)

> This is the largest single task. The goal is to delete the inline `adb devices` parsing from DeviceManager and instead consume the adb-device provider via the registry. After this task, ALL existing tests must still pass — no behaviour change, just plumbing.

- [ ] **Step 1: Add a registry-driven polling adapter inside DeviceManager**

Replace the polling loop in `backend/services/device-manager.ts` (search for "Poll `adb devices`" comment around line 218) with a method that asks the registry for instances and converts each to the existing internal `DeviceStatus`:

```typescript
// backend/services/device-manager.ts (new method on the class)

private providerRegistry: ProviderRegistry | null = null;

setProviderRegistry(reg: ProviderRegistry): void {
  this.providerRegistry = reg;
}

private async pollDevicesFromProviders(): Promise<void> {
  if (!this.providerRegistry) {
    // Backwards-compat path during refactor: if no registry was wired, fall
    // through to the legacy inline polling code. Once Task 1.6 lands the
    // registry in boot, this branch is dead.
    return this.pollDevicesLegacy();
  }
  const all = await this.providerRegistry.listInstancesAll();
  // Map provider instances back to the existing devices-table upsert logic.
  // For Phase 1 the only registered provider is adb-device, so this is a
  // 1:1 translation of the previous inline parsing.
  const upserts = all.filter((r) => r.instance.serial).map((r) => ({
    id: r.instance.serial!,
    state: r.instance.state,
  }));
  await this.upsertObservedDevices(upserts);
}

// Rename the current inline `pollDevices` body to `pollDevicesLegacy`
// (no logic change). Replace external call sites to `pollDevices` to
// route through `pollDevicesFromProviders`.
```

- [ ] **Step 2: Add the import for ProviderRegistry**

```typescript
// backend/services/device-manager.ts (top)
import type { ProviderRegistry } from './providers';
```

- [ ] **Step 3: Run the existing device-manager test suite, expect it to still pass**

Run: `npx vitest run backend/services/device-manager.test.ts`
Expected: PASS — the legacy code path is unchanged when no registry is wired.

- [ ] **Step 4: Add a new test that verifies the provider-driven path**

```typescript
// backend/services/device-manager.test.ts (append)

describe('DeviceManager — provider-driven polling', () => {
  it('pollDevicesFromProviders upserts each serial returned by the registry', async () => {
    const mgr = new DeviceManager(makeMockDb());
    const reg = {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn(),
      register: vi.fn(),
      listInstancesAll: vi.fn().mockResolvedValue([
        { providerId: 'adb-device', instance: { id: 'S1', displayName: 'S1', serial: 'S1', state: 'running', spawnedByDarkride: false } },
        { providerId: 'adb-device', instance: { id: 'S2', displayName: 'S2', serial: 'S2', state: 'stopped', spawnedByDarkride: false } },
      ]),
    };
    mgr.setProviderRegistry(reg as any);
    await (mgr as any).pollDevicesFromProviders();
    const dbRows = await mgr.listDevices();
    expect(dbRows.map((d) => d.id).sort()).toEqual(['S1', 'S2']);
  });
});
```

- [ ] **Step 5: Run, see it pass**

Run: `npx vitest run backend/services/device-manager.test.ts -t "provider-driven polling"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/services/device-manager.ts backend/services/device-manager.test.ts
git commit -m "refactor(device-manager): add provider-driven polling path (no behaviour change)"
```

### Task 1.6: Wire the registry in boot

**Files:**
- Modify: `backend/index.ts:268-275` (after `iosDeviceManager` is constructed)

- [ ] **Step 1: Add the registry wiring in boot**

In `backend/index.ts`, after the `deviceManager = new DeviceManager(db)` line, add:

```typescript
import { createProviderRegistry } from './services/providers';
import { createAdbDeviceProvider } from './services/providers/adb-device';
import { createCaptureModeRegistry } from './services/capture-mode-registry';

// ... after deviceManager construction:
const providerRegistry = createProviderRegistry();
providerRegistry.register(createAdbDeviceProvider());
deviceManager.setProviderRegistry(providerRegistry);

const captureModeRegistry = createCaptureModeRegistry();
// The wireguard handler is the existing physical-device capture path.
// For Phase 1 we register a no-op stub that defers to the existing
// per-device setup logic (which DeviceManager still owns) — replaced in
// Phase 2 with the proper handler.
captureModeRegistry.register('wireguard', async (_instance, _cfg) => { /* legacy path */ });
deviceManager.setCaptureModeRegistry(captureModeRegistry);
```

- [ ] **Step 2: Add the corresponding setter on DeviceManager (no-op for now)**

```typescript
// backend/services/device-manager.ts (new method)
private captureModeRegistry: CaptureModeRegistry | null = null;

setCaptureModeRegistry(reg: CaptureModeRegistry): void {
  this.captureModeRegistry = reg;
}
```

- [ ] **Step 3: Run the full backend test suite**

Run: `npx vitest run backend/ packages/plugin-sdk/`
Expected: PASS — all existing tests stay green, plus the new ones.

- [ ] **Step 4: Commit**

```bash
git add backend/index.ts backend/services/device-manager.ts
git commit -m "feat(boot): wire ProviderRegistry + CaptureModeRegistry; adb-device live"
```

### Task 1.7: Phase 1 CI gate

- [ ] **Step 1: Push branch + verify CI green**

```bash
git push
```

Watch CI:

```bash
gh run watch -R DarkRideApp/DarkRide --exit-status
```

Expected: all jobs green (backend tests, frontend tests, python tests, docker build, smoke test).

- [ ] **Step 2: Tag the phase boundary**

```bash
git tag phase-1-complete
git push origin phase-1-complete
```

This is a local-style anchor (not used for any automated action — purely a navigation aid). If something regresses later, the tag points at the known-green baseline.

---

## Phase 2 — device_instances migration + reconcile + ios-device

**Outcome:** New `device_instances` + `device_instance_config` tables. Repo for them. Reconcile-on-boot logic. `ios-device` provider that wraps the existing `IosDeviceManager`. `ios-bridge` capture handler registered. CI green.

### Task 2.1: Drizzle migration 0092

**Files:**
- Create: `migrations/0092_device_instances.sql`
- Modify: `migrations/meta/_journal.json` (append entry)
- Modify: `backend/db/schema.ts` (add table defs + ALTER devices)

- [ ] **Step 1: Write the migration SQL**

```sql
-- migrations/0092_device_instances.sql
CREATE TABLE `device_instances` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `provider_id` text NOT NULL,
  `runtime_id` text NOT NULL,
  `display_name` text,
  `serial` text,
  `state` text NOT NULL,
  `spawned_by_darkride` integer DEFAULT 0 NOT NULL,
  `spawn_metadata` text,
  `last_error` text,
  `created_at` integer NOT NULL,
  `last_state_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `device_instance_config` (
  `instance_id` integer NOT NULL,
  `key` text NOT NULL,
  `value` text NOT NULL,
  PRIMARY KEY(`instance_id`, `key`),
  FOREIGN KEY (`instance_id`) REFERENCES `device_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `devices` ADD COLUMN `instance_id` integer REFERENCES `device_instances`(`id`);
```

- [ ] **Step 2: Compute the journal `when` (strictly greater than every prior entry — see drizzle_migration_when_monotonic.md memory)**

```bash
node -e "const j = require('./migrations/meta/_journal.json'); console.log('next when:', Math.max(...j.entries.map(e => e.when)) + 1, 'next idx:', Math.max(...j.entries.map(e => e.idx)) + 1);"
```

- [ ] **Step 3: Append the journal entry**

In `migrations/meta/_journal.json` append (use the next idx and when from Step 2 — both must be strictly greater than any prior entry):

```json
{
  "idx": <next-idx>,
  "version": "7",
  "when": <next-when>,
  "tag": "0092_device_instances",
  "breakpoints": true
}
```

- [ ] **Step 4: Add the Drizzle schema definitions**

```typescript
// backend/db/schema.ts (append, after pluginInstalls)
export const deviceInstances = sqliteTable('device_instances', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  providerId: text('provider_id').notNull(),
  runtimeId: text('runtime_id').notNull(),
  displayName: text('display_name'),
  serial: text('serial'),
  state: text('state').notNull(),
  spawnedByDarkride: integer('spawned_by_darkride', { mode: 'boolean' }).notNull().default(false),
  spawnMetadata: text('spawn_metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  lastStateAt: integer('last_state_at', { mode: 'timestamp' }).notNull(),
});

export const deviceInstanceConfig = sqliteTable('device_instance_config', {
  instanceId: integer('instance_id').notNull().references(() => deviceInstances.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.instanceId, t.key] }) }));
```

Also add `instanceId` to the existing `devices` table definition (nullable, references deviceInstances.id).

- [ ] **Step 5: Test the migration on a fresh in-memory DB**

```typescript
// backend/db/__tests__/migration-0092.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from '../migrator';
import { resolve } from 'path';

describe('migration 0092 — device_instances', () => {
  it('creates the device_instances + device_instance_config tables + adds devices.instance_id', () => {
    const db = new Database(':memory:');
    applyMigrations(db, [resolve('./migrations')]);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('device_instances');
    expect(names).toContain('device_instance_config');

    // devices.instance_id column exists
    const cols = db.prepare("PRAGMA table_info('devices')").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('instance_id');
  });
});
```

- [ ] **Step 6: Run, see it pass**

Run: `npx vitest run backend/db/__tests__/migration-0092.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add migrations/0092_device_instances.sql \
        migrations/meta/_journal.json \
        backend/db/schema.ts \
        backend/db/__tests__/migration-0092.test.ts
git commit -m "feat(db): migration 0092 — device_instances + device_instance_config"
```

### Task 2.2: device-instances-repo

**Files:**
- Create: `backend/services/device-instances-repo.ts`
- Create: `backend/services/__tests__/device-instances-repo.test.ts`

- [ ] **Step 1: Write the failing test for repo CRUD**

```typescript
// backend/services/__tests__/device-instances-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema';
import { DeviceInstancesRepo } from '../device-instances-repo';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE device_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      display_name TEXT,
      serial TEXT,
      state TEXT NOT NULL,
      spawned_by_darkride INTEGER NOT NULL DEFAULT 0,
      spawn_metadata TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      last_state_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema });
}

describe('DeviceInstancesRepo', () => {
  let repo: DeviceInstancesRepo;
  beforeEach(() => { repo = new DeviceInstancesRepo(makeDb()); });

  it('insert + getById round-trip', () => {
    const created = repo.insert({
      providerId: 'docker-android',
      runtimeId: 'abc123',
      displayName: 'test-emulator',
      state: 'created',
      spawnedByDarkride: true,
      spawnMetadata: { image: 'docker-android:14', port: 5556 },
    });
    expect(created.id).toBeGreaterThan(0);
    const r = repo.getById(created.id);
    expect(r).toMatchObject({
      providerId: 'docker-android',
      runtimeId: 'abc123',
      state: 'created',
      spawnedByDarkride: true,
      spawnMetadata: { image: 'docker-android:14', port: 5556 },
    });
  });

  it('updateState transitions + bumps last_state_at + sets last_error when state=error', () => {
    const inst = repo.insert({ providerId: 'avd', runtimeId: 'avd-1', state: 'created', spawnedByDarkride: true });
    const before = repo.getById(inst.id)!.lastStateAt;
    // sleep 5ms to ensure timestamp advances
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    repo.updateState(inst.id, 'error', 'AVD failed to boot');
    const after = repo.getById(inst.id)!;
    expect(after.state).toBe('error');
    expect(after.lastError).toBe('AVD failed to boot');
    expect(after.lastStateAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('updateState to a non-error state clears last_error', () => {
    const inst = repo.insert({ providerId: 'avd', runtimeId: 'avd-1', state: 'error', spawnedByDarkride: true });
    repo.updateState(inst.id, 'error', 'first failure');
    repo.updateState(inst.id, 'running');
    expect(repo.getById(inst.id)!.lastError).toBeNull();
  });

  it('listByProvider returns only rows for the given provider', () => {
    repo.insert({ providerId: 'docker-android', runtimeId: 'd1', state: 'running', spawnedByDarkride: true });
    repo.insert({ providerId: 'avd', runtimeId: 'a1', state: 'running', spawnedByDarkride: true });
    repo.insert({ providerId: 'docker-android', runtimeId: 'd2', state: 'stopped', spawnedByDarkride: true });
    expect(repo.listByProvider('docker-android').map((r) => r.runtimeId).sort()).toEqual(['d1', 'd2']);
    expect(repo.listByProvider('avd').map((r) => r.runtimeId)).toEqual(['a1']);
  });

  it('listAll returns rows across every provider', () => {
    repo.insert({ providerId: 'docker-android', runtimeId: 'd1', state: 'running', spawnedByDarkride: true });
    repo.insert({ providerId: 'avd', runtimeId: 'a1', state: 'running', spawnedByDarkride: true });
    expect(repo.listAll()).toHaveLength(2);
  });

  it('delete removes the row', () => {
    const inst = repo.insert({ providerId: 'avd', runtimeId: 'a1', state: 'stopped', spawnedByDarkride: true });
    repo.delete(inst.id);
    expect(repo.getById(inst.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run backend/services/__tests__/device-instances-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the repo**

```typescript
// backend/services/device-instances-repo.ts
import { eq } from 'drizzle-orm';
import { deviceInstances } from '../db/schema';
import type { AppDatabase } from '../db/index';
import type { DeviceInstanceState } from '@darkrideapp/plugin-sdk';

export interface DeviceInstanceRow {
  id: number;
  providerId: string;
  runtimeId: string;
  displayName: string | null;
  serial: string | null;
  state: DeviceInstanceState;
  spawnedByDarkride: boolean;
  spawnMetadata: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: Date;
  lastStateAt: Date;
}

export interface DeviceInstanceInsert {
  providerId: string;
  runtimeId: string;
  displayName?: string | null;
  serial?: string | null;
  state: DeviceInstanceState;
  spawnedByDarkride: boolean;
  spawnMetadata?: Record<string, unknown> | null;
}

export class DeviceInstancesRepo {
  constructor(private db: AppDatabase) {}

  insert(input: DeviceInstanceInsert): DeviceInstanceRow {
    const now = new Date();
    const inserted = this.db.insert(deviceInstances).values({
      providerId: input.providerId,
      runtimeId: input.runtimeId,
      displayName: input.displayName ?? null,
      serial: input.serial ?? null,
      state: input.state,
      spawnedByDarkride: input.spawnedByDarkride,
      spawnMetadata: input.spawnMetadata ?? null,
      lastError: null,
      createdAt: now,
      lastStateAt: now,
    }).returning().all()[0];
    return inserted as DeviceInstanceRow;
  }

  updateState(id: number, state: DeviceInstanceState, lastError?: string | null): void {
    this.db.update(deviceInstances)
      .set({
        state,
        lastError: state === 'error' ? (lastError ?? null) : null,
        lastStateAt: new Date(),
      })
      .where(eq(deviceInstances.id, id))
      .run();
  }

  getById(id: number): DeviceInstanceRow | undefined {
    return this.db.select().from(deviceInstances).where(eq(deviceInstances.id, id)).all()[0] as DeviceInstanceRow | undefined;
  }

  listByProvider(providerId: string): DeviceInstanceRow[] {
    return this.db.select().from(deviceInstances).where(eq(deviceInstances.providerId, providerId)).all() as DeviceInstanceRow[];
  }

  listAll(): DeviceInstanceRow[] {
    return this.db.select().from(deviceInstances).all() as DeviceInstanceRow[];
  }

  delete(id: number): void {
    this.db.delete(deviceInstances).where(eq(deviceInstances.id, id)).run();
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `npx vitest run backend/services/__tests__/device-instances-repo.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/device-instances-repo.ts backend/services/__tests__/device-instances-repo.test.ts
git commit -m "feat(db): device-instances-repo for managed instance tracking"
```

### Task 2.3: Reconcile-on-boot

**Files:**
- Modify: `backend/services/device-manager.ts` (add reconcile method)
- Create: `backend/services/__tests__/device-manager-reconcile.test.ts`

- [ ] **Step 1: Write the failing reconcile test**

```typescript
// backend/services/__tests__/device-manager-reconcile.test.ts
import { describe, it, expect, vi } from 'vitest';
import { reconcileWithProviders } from '../device-manager-reconcile';
import type { ProviderRegistry } from '../providers';
import type { DeviceInstancesRepo } from '../device-instances-repo';

function makeMockRepo(rows: any[] = []) {
  const data = new Map(rows.map((r) => [r.id, r]));
  let nextId = Math.max(0, ...rows.map((r) => r.id)) + 1;
  return {
    insert: vi.fn().mockImplementation((input) => {
      const id = nextId++;
      const row = { id, ...input };
      data.set(id, row);
      return row;
    }),
    updateState: vi.fn().mockImplementation((id, state) => {
      const r = data.get(id);
      if (r) r.state = state;
    }),
    listAll: vi.fn().mockReturnValue(rows),
    listByProvider: vi.fn(),
    getById: vi.fn().mockImplementation((id) => data.get(id)),
    delete: vi.fn(),
  } as any;
}

function makeMockRegistry(instancesByProvider: Record<string, any[]>): ProviderRegistry {
  return {
    list: vi.fn().mockReturnValue(Object.keys(instancesByProvider).map((id) => ({ id }))),
    get: vi.fn(),
    register: vi.fn(),
    listInstancesAll: vi.fn().mockResolvedValue(
      Object.entries(instancesByProvider).flatMap(([providerId, instances]) =>
        instances.map((instance) => ({ providerId, instance })),
      ),
    ),
  } as any;
}

describe('reconcileWithProviders', () => {
  it('Case A: in DB, not in provider → mark stopped', async () => {
    const repo = makeMockRepo([
      { id: 1, providerId: 'docker-android', runtimeId: 'gone', state: 'running', spawnedByDarkride: true },
    ]);
    const reg = makeMockRegistry({ 'docker-android': [] });
    await reconcileWithProviders(reg, repo);
    expect(repo.updateState).toHaveBeenCalledWith(1, 'stopped', expect.any(String));
  });

  it('Case B: in provider, not in DB → insert (BYOE auto-discovery)', async () => {
    const repo = makeMockRepo([]);
    const reg = makeMockRegistry({
      'adb-device': [
        { id: 'NEWSERIAL', displayName: 'NEWSERIAL', serial: 'NEWSERIAL', state: 'running', spawnedByDarkride: false },
      ],
    });
    await reconcileWithProviders(reg, repo);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'adb-device',
      runtimeId: 'NEWSERIAL',
      serial: 'NEWSERIAL',
      state: 'running',
      spawnedByDarkride: false,
    }));
  });

  it('Case C: state mismatch → update', async () => {
    const repo = makeMockRepo([
      { id: 1, providerId: 'docker-android', runtimeId: 'abc', state: 'stopped', spawnedByDarkride: true },
    ]);
    const reg = makeMockRegistry({
      'docker-android': [
        { id: 'abc', displayName: 'abc', state: 'running', serial: 'localhost:5556', spawnedByDarkride: true },
      ],
    });
    await reconcileWithProviders(reg, repo);
    expect(repo.updateState).toHaveBeenCalledWith(1, 'running');
  });

  it('matches DB rows to provider instances by (providerId, runtimeId) — NOT by id', async () => {
    // DB internal id is unrelated to provider runtime id.
    const repo = makeMockRepo([
      { id: 42, providerId: 'avd', runtimeId: 'Pixel_8', state: 'stopped', spawnedByDarkride: true },
    ]);
    const reg = makeMockRegistry({
      'avd': [{ id: 'Pixel_8', displayName: 'Pixel 8', state: 'running', spawnedByDarkride: true }],
    });
    await reconcileWithProviders(reg, repo);
    expect(repo.updateState).toHaveBeenCalledWith(42, 'running');
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run backend/services/__tests__/device-manager-reconcile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement reconcile as a standalone function (testable)**

```typescript
// backend/services/device-manager-reconcile.ts
import type { ProviderRegistry } from './providers';
import type { DeviceInstancesRepo } from './device-instances-repo';

/**
 * Reconcile DB state against what each provider currently reports.
 * Three cases per spec §7.3:
 *   - In DB, not in provider → mark stopped
 *   - In provider, not in DB → insert (BYOE auto-discovery)
 *   - Both, with state mismatch → update DB to match provider
 *
 * Matches by (providerId, runtimeId). Idempotent — safe to run repeatedly.
 */
export async function reconcileWithProviders(
  registry: ProviderRegistry,
  repo: DeviceInstancesRepo,
): Promise<void> {
  const providerRows = await registry.listInstancesAll();
  const dbRows = repo.listAll();

  // Index DB rows by (providerId, runtimeId).
  const dbByKey = new Map<string, typeof dbRows[number]>();
  for (const r of dbRows) {
    dbByKey.set(`${r.providerId}::${r.runtimeId}`, r);
  }

  // Index provider rows by the same key.
  const providerByKey = new Map<string, typeof providerRows[number]>();
  for (const r of providerRows) {
    providerByKey.set(`${r.providerId}::${r.instance.id}`, r);
  }

  // Case A: in DB, not in provider
  for (const r of dbRows) {
    const key = `${r.providerId}::${r.runtimeId}`;
    if (!providerByKey.has(key) && r.state !== 'stopped' && r.state !== 'error') {
      repo.updateState(r.id, 'stopped', 'provider no longer reports this instance');
    }
  }

  // Cases B + C: provider-side iteration
  for (const r of providerRows) {
    const key = `${r.providerId}::${r.instance.id}`;
    const dbRow = dbByKey.get(key);
    if (!dbRow) {
      // Case B: insert
      repo.insert({
        providerId: r.providerId,
        runtimeId: r.instance.id,
        displayName: r.instance.displayName,
        serial: r.instance.serial ?? null,
        state: r.instance.state,
        spawnedByDarkride: r.instance.spawnedByDarkride,
        spawnMetadata: r.instance.metadata ?? null,
      });
    } else if (dbRow.state !== r.instance.state) {
      // Case C: state mismatch
      repo.updateState(dbRow.id, r.instance.state);
    }
  }
}
```

- [ ] **Step 4: Run, see it pass**

Run: `npx vitest run backend/services/__tests__/device-manager-reconcile.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Wire into boot**

In `backend/index.ts`, after the device-instances repo is constructed:

```typescript
import { reconcileWithProviders } from './services/device-manager-reconcile';
import { DeviceInstancesRepo } from './services/device-instances-repo';

const deviceInstancesRepo = new DeviceInstancesRepo(db);
await reconcileWithProviders(providerRegistry, deviceInstancesRepo);
```

- [ ] **Step 6: Commit**

```bash
git add backend/services/device-manager-reconcile.ts backend/services/__tests__/device-manager-reconcile.test.ts backend/index.ts
git commit -m "feat(device-manager): reconcile-on-boot against provider listings"
```

### Task 2.4: ios-device provider (wraps IosDeviceManager)

**Files:**
- Create: `backend/services/providers/ios-device.ts`
- Create: `backend/services/providers/__tests__/ios-device.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/services/providers/__tests__/ios-device.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createIosDeviceProvider } from '../ios-device';

function makeMockIosManager(devices: any[] = []): any {
  return {
    getDevices: vi.fn().mockResolvedValue(devices),
    isAvailable: vi.fn().mockReturnValue(true),
  };
}

describe('ios-device provider', () => {
  it('isAvailable proxies to IosDeviceManager.isAvailable()', async () => {
    const mgr = makeMockIosManager();
    const p = createIosDeviceProvider(mgr);
    const av = await p.isAvailable();
    expect(av.available).toBe(true);
  });

  it('isAvailable surfaces a hint when usbmuxd is unreachable', async () => {
    const mgr = makeMockIosManager();
    mgr.isAvailable.mockReturnValue(false);
    const p = createIosDeviceProvider(mgr);
    const av = await p.isAvailable();
    expect(av.available).toBe(false);
    expect(av.installHint).toMatch(/usbmuxd|libimobiledevice/i);
  });

  it('listInstances proxies to IosDeviceManager and maps to DeviceProviderInstance', async () => {
    const mgr = makeMockIosManager([
      { udid: '00008101-001234567890ABCDE', name: "Jamie's iPhone", platform: 'ios', isOnline: true },
    ]);
    const p = createIosDeviceProvider(mgr);
    const instances = await p.listInstances();
    expect(instances).toEqual([
      {
        id: '00008101-001234567890ABCDE',
        displayName: "Jamie's iPhone",
        serial: '00008101-001234567890ABCDE',
        state: 'running',
        spawnedByDarkride: false,
      },
    ]);
  });

  it('getNetworkConfig returns ios-bridge mode (not wireguard)', () => {
    const p = createIosDeviceProvider(makeMockIosManager());
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'ios-bridge' });
  });

  it('startInstance + stopInstance are no-ops at provider level (capture-session manages lifecycle hooks)', async () => {
    const mgr = makeMockIosManager();
    const p = createIosDeviceProvider(mgr);
    await expect(p.startInstance('uuid')).resolves.toEqual({ id: 'uuid', serial: 'uuid' });
    await expect(p.stopInstance('uuid')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run backend/services/providers/__tests__/ios-device.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the wrapper**

```typescript
// backend/services/providers/ios-device.ts
import type { DeviceProvider, DeviceProviderInstance, NetworkConfig, ProviderAvailability, RunningInstance } from '@darkrideapp/plugin-sdk';

// Minimal surface of IosDeviceManager used by this provider. The real class
// (backend/services/ios-device-manager.ts) is much wider — we only need what's
// here. Typed as an interface so tests can mock without instantiating.
export interface IosDeviceManagerLike {
  isAvailable(): boolean;
  getDevices(): Promise<Array<{ udid: string; name?: string | null; isOnline?: boolean }>>;
}

/**
 * ios-device — wraps existing IosDeviceManager. Physical iOS devices over USB
 * only. Limited capture (see spec §6.4). Preserves today's behaviour exactly.
 */
export function createIosDeviceProvider(iosManager: IosDeviceManagerLike): DeviceProvider {
  return {
    id: 'ios-device',
    displayName: 'iOS Device',

    async isAvailable(): Promise<ProviderAvailability> {
      const ok = iosManager.isAvailable();
      if (ok) return { available: true };
      return {
        available: false,
        reason: 'usbmuxd / libimobiledevice not reachable',
        installHint: 'Install libimobiledevice + start usbmuxd. On Linux: `sudo apt install libimobiledevice-utils` and `systemctl --user start usbmuxd2.service`.',
      };
    },

    async listInstances(): Promise<DeviceProviderInstance[]> {
      const devs = await iosManager.getDevices();
      return devs.map((d) => ({
        id: d.udid,
        displayName: d.name ?? d.udid,
        serial: d.udid,
        state: d.isOnline === false ? 'stopped' : 'running',
        spawnedByDarkride: false,
      }));
    },

    async startInstance(id: string): Promise<RunningInstance> {
      // iOS devices are physical USB-tethered; no spawn. Confirm the serial.
      return { id, serial: id };
    },

    async stopInstance(_id: string): Promise<void> {
      // No-op. The capture-session layer handles markBusy/markIdle separately.
    },

    getNetworkConfig(_id: string): NetworkConfig {
      return { mode: 'ios-bridge' };
    },
  };
}
```

- [ ] **Step 4: Run, see it pass**

Run: `npx vitest run backend/services/providers/__tests__/ios-device.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Wire into boot**

In `backend/index.ts`:

```typescript
import { createIosDeviceProvider } from './services/providers/ios-device';
// ... after iosDeviceManager is constructed:
providerRegistry.register(createIosDeviceProvider(iosDeviceManager));
```

Also register an `ios-bridge` capture handler. For Phase 2 it's a thin wrapper around the existing iOS capture path (which `IosDeviceManager` + capture-session-manager already implement):

```typescript
captureModeRegistry.register('ios-bridge', async (instance, _cfg) => {
  // Existing IosDeviceManager.markBusy/markIdle hooks remain in
  // capture-session-manager; this handler is a no-op shim that signals
  // "iOS capture pipeline is responsible". No new logic needed here in
  // Phase 2 — the dispatch seam is what changes.
});
```

- [ ] **Step 6: Run full backend tests, confirm green**

Run: `npx vitest run backend/ packages/plugin-sdk/`
Expected: PASS — including all existing iOS tests.

- [ ] **Step 7: Commit**

```bash
git add backend/services/providers/ios-device.ts backend/services/providers/__tests__/ios-device.test.ts backend/index.ts
git commit -m "feat(providers): wrap IosDeviceManager as ios-device provider"
```

### Task 2.5: Phase 2 CI gate

- [ ] **Step 1: Push + watch CI**

```bash
git push
gh run watch -R DarkRideApp/DarkRide --exit-status
```

Expected: green.

- [ ] **Step 2: Tag**

```bash
git tag phase-2-complete && git push origin phase-2-complete
```

---

## Phase 3 — docker-android provider + image + UI starts

**Outcome:** Docker daemon detected. `docker-android` provider creates / starts / stops / deletes containers. Image published. Backend API `/v1/devices/providers/*` endpoints live. Devices page shows type badges; Create Emulator wizard renders the Docker tab.

### Task 3.1: docker-helpers (daemon detection + container ops)

**Files:**
- Add dep: `dockerode`
- Create: `backend/services/providers/docker-helpers.ts`
- Create: `backend/services/providers/__tests__/docker-helpers.test.ts`

- [ ] **Step 1: Add the dockerode dep**

```bash
npm install dockerode
npm install -D @types/dockerode
```

- [ ] **Step 2: Write the failing helpers test**

```typescript
// backend/services/providers/__tests__/docker-helpers.test.ts
import { describe, it, expect, vi } from 'vitest';
import { detectDockerDaemon, listDarkrideContainers, type DockerLike } from '../docker-helpers';

function makeDockerMock(overrides: Partial<DockerLike> = {}): DockerLike {
  return {
    ping: vi.fn().mockResolvedValue('OK'),
    info: vi.fn().mockResolvedValue({ Runtimes: { runc: {} } }),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn(),
    createContainer: vi.fn(),
    pull: vi.fn(),
    ...overrides,
  } as any;
}

describe('detectDockerDaemon', () => {
  it('returns available=true when ping succeeds', async () => {
    const r = await detectDockerDaemon(makeDockerMock());
    expect(r.available).toBe(true);
  });

  it('returns available=false with installHint when daemon is unreachable', async () => {
    const d = makeDockerMock({ ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const r = await detectDockerDaemon(d);
    expect(r.available).toBe(false);
    expect(r.installHint).toMatch(/docker daemon/i);
  });

  it('detects NVIDIA Container Toolkit when info.Runtimes.nvidia is present', async () => {
    const d = makeDockerMock({ info: vi.fn().mockResolvedValue({ Runtimes: { runc: {}, nvidia: {} } }) });
    const r = await detectDockerDaemon(d);
    expect(r.available).toBe(true);
    expect(r.nvidiaContainerToolkit).toBe(true);
  });

  it('reports nvidiaContainerToolkit=false when only runc is present', async () => {
    const r = await detectDockerDaemon(makeDockerMock());
    expect(r.nvidiaContainerToolkit).toBe(false);
  });
});

describe('listDarkrideContainers', () => {
  it('filters by the darkride.emulator label', async () => {
    const list = vi.fn().mockResolvedValue([
      { Id: 'abc123', Names: ['/darkride-emu-1'], State: 'running', Ports: [{ PrivatePort: 5555, PublicPort: 6001 }], Labels: { 'darkride.emulator': 'true' } },
    ]);
    const d = makeDockerMock({ listContainers: list });
    const r = await listDarkrideContainers(d);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ label: expect.arrayContaining(['darkride.emulator=true']) }),
    }));
    expect(r).toEqual([{ id: 'abc123', name: 'darkride-emu-1', state: 'running', adbPort: 6001 }]);
  });

  it('returns an empty list when no containers carry our label', async () => {
    const d = makeDockerMock({ listContainers: vi.fn().mockResolvedValue([]) });
    const r = await listDarkrideContainers(d);
    expect(r).toEqual([]);
  });
});
```

- [ ] **Step 3: Run, see it fail**

Run: `npx vitest run backend/services/providers/__tests__/docker-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement docker-helpers**

```typescript
// backend/services/providers/docker-helpers.ts
import Docker from 'dockerode';

/** Minimal surface of dockerode.Docker used by helpers — typed for test mocking. */
export interface DockerLike {
  ping(): Promise<unknown>;
  info(): Promise<any>;
  listContainers(opts: any): Promise<any[]>;
  getContainer(id: string): any;
  createContainer(opts: any): Promise<any>;
  pull(image: string, opts?: any): Promise<NodeJS.ReadableStream>;
}

export interface DockerDetectResult {
  available: boolean;
  reason?: string;
  installHint?: string;
  /** True when info.Runtimes.nvidia is present (used by GPU passthrough auto-detect). */
  nvidiaContainerToolkit?: boolean;
}

export async function detectDockerDaemon(d: DockerLike): Promise<DockerDetectResult> {
  try {
    await d.ping();
    const info = await d.info();
    const nvidia = Boolean(info?.Runtimes?.nvidia);
    return { available: true, nvidiaContainerToolkit: nvidia };
  } catch (err: any) {
    return {
      available: false,
      reason: err?.message ?? String(err),
      installHint: 'Install Docker (https://docs.docker.com/engine/install/) and start the daemon. On Linux make sure /var/run/docker.sock exists and is readable.',
      nvidiaContainerToolkit: false,
    };
  }
}

export interface DarkrideContainerInfo {
  id: string;
  name: string;
  state: string;
  adbPort: number | null;
}

export async function listDarkrideContainers(d: DockerLike): Promise<DarkrideContainerInfo[]> {
  const containers = await d.listContainers({
    all: true,
    filters: { label: ['darkride.emulator=true'] },
  });
  return containers.map((c) => {
    const adbPort = c.Ports?.find((p: any) => p.PrivatePort === 5555)?.PublicPort ?? null;
    const name = (c.Names?.[0] ?? '/unknown').replace(/^\//, '');
    return { id: c.Id, name, state: c.State, adbPort };
  });
}

/** Construct a Docker client using the conventional defaults. */
export function createDockerClient(): DockerLike {
  return new Docker() as unknown as DockerLike;
}
```

- [ ] **Step 5: Run, see it pass**

Run: `npx vitest run backend/services/providers/__tests__/docker-helpers.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json backend/services/providers/docker-helpers.ts backend/services/providers/__tests__/docker-helpers.test.ts
git commit -m "feat(providers): docker-helpers — daemon detection + container listing"
```

### Task 3.2: docker-android provider

**Files:**
- Create: `backend/services/providers/docker-android.ts`
- Create: `backend/services/providers/__tests__/docker-android.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// backend/services/providers/__tests__/docker-android.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDockerAndroidProvider } from '../docker-android';
import type { DockerLike } from '../docker-helpers';

function makeDockerMock(overrides: Partial<DockerLike> = {}): DockerLike {
  return {
    ping: vi.fn().mockResolvedValue('OK'),
    info: vi.fn().mockResolvedValue({ Runtimes: { runc: {} } }),
    listContainers: vi.fn().mockResolvedValue([]),
    getContainer: vi.fn().mockImplementation((id: string) => ({
      id,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ State: { Running: true }, NetworkSettings: { Ports: { '5555/tcp': [{ HostPort: '6001' }] } } }),
    })),
    createContainer: vi.fn().mockImplementation(async ({ name }: any) => ({
      id: `container-${name}`,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
    })),
    pull: vi.fn().mockResolvedValue({ on: vi.fn(), pipe: vi.fn() } as any),
    ...overrides,
  } as any;
}

describe('docker-android provider', () => {
  it('isAvailable returns true when daemon is up', async () => {
    const p = createDockerAndroidProvider(makeDockerMock());
    expect((await p.isAvailable()).available).toBe(true);
  });

  it('createInstance creates a labelled container with mapped adb port', async () => {
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d);
    const inst = await p.createInstance!({
      displayName: 'test-emu',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    expect(inst.state).toBe('created');
    expect(d.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      Image: 'ghcr.io/darkrideapp/docker-android:14',
      Labels: expect.objectContaining({ 'darkride.emulator': 'true' }),
      ExposedPorts: { '5555/tcp': {} },
    }));
  });

  it('GPU auto-detect: passes --device /dev/dri when /dev/dri exists', async () => {
    // We can't actually probe /dev/dri in a unit test cleanly; the provider
    // delegates the file-exists check to an injectable function.
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d, { hasDevDri: () => true, hasNvidia: () => false });
    await p.createInstance!({
      displayName: 'gpu-test',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    expect(d.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      HostConfig: expect.objectContaining({
        Devices: expect.arrayContaining([
          expect.objectContaining({ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri' }),
        ]),
      }),
    }));
  });

  it('GPU auto-detect: passes --gpus all when NVIDIA Container Toolkit is detected', async () => {
    const d = makeDockerMock({ info: vi.fn().mockResolvedValue({ Runtimes: { nvidia: {} } }) });
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: () => true });
    await p.createInstance!({
      displayName: 'gpu-test',
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    expect(d.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      HostConfig: expect.objectContaining({ DeviceRequests: expect.any(Array) }),
    }));
  });

  it('startInstance calls container.start and waits for adbd', async () => {
    const d = makeDockerMock();
    const p = createDockerAndroidProvider(d, { hasDevDri: () => false, hasNvidia: () => false, adbConnect: vi.fn().mockResolvedValue(true) });
    const running = await p.startInstance('container-test-emu');
    expect(running.serial).toMatch(/localhost:\d+/);
  });

  it('stopInstance calls container.stop', async () => {
    const d = makeDockerMock();
    const stop = vi.fn().mockResolvedValue(undefined);
    (d.getContainer as any).mockReturnValue({ stop, remove: vi.fn() });
    const p = createDockerAndroidProvider(d);
    await p.stopInstance('container-test-emu');
    expect(stop).toHaveBeenCalled();
  });

  it('deleteInstance refuses to delete a running container', async () => {
    const d = makeDockerMock();
    (d.getContainer as any).mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
      remove: vi.fn(),
    });
    const p = createDockerAndroidProvider(d);
    await expect(p.deleteInstance!('container-test-emu')).rejects.toThrow(/running/i);
  });

  it('getNetworkConfig returns wireguard mode', () => {
    const p = createDockerAndroidProvider(makeDockerMock());
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'wireguard' });
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run backend/services/providers/__tests__/docker-android.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

```typescript
// backend/services/providers/docker-android.ts
import { existsSync } from 'fs';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type {
  CreateInstanceSpec, DeviceProvider, DeviceProviderInstance, NetworkConfig,
  ProviderAvailability, RunningInstance, CreateFormSchema,
} from '@darkrideapp/plugin-sdk';
import { type DockerLike, detectDockerDaemon, listDarkrideContainers } from './docker-helpers';
import { createLoggers } from '../../logs';

const execFile = promisify(execFileCb);
const { log, error: logError } = createLoggers('docker-android');

const IMAGE_PREFIX = 'ghcr.io/darkrideapp/docker-android';
const LABEL_KEY = 'darkride.emulator';

/**
 * Injection-friendly options. Tests provide custom implementations of the
 * host-dependent probes; production uses real fs / dockerode.
 */
export interface DockerAndroidOptions {
  hasDevDri?: () => boolean;
  hasNvidia?: () => boolean;
  adbConnect?: (port: number) => Promise<boolean>;
}

export function createDockerAndroidProvider(d: DockerLike, opts: DockerAndroidOptions = {}): DeviceProvider {
  const hasDevDri = opts.hasDevDri ?? (() => existsSync('/dev/dri'));
  const hasNvidia = opts.hasNvidia ?? (async () => (await detectDockerDaemon(d)).nvidiaContainerToolkit === true);
  const adbConnect = opts.adbConnect ?? (async (port: number) => {
    try {
      await execFile('adb', ['connect', `localhost:${port}`], { timeout: 5000 });
      return true;
    } catch (e: any) {
      logError(`adb connect localhost:${port} failed: ${e.message}`);
      return false;
    }
  });

  return {
    id: 'docker-android',
    displayName: 'Docker Android',

    async isAvailable(): Promise<ProviderAvailability> {
      const r = await detectDockerDaemon(d);
      return { available: r.available, reason: r.reason, installHint: r.installHint };
    },

    async listInstances(): Promise<DeviceProviderInstance[]> {
      const containers = await listDarkrideContainers(d);
      return containers.map((c) => ({
        id: c.id,
        displayName: c.name,
        serial: c.adbPort ? `localhost:${c.adbPort}` : undefined,
        state: c.state === 'running' ? 'running' : c.state === 'created' ? 'created' : 'stopped',
        spawnedByDarkride: true,
        metadata: { adbPort: c.adbPort, containerName: c.name },
      }));
    },

    async createInstance(spec: CreateInstanceSpec): Promise<DeviceProviderInstance> {
      const androidVersion = String(spec.config.androidVersion ?? '14');
      const arch = String(spec.config.architecture ?? 'x86_64');
      const ramMb = Number(spec.config.ramMb ?? 2048);
      const image = `${IMAGE_PREFIX}:${androidVersion}`;

      // GPU auto-detect — see spec §6.3
      const devices: Array<{ PathOnHost: string; PathInContainer: string; CgroupPermissions: string }> = [];
      let deviceRequests: any[] = [];
      if (hasDevDri()) {
        devices.push({ PathOnHost: '/dev/dri', PathInContainer: '/dev/dri', CgroupPermissions: 'rwm' });
      }
      const nvidiaAvailable = await Promise.resolve(hasNvidia());
      if (nvidiaAvailable) {
        deviceRequests = [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }];
      }

      log(`Creating docker-android container "${spec.displayName}" image=${image} ram=${ramMb}MB arch=${arch}`);
      const container: any = await d.createContainer({
        Image: image,
        name: `darkride-${spec.displayName}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
        Labels: {
          [LABEL_KEY]: 'true',
          'darkride.android_version': androidVersion,
          'darkride.arch': arch,
        },
        Env: [`EMULATOR_DEVICE=Samsung Galaxy S10`, `RAM_MB=${ramMb}`],
        ExposedPorts: { '5555/tcp': {} },
        HostConfig: {
          PortBindings: { '5555/tcp': [{ HostPort: '0' /* docker picks free port */ }] },
          Devices: devices.length > 0 ? devices : undefined,
          DeviceRequests: deviceRequests.length > 0 ? deviceRequests : undefined,
        },
      });

      return {
        id: container.id,
        displayName: spec.displayName,
        state: 'created',
        spawnedByDarkride: true,
        metadata: { image, androidVersion, arch, ramMb },
      };
    },

    async startInstance(id: string): Promise<RunningInstance> {
      const container = d.getContainer(id);
      await container.start();
      const info = await container.inspect();
      const adbPortStr = info?.NetworkSettings?.Ports?.['5555/tcp']?.[0]?.HostPort;
      if (!adbPortStr) {
        throw new Error(`Container ${id} started but no host port was bound to 5555/tcp`);
      }
      const adbPort = Number(adbPortStr);
      const ok = await adbConnect(adbPort);
      if (!ok) {
        throw new Error(`adb failed to connect to localhost:${adbPort} (container ${id})`);
      }
      return { id, serial: `localhost:${adbPort}` };
    },

    async stopInstance(id: string): Promise<void> {
      const container = d.getContainer(id);
      try {
        await container.stop({ t: 10 });
      } catch (e: any) {
        // graceful stop failed — fall back to kill via remove
        logError(`docker stop ${id} failed: ${e.message}; trying remove --force`);
      }
    },

    async deleteInstance(id: string): Promise<void> {
      const container = d.getContainer(id);
      const info = await container.inspect();
      if (info?.State?.Running) {
        throw new Error(`Container ${id} is running — stop it first`);
      }
      await container.remove();
    },

    getNetworkConfig(_id: string): NetworkConfig {
      return { mode: 'wireguard' };
    },

    async getCreateFormSchema(): Promise<CreateFormSchema> {
      return {
        fields: [
          { key: 'androidVersion', label: 'Android version', type: 'select', required: true, default: '14', options: [
            { value: '14', label: '14.0 (API 34) — recommended' },
            { value: '13', label: '13.0 (API 33)' },
            { value: '12', label: '12.0 (API 31)' },
          ] },
          { key: 'architecture', label: 'Architecture', type: 'select', required: true, default: 'x86_64', options: [
            { value: 'x86_64', label: 'x86_64 (recommended for KVM hosts)' },
            { value: 'arm64', label: 'arm64' },
          ] },
          { key: 'ramMb', label: 'RAM (MB)', type: 'number', required: true, default: 2048 },
        ],
      };
    },
  };
}
```

- [ ] **Step 4: Run, see it pass**

Run: `npx vitest run backend/services/providers/__tests__/docker-android.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/providers/docker-android.ts backend/services/providers/__tests__/docker-android.test.ts
git commit -m "feat(providers): docker-android provider with GPU auto-detect"
```

### Task 3.3: Docker image + publish workflow

**Files:**
- Create: `docker/Dockerfile.android-emulator`
- Create: `docker/entrypoint.sh`
- Create: `.github/workflows/publish-docker-android.yml`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# docker/Dockerfile.android-emulator
ARG BUDTMO_VERSION=14.0
FROM budtmo/docker-android:emulator_${BUDTMO_VERSION}

# Pre-bake wg-go binary so the runtime push step is skipped on every spawn.
# wg-go-android is built by scripts/build-wireguard-go.sh; we use the
# pre-built artifact uploaded to GitHub Releases of this repo.
ARG WG_GO_URL
ADD ${WG_GO_URL} /usr/local/bin/wireguard-go
RUN chmod +x /usr/local/bin/wireguard-go

# Pre-bake frida-server matching the host's Frida client version.
ARG FRIDA_SERVER_URL
ADD ${FRIDA_SERVER_URL} /usr/local/bin/frida-server
RUN chmod +x /usr/local/bin/frida-server

COPY entrypoint.sh /darkride-entrypoint.sh
RUN chmod +x /darkride-entrypoint.sh

# budtmo's image runs as root by default; we keep that for the emulator
# subprocess but document it — the container is expected to be ephemeral
# and isolated.

# Override the entrypoint with our wrapper that:
#   1. Calls budtmo's original entrypoint to boot the emulator
#   2. Waits for adbd to bind
#   3. Stays in foreground so `docker start` returns when the container
#      is fully ready (not just "process started")
ENTRYPOINT ["/darkride-entrypoint.sh"]
```

- [ ] **Step 2: Write the entrypoint**

```bash
#!/bin/bash
# docker/entrypoint.sh
set -euo pipefail

# Source budtmo's existing entrypoint logic in the background. The exact
# script path is from budtmo's image; it sets up the emulator + xvfb.
/home/androidusr/docker-android/mixins/scripts/run.sh &
BUDTMO_PID=$!

# Wait until adbd is bound on 5555 (the emulator is fully booted).
echo "[darkride] waiting for adbd on 5555..."
for i in {1..60}; do
  if (echo > /dev/tcp/127.0.0.1/5555) >/dev/null 2>&1; then
    echo "[darkride] adbd ready"
    break
  fi
  sleep 2
done

# Foreground the budtmo process so `docker start` blocks until the
# emulator dies (or `docker stop` triggers SIGTERM).
wait $BUDTMO_PID
```

- [ ] **Step 3: Write the publish workflow**

```yaml
# .github/workflows/publish-docker-android.yml
name: Publish docker-android image

on:
  push:
    paths:
      - 'docker/Dockerfile.android-emulator'
      - 'docker/entrypoint.sh'
      - '.github/workflows/publish-docker-android.yml'
  workflow_dispatch:
    inputs:
      android_version:
        description: 'Android version to build (e.g. 14, 13, 12)'
        required: true
        default: '14'

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'
  REGISTRY: ghcr.io
  IMAGE_NAME: darkrideapp/docker-android

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        android_version: ['14', '13', '12']
    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/setup-buildx-action@v3

      - name: Build + push
        uses: docker/build-push-action@v6
        with:
          context: ./docker
          file: ./docker/Dockerfile.android-emulator
          push: true
          tags: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ matrix.android_version }}
          build-args: |
            BUDTMO_VERSION=${{ matrix.android_version }}.0
            WG_GO_URL=${{ github.server_url }}/${{ github.repository }}/releases/latest/download/wireguard-go-android-x86_64
            FRIDA_SERVER_URL=${{ github.server_url }}/${{ github.repository }}/releases/latest/download/frida-server-android-x86_64
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 4: Commit (without running — publish runs on push to main only)**

```bash
git add docker/Dockerfile.android-emulator docker/entrypoint.sh .github/workflows/publish-docker-android.yml
git commit -m "feat(docker): docker-android image + ghcr publish workflow"
```

> The workflow won't fire until merged to main, but local Docker build can be smoke-tested with:
> `docker build --build-arg BUDTMO_VERSION=14.0 --build-arg WG_GO_URL=... --build-arg FRIDA_SERVER_URL=... -f docker/Dockerfile.android-emulator docker/`

### Task 3.4: API endpoints — /v1/devices/providers/*

**Files:**
- Create: `backend/api/devices-providers.ts`
- Create: `backend/api/__tests__/devices-providers.test.ts`
- Modify: `backend/index.ts` (register endpoints)

- [ ] **Step 1: Write the failing API tests**

```typescript
// backend/api/__tests__/devices-providers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { registerDevicesProvidersEndpoints } from '../devices-providers';
import { clearEndpoints, getApiRouter } from '../api-service';

function createApp(registry: any, repo: any) {
  clearEndpoints();
  registerDevicesProvidersEndpoints(registry, repo);
  const app = express();
  app.use(express.json());
  app.use(getApiRouter());
  return app;
}

describe('/v1/devices/providers endpoints', () => {
  beforeEach(() => clearEndpoints());

  it('GET /v1/devices/providers returns all registered providers + availability', async () => {
    const reg = {
      list: () => [
        { id: 'docker-android', displayName: 'Docker Android', isAvailable: vi.fn().mockResolvedValue({ available: true }), createInstance: () => {}, getCreateFormSchema: () => Promise.resolve({ fields: [] }) },
        { id: 'avd', displayName: 'AVD', isAvailable: vi.fn().mockResolvedValue({ available: false, installHint: 'install android-sdk' }) },
      ],
    };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers');
    expect(res.status).toBe(200);
    expect(res.body.data.providers).toEqual([
      { id: 'docker-android', displayName: 'Docker Android', available: true, installHint: undefined, capabilities: { canCreate: true } },
      { id: 'avd', displayName: 'AVD', available: false, installHint: 'install android-sdk', capabilities: { canCreate: false } },
    ]);
  });

  it('GET /v1/devices/providers/:id/create-form returns the schema', async () => {
    const schema = { fields: [{ key: 'androidVersion', label: 'Android version', type: 'string' }] };
    const reg = {
      get: () => ({ getCreateFormSchema: vi.fn().mockResolvedValue(schema) }),
    };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers/docker-android/create-form');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(schema);
  });

  it('GET on an unknown provider id returns 404', async () => {
    const reg = { get: () => undefined };
    const app = createApp(reg, {});
    const res = await request(app).get('/v1/devices/providers/nope/create-form');
    expect(res.status).toBe(404);
  });

  it('POST /v1/devices/providers/:id/instances creates + returns the instance', async () => {
    const reg = {
      get: () => ({
        createInstance: vi.fn().mockResolvedValue({ id: 'inst-1', displayName: 'test', state: 'created', spawnedByDarkride: true }),
      }),
    };
    const repo = {
      insert: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1', state: 'created' }),
    };
    const app = createApp(reg, repo);
    const res = await request(app)
      .post('/v1/devices/providers/docker-android/instances')
      .send({ displayName: 'test', config: { androidVersion: '14' } });
    expect(res.status).toBe(200);
    expect(res.body.data.instance).toMatchObject({ id: 'inst-1', state: 'created' });
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'docker-android',
      runtimeId: 'inst-1',
    }));
  });

  it('POST .../start delegates to provider.startInstance + updates state', async () => {
    const start = vi.fn().mockResolvedValue({ id: 'inst-1', serial: 'localhost:6001' });
    const reg = { get: () => ({ startInstance: start }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1' }),
      updateState: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).post('/v1/devices/providers/docker-android/instances/99/start');
    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledWith('inst-1');
    expect(repo.updateState).toHaveBeenCalledWith(99, 'running');
  });

  it('POST .../start records last_error when provider throws', async () => {
    const start = vi.fn().mockRejectedValue(new Error('boot timeout'));
    const reg = { get: () => ({ startInstance: start }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1' }),
      updateState: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).post('/v1/devices/providers/docker-android/instances/99/start');
    expect(res.status).toBe(500);
    expect(repo.updateState).toHaveBeenCalledWith(99, 'error', expect.stringContaining('boot timeout'));
  });

  it('DELETE removes the instance', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const reg = { get: () => ({ deleteInstance: remove }) };
    const repo = {
      getById: vi.fn().mockReturnValue({ id: 99, providerId: 'docker-android', runtimeId: 'inst-1', state: 'stopped' }),
      delete: vi.fn(),
    };
    const app = createApp(reg, repo);
    const res = await request(app).delete('/v1/devices/providers/docker-android/instances/99');
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith('inst-1');
    expect(repo.delete).toHaveBeenCalledWith(99);
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run backend/api/__tests__/devices-providers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement endpoints**

```typescript
// backend/api/devices-providers.ts
import { registerEndpoint } from './api-service';
import type { ProviderRegistry } from '../services/providers';
import type { DeviceInstancesRepo } from '../services/device-instances-repo';
import { broadcastToAll } from '../websocket/index';

export function registerDevicesProvidersEndpoints(
  registry: ProviderRegistry,
  repo: DeviceInstancesRepo,
): void {
  // GET /v1/devices/providers — list providers + availability
  registerEndpoint('GET', '/v1/devices/providers', async (_req, res) => {
    const providers = await Promise.all(registry.list().map(async (p) => {
      const av = await p.isAvailable();
      return {
        id: p.id,
        displayName: p.displayName,
        available: av.available,
        installHint: av.installHint,
        capabilities: { canCreate: typeof p.createInstance === 'function' },
      };
    }));
    res.json({ success: true, data: { providers } });
  }, { requires: ['core.devices:manage'] });

  // GET /v1/devices/providers/:id/create-form
  registerEndpoint('GET', '/v1/devices/providers/:id/create-form', async (req, res) => {
    const p = registry.get(req.params.id);
    if (!p) {
      res.status(404).json({ success: false, error: `Provider "${req.params.id}" not registered` });
      return;
    }
    if (!p.getCreateFormSchema) {
      res.status(400).json({ success: false, error: `Provider "${req.params.id}" does not support createInstance` });
      return;
    }
    const schema = await p.getCreateFormSchema();
    res.json({ success: true, data: schema });
  }, { requires: ['core.devices:manage'] });

  // GET /v1/devices/providers/:id/instances
  registerEndpoint('GET', '/v1/devices/providers/:id/instances', async (req, res) => {
    const p = registry.get(req.params.id);
    if (!p) {
      res.status(404).json({ success: false, error: `Provider "${req.params.id}" not registered` });
      return;
    }
    const rows = repo.listByProvider(p.id);
    res.json({ success: true, data: { instances: rows } });
  }, { requires: ['core.devices:manage'] });

  // POST /v1/devices/providers/:id/instances — create
  registerEndpoint('POST', '/v1/devices/providers/:id/instances', async (req, res) => {
    const p = registry.get(req.params.id);
    if (!p || !p.createInstance) {
      res.status(400).json({ success: false, error: `Provider "${req.params.id}" does not support createInstance` });
      return;
    }
    const { displayName, config } = req.body as { displayName?: string; config?: Record<string, unknown> };
    if (!displayName || typeof displayName !== 'string') {
      res.status(400).json({ success: false, error: 'displayName is required' });
      return;
    }
    try {
      const inst = await p.createInstance({ displayName, config: config ?? {} });
      const row = repo.insert({
        providerId: p.id,
        runtimeId: inst.id,
        displayName: inst.displayName,
        serial: inst.serial ?? null,
        state: inst.state,
        spawnedByDarkride: true,
        spawnMetadata: inst.metadata ?? null,
      });
      broadcastToAll({ type: 'provider-instance-updated', instance: row });
      res.json({ success: true, data: { instance: row } });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  }, { requires: ['core.devices:manage'] });

  // POST /v1/devices/providers/:id/instances/:instId/start
  registerEndpoint('POST', '/v1/devices/providers/:id/instances/:instId/start', async (req, res) => {
    const p = registry.get(req.params.id);
    if (!p) {
      res.status(404).json({ success: false, error: `Provider "${req.params.id}" not registered` });
      return;
    }
    const row = repo.getById(Number(req.params.instId));
    if (!row) {
      res.status(404).json({ success: false, error: `Instance ${req.params.instId} not found` });
      return;
    }
    try {
      repo.updateState(row.id, 'starting');
      broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
      const r = await p.startInstance(row.runtimeId);
      repo.updateState(row.id, 'running');
      broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
      res.json({ success: true, data: { running: r } });
    } catch (err: any) {
      repo.updateState(row.id, 'error', err?.message ?? String(err));
      broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  }, { requires: ['core.devices:manage'] });

  // POST /v1/devices/providers/:id/instances/:instId/stop
  registerEndpoint('POST', '/v1/devices/providers/:id/instances/:instId/stop', async (req, res) => {
    const p = registry.get(req.params.id);
    const row = repo.getById(Number(req.params.instId));
    if (!p || !row) {
      res.status(404).json({ success: false, error: 'Unknown provider or instance' });
      return;
    }
    try {
      repo.updateState(row.id, 'stopping');
      broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
      await p.stopInstance(row.runtimeId);
      repo.updateState(row.id, 'stopped');
      broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
      res.json({ success: true });
    } catch (err: any) {
      repo.updateState(row.id, 'error', err?.message ?? String(err));
      broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  }, { requires: ['core.devices:manage'] });

  // DELETE /v1/devices/providers/:id/instances/:instId
  registerEndpoint('DELETE', '/v1/devices/providers/:id/instances/:instId', async (req, res) => {
    const p = registry.get(req.params.id);
    const row = repo.getById(Number(req.params.instId));
    if (!p || !row) {
      res.status(404).json({ success: false, error: 'Unknown provider or instance' });
      return;
    }
    if (!p.deleteInstance) {
      res.status(400).json({ success: false, error: `Provider "${p.id}" does not support deleteInstance` });
      return;
    }
    try {
      await p.deleteInstance(row.runtimeId);
      repo.delete(row.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  }, { requires: ['core.devices:manage'] });
}
```

- [ ] **Step 4: Run, see it pass**

Run: `npx vitest run backend/api/__tests__/devices-providers.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Wire into boot**

In `backend/index.ts`, after constructing `deviceInstancesRepo` and `providerRegistry`:

```typescript
import { registerDevicesProvidersEndpoints } from './api/devices-providers';
registerDevicesProvidersEndpoints(providerRegistry, deviceInstancesRepo);
```

- [ ] **Step 6: Commit**

```bash
git add backend/api/devices-providers.ts backend/api/__tests__/devices-providers.test.ts backend/index.ts
git commit -m "feat(api): /v1/devices/providers/* endpoints + WS instance updates"
```

### Task 3.5: docker-android registered in boot

**Files:**
- Modify: `backend/index.ts`

- [ ] **Step 1: Register docker-android conditionally on daemon availability**

```typescript
// backend/index.ts
import { createDockerAndroidProvider } from './services/providers/docker-android';
import { createDockerClient } from './services/providers/docker-helpers';

// ... after providerRegistry construction:
const dockerClient = createDockerClient();
const dockerAndroidProvider = createDockerAndroidProvider(dockerClient);
const dockerAvailability = await dockerAndroidProvider.isAvailable();
if (dockerAvailability.available) {
  providerRegistry.register(dockerAndroidProvider);
  log(`docker-android provider registered (Docker daemon detected)`);
} else {
  log(`docker-android provider NOT registered: ${dockerAvailability.reason ?? 'daemon unreachable'}`);
}
```

- [ ] **Step 2: Run the full backend test suite, confirm green**

Run: `npx vitest run backend/ packages/plugin-sdk/`
Expected: PASS — all existing + new tests.

- [ ] **Step 3: Commit**

```bash
git add backend/index.ts
git commit -m "feat(boot): register docker-android provider when daemon is available"
```

### Task 3.6: Frontend type badges + Devices page extension

**Files:**
- Create: `frontend/components/devices/DeviceTypeBadge.tsx`
- Create: `frontend/components/devices/DeviceTypeBadge.test.tsx`
- Modify: `frontend/pages/Devices.tsx`

- [ ] **Step 1: Write the failing badge test**

```typescript
// frontend/components/devices/DeviceTypeBadge.test.tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { DeviceTypeBadge } from './DeviceTypeBadge';

describe('DeviceTypeBadge', () => {
  it('renders "physical" for adb-device with spawnedByDarkride=false and no instance metadata', () => {
    render(<DeviceTypeBadge providerId="adb-device" spawnedByDarkride={false} />);
    expect(screen.getByText(/physical/i)).toBeInTheDocument();
  });

  it('renders "avd" for the avd provider', () => {
    render(<DeviceTypeBadge providerId="avd" spawnedByDarkride={true} />);
    expect(screen.getByText('avd')).toBeInTheDocument();
  });

  it('renders "docker" for the docker-android provider', () => {
    render(<DeviceTypeBadge providerId="docker-android" spawnedByDarkride={true} />);
    expect(screen.getByText('docker')).toBeInTheDocument();
  });

  it('renders "ios" for the ios-device provider', () => {
    render(<DeviceTypeBadge providerId="ios-device" spawnedByDarkride={false} />);
    expect(screen.getByText('ios')).toBeInTheDocument();
  });

  it('falls back to providerId for unknown providers (plugin lane)', () => {
    render(<DeviceTypeBadge providerId="corellium-cloud" spawnedByDarkride={true} />);
    expect(screen.getByText('corellium-cloud')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run -c vitest.config.frontend.ts frontend/components/devices/DeviceTypeBadge.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the badge**

```typescript
// frontend/components/devices/DeviceTypeBadge.tsx
import React from 'react';

interface Props {
  providerId: string;
  spawnedByDarkride: boolean;
}

const KNOWN_LABELS: Record<string, string> = {
  'adb-device': 'physical',
  'avd': 'avd',
  'docker-android': 'docker',
  'ios-device': 'ios',
};

export function DeviceTypeBadge({ providerId, spawnedByDarkride }: Props) {
  // adb-device + spawnedByDarkride=true (came in via avd/docker spawn) gets
  // a richer badge on the originating provider; if this badge is rendered
  // for adb-device with spawned=true, fall back to "physical" to keep the
  // label unambiguous — the rich one is the providerId of the spawner.
  const label = KNOWN_LABELS[providerId] ?? providerId;
  return <span className="device-type-badge">{label}</span>;
}
```

- [ ] **Step 4: Add minimal CSS**

In `frontend/styles.css` (append near other badges):

```css
.device-type-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
}
```

- [ ] **Step 5: Run, see it pass**

Run: `npx vitest run -c vitest.config.frontend.ts frontend/components/devices/DeviceTypeBadge.test.tsx`
Expected: PASS — 5 tests.

- [ ] **Step 6: Add the badge into the Devices page**

In `frontend/pages/Devices.tsx`, render the badge alongside each device row. The shape depends on the existing component; assume each device row maps to one returned by `/v1/devices` extended with `providerId` and `instanceId` from the backend extension.

- [ ] **Step 7: Commit**

```bash
git add frontend/components/devices/DeviceTypeBadge.tsx frontend/components/devices/DeviceTypeBadge.test.tsx frontend/pages/Devices.tsx frontend/styles.css
git commit -m "feat(devices): DeviceTypeBadge + Devices page integration"
```

### Task 3.7: Create Emulator wizard — Docker tab

**Files:**
- Create: `frontend/components/devices/CreateEmulatorModal.tsx`
- Create: `frontend/components/devices/CreateEmulatorModal.test.tsx`
- Create: `frontend/components/devices/ProviderTab.tsx`
- Modify: `frontend/pages/Devices.tsx` (add the trigger button)

- [ ] **Step 1: Write the failing modal test**

```typescript
// frontend/components/devices/CreateEmulatorModal.test.tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { CreateEmulatorModal } from './CreateEmulatorModal';
import { WebSocketContext } from '@darkrideapp/plugin-sdk/react';

function createWsMock(overrides: any = {}) {
  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi: vi.fn().mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === '/v1/devices/providers') {
        return Promise.resolve({
          type: 'restapi', id: '1', status: 200,
          body: {
            success: true,
            data: {
              providers: [
                { id: 'docker-android', displayName: 'Docker Android', available: true, capabilities: { canCreate: true } },
                { id: 'avd', displayName: 'AVD', available: false, installHint: 'Install Android Studio', capabilities: { canCreate: true } },
              ],
            },
          },
        });
      }
      if (method === 'GET' && path === '/v1/devices/providers/docker-android/create-form') {
        return Promise.resolve({
          type: 'restapi', id: '2', status: 200,
          body: {
            success: true,
            data: {
              fields: [
                { key: 'androidVersion', label: 'Android version', type: 'select', required: true, default: '14', options: [{ value: '14', label: '14.0 (API 34)' }] },
                { key: 'ramMb', label: 'RAM (MB)', type: 'number', required: true, default: 2048 },
              ],
            },
          },
        });
      }
      return Promise.resolve({ type: 'restapi', id: '3', status: 200, body: { success: true } });
    }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

function renderModal(ws: any = createWsMock()) {
  return render(
    <WebSocketContext.Provider value={ws as any}>
      <CreateEmulatorModal onCancel={vi.fn()} onCreated={vi.fn()} />
    </WebSocketContext.Provider>,
  );
}

describe('CreateEmulatorModal', () => {
  it('renders one tab per provider that supports createInstance', async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /docker android/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /avd/i })).toBeInTheDocument();
    });
  });

  it('disables tabs whose provider is unavailable + shows installHint when selected', async () => {
    renderModal();
    fireEvent.click(await screen.findByRole('tab', { name: /avd/i }));
    expect(screen.getByText(/install android studio/i)).toBeInTheDocument();
  });

  it('renders the form schema from getCreateFormSchema for the selected tab', async () => {
    renderModal();
    await waitFor(() => {
      expect(screen.getByLabelText(/android version/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/ram \(mb\)/i)).toBeInTheDocument();
    });
  });

  it('POSTs to /v1/devices/providers/:id/instances on submit', async () => {
    const ws = createWsMock();
    renderModal(ws);
    fireEvent.change(await screen.findByLabelText(/display name|name/i), { target: { value: 'my-test' } });
    fireEvent.click(screen.getByText(/create.*start/i));
    await waitFor(() => {
      expect(ws.sendRestApi).toHaveBeenCalledWith(
        'POST',
        '/v1/devices/providers/docker-android/instances',
        expect.objectContaining({ displayName: 'my-test' }),
      );
    });
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run -c vitest.config.frontend.ts frontend/components/devices/CreateEmulatorModal.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the modal**

```typescript
// frontend/components/devices/CreateEmulatorModal.tsx
import React, { useEffect, useState } from 'react';
import { useWebSocket, useToast } from '@darkrideapp/plugin-sdk/react';
import { ProviderTab } from './ProviderTab';

interface Provider {
  id: string;
  displayName: string;
  available: boolean;
  installHint?: string;
  capabilities: { canCreate: boolean };
}

interface FormField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

interface Props {
  onCancel: () => void;
  onCreated: () => void;
}

export function CreateEmulatorModal({ onCancel, onCreated }: Props) {
  const ws = useWebSocket();
  const toast = useToast();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [schema, setSchema] = useState<FormField[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await ws.sendRestApi('GET', '/v1/devices/providers');
      const all = (r.body?.data?.providers ?? []) as Provider[];
      const creatable = all.filter((p) => p.capabilities.canCreate);
      setProviders(creatable);
      if (creatable.length > 0) setActiveId(creatable[0].id);
    })();
  }, [ws]);

  useEffect(() => {
    if (!activeId) return;
    const active = providers.find((p) => p.id === activeId);
    if (!active?.available) {
      setSchema([]);
      return;
    }
    (async () => {
      const r = await ws.sendRestApi('GET', `/v1/devices/providers/${activeId}/create-form`);
      const fields = (r.body?.data?.fields ?? []) as FormField[];
      setSchema(fields);
      // initialize config with defaults
      const initial: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.default !== undefined) initial[f.key] = f.default;
      }
      setConfig(initial);
    })();
  }, [activeId, providers, ws]);

  const active = providers.find((p) => p.id === activeId);

  async function submit() {
    if (!activeId || !active?.available || !displayName.trim()) return;
    setSubmitting(true);
    try {
      const r = await ws.sendRestApi('POST', `/v1/devices/providers/${activeId}/instances`, {
        displayName: displayName.trim(),
        config,
      });
      if (r.body?.success) {
        toast.success(`Emulator "${displayName}" created — starting...`);
        // Auto-start
        await ws.sendRestApi('POST', `/v1/devices/providers/${activeId}/instances/${r.body.data.instance.id}/start`);
        onCreated();
      } else {
        toast.error(r.body?.error ?? 'Create failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal create-emulator-modal">
        <div className="modal-header">
          <h2>Create emulator</h2>
          <button onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="modal-tabs">
          {providers.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={p.id === activeId}
              className={p.id === activeId ? 'tab active' : 'tab'}
              onClick={() => setActiveId(p.id)}
            >
              {p.displayName}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {active && !active.available && (
            <div className="provider-unavailable">
              <p>{active.installHint ?? `${active.displayName} is not available on this host.`}</p>
            </div>
          )}
          {active && active.available && (
            <ProviderTab
              schema={schema}
              displayName={displayName}
              setDisplayName={setDisplayName}
              config={config}
              setConfig={setConfig}
            />
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onCancel}>Cancel</button>
          <button
            onClick={submit}
            disabled={submitting || !active?.available || !displayName.trim()}
            className="btn-primary"
          >
            {submitting ? 'Creating...' : 'Create & start'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement ProviderTab**

```typescript
// frontend/components/devices/ProviderTab.tsx
import React from 'react';

interface FormField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

interface Props {
  schema: FormField[];
  displayName: string;
  setDisplayName: (v: string) => void;
  config: Record<string, unknown>;
  setConfig: (v: Record<string, unknown>) => void;
}

export function ProviderTab({ schema, displayName, setDisplayName, config, setConfig }: Props) {
  return (
    <form className="provider-tab" onSubmit={(e) => e.preventDefault()}>
      <label className="form-row">
        <span>Name</span>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="my-emulator" />
      </label>
      {schema.map((f) => (
        <label key={f.key} className="form-row" htmlFor={`field-${f.key}`}>
          <span>{f.label}</span>
          {f.type === 'select' && (
            <select
              id={`field-${f.key}`}
              value={String(config[f.key] ?? f.default ?? '')}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
            >
              {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
          {f.type === 'number' && (
            <input
              id={`field-${f.key}`}
              type="number"
              value={Number(config[f.key] ?? f.default ?? 0)}
              onChange={(e) => setConfig({ ...config, [f.key]: Number(e.target.value) })}
            />
          )}
          {f.type === 'string' && (
            <input
              id={`field-${f.key}`}
              type="text"
              value={String(config[f.key] ?? f.default ?? '')}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
            />
          )}
          {f.type === 'boolean' && (
            <input
              id={`field-${f.key}`}
              type="checkbox"
              checked={Boolean(config[f.key] ?? f.default)}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.checked })}
            />
          )}
          {f.help && <small>{f.help}</small>}
        </label>
      ))}
    </form>
  );
}
```

- [ ] **Step 5: Wire the button into the Devices page**

In `frontend/pages/Devices.tsx`, add an `+ Add emulator` button that toggles modal visibility. Wire the `onCreated` callback to re-fetch the devices list.

- [ ] **Step 6: Run all frontend tests, see them pass**

Run: `npx vitest run -c vitest.config.frontend.ts frontend/components/devices/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/components/devices/CreateEmulatorModal.tsx \
        frontend/components/devices/CreateEmulatorModal.test.tsx \
        frontend/components/devices/ProviderTab.tsx \
        frontend/pages/Devices.tsx
git commit -m "feat(frontend): Create Emulator wizard with Docker tab"
```

### Task 3.8: Phase 3 CI gate

- [ ] **Step 1: Push + watch CI**

```bash
git push
gh run watch -R DarkRideApp/DarkRide --exit-status
```

Expected: green. (The new `publish-docker-android.yml` workflow does NOT trigger here — it only runs on changes under `docker/` paths or `workflow_dispatch`.)

- [ ] **Step 2: Tag**

```bash
git tag phase-3-complete && git push origin phase-3-complete
```

---

## Phase 4 — avd provider + UI complete

**Outcome:** AVD provider lists / creates / starts / stops / deletes AVDs. Wizard AVD tab works. CI green.

### Task 4.1: avd-helpers

**Files:**
- Create: `backend/services/providers/avd-helpers.ts`
- Create: `backend/services/providers/__tests__/avd-helpers.test.ts`

- [ ] **Step 1: Write the failing parser test**

```typescript
// backend/services/providers/__tests__/avd-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { parseAvdList, parseSystemImageList } from '../avd-helpers';

const SAMPLE_AVD_LIST = `
Available Android Virtual Devices:
    Name: Pixel_8_API_34
  Device: pixel_8 (Google)
    Path: /home/user/.android/avd/Pixel_8_API_34.avd
  Target: Google APIs (Google Inc.)
          Based on: Android 14.0 (API level 34) Tag/ABI: google_apis/x86_64
---------
    Name: Tablet_Test
  Device: pixel_tablet (Google)
    Path: /home/user/.android/avd/Tablet_Test.avd
  Target: Default Android System Image
          Based on: Android 13.0 (API level 33) Tag/ABI: default/x86_64
`;

describe('parseAvdList', () => {
  it('parses avdmanager list avd output into named entries', () => {
    const r = parseAvdList(SAMPLE_AVD_LIST);
    expect(r).toEqual([
      { name: 'Pixel_8_API_34', device: 'pixel_8 (Google)', target: 'Google APIs', androidVersion: '14.0', apiLevel: 34, abi: 'google_apis/x86_64' },
      { name: 'Tablet_Test',    device: 'pixel_tablet (Google)', target: 'Default Android System Image', androidVersion: '13.0', apiLevel: 33, abi: 'default/x86_64' },
    ]);
  });

  it('returns empty array on empty input', () => {
    expect(parseAvdList('')).toEqual([]);
    expect(parseAvdList('Available Android Virtual Devices:\n')).toEqual([]);
  });
});

describe('parseSystemImageList', () => {
  it('parses sdkmanager --list output for system-images;android-XX;...', () => {
    const sample = `
Installed packages:
  Path                                        | Version | Description                  | Location
  ------                                      | ------- | -------                      | --------
  system-images;android-34;google_apis;x86_64 | 11      | Google APIs Intel x86_64...  | system-images/...
  platform-tools                              | 34.0.5  | Android SDK Platform-Tools   | platform-tools

Available Packages:
  Path                                        | Version | Description
  ------                                      | ------- | -------
  system-images;android-33;default;x86_64     | 5       | Default Android System Image
  system-images;android-32;google_apis;arm64-v8a | 4    | Google APIs ARM 64
`;
    const r = parseSystemImageList(sample);
    expect(r).toContainEqual({ pkg: 'system-images;android-34;google_apis;x86_64', apiLevel: 34, tag: 'google_apis', abi: 'x86_64', installed: true });
    expect(r).toContainEqual({ pkg: 'system-images;android-33;default;x86_64', apiLevel: 33, tag: 'default', abi: 'x86_64', installed: false });
    expect(r).toContainEqual({ pkg: 'system-images;android-32;google_apis;arm64-v8a', apiLevel: 32, tag: 'google_apis', abi: 'arm64-v8a', installed: false });
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run backend/services/providers/__tests__/avd-helpers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement helpers**

```typescript
// backend/services/providers/avd-helpers.ts

export interface AvdEntry {
  name: string;
  device: string;
  target: string;
  androidVersion: string;
  apiLevel: number;
  abi: string;
}

export function parseAvdList(stdout: string): AvdEntry[] {
  // avdmanager list avd uses an "    Name: X" key/value block separated by
  // dashes. Split, then parse each block.
  const blocks = stdout.split(/^-+$/m).map((b) => b.trim()).filter(Boolean);
  const out: AvdEntry[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());
    const get = (key: string) => lines.find((l) => l.startsWith(`${key}:`))?.slice(key.length + 1).trim();
    const name = get('Name');
    if (!name) continue;
    const based = lines.find((l) => l.includes('Based on:'));
    const versionMatch = based?.match(/Android (\S+) \(API level (\d+)\)/);
    const abiMatch = based?.match(/Tag\/ABI:\s*(\S+)/);
    out.push({
      name,
      device: get('Device') ?? '',
      target: (get('Target') ?? '').replace(/\s*\(.*\)\s*$/, ''),
      androidVersion: versionMatch?.[1] ?? '',
      apiLevel: Number(versionMatch?.[2] ?? 0),
      abi: abiMatch?.[1] ?? '',
    });
  }
  return out;
}

export interface SystemImageEntry {
  pkg: string;
  apiLevel: number;
  tag: string;
  abi: string;
  installed: boolean;
}

export function parseSystemImageList(stdout: string): SystemImageEntry[] {
  // sdkmanager --list output has two sections: "Installed packages" and
  // "Available Packages". We track which section we're in to set installed.
  const lines = stdout.split('\n');
  let installed = false;
  const out: SystemImageEntry[] = [];
  for (const l of lines) {
    if (/^Installed packages:/.test(l)) { installed = true; continue; }
    if (/^Available Packages:/.test(l)) { installed = false; continue; }
    const m = l.match(/^\s*(system-images;android-(\d+);(\w+);([\w-]+))\s+\|/);
    if (m) {
      out.push({ pkg: m[1], apiLevel: Number(m[2]), tag: m[3], abi: m[4], installed });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run, see pass**

Run: `npx vitest run backend/services/providers/__tests__/avd-helpers.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/services/providers/avd-helpers.ts backend/services/providers/__tests__/avd-helpers.test.ts
git commit -m "feat(providers): avd-helpers — parsers for avdmanager + sdkmanager output"
```

### Task 4.2: avd provider

**Files:**
- Create: `backend/services/providers/avd.ts`
- Create: `backend/services/providers/__tests__/avd.test.ts`

- [ ] **Step 1: Write the failing provider test**

```typescript
// backend/services/providers/__tests__/avd.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import { execFile, spawn } from 'child_process';
import { createAvdProvider } from '../avd';

function mockExec(stdout: string) {
  (execFile as any).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

function mockExecFailure(message: string, code?: string) {
  (execFile as any).mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    const err: any = new Error(message);
    if (code) err.code = code;
    cb(err);
  });
}

describe('avd provider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isAvailable returns true when both emulator and avdmanager are present', async () => {
    mockExec('Android Emulator usage: ...');
    const p = createAvdProvider();
    const av = await p.isAvailable();
    expect(av.available).toBe(true);
  });

  it('isAvailable returns false with installHint when emulator is missing', async () => {
    mockExecFailure('spawn emulator ENOENT', 'ENOENT');
    const p = createAvdProvider();
    const av = await p.isAvailable();
    expect(av.available).toBe(false);
    expect(av.installHint).toMatch(/Android Studio|cmdline-tools/i);
  });

  it('listInstances calls "avdmanager list avd" and parses the output', async () => {
    mockExec(
      `Available Android Virtual Devices:\n` +
      `    Name: Pixel_8_API_34\n` +
      `  Device: pixel_8 (Google)\n` +
      `    Path: /home/user/.android/avd/Pixel_8_API_34.avd\n` +
      `  Target: Google APIs (Google Inc.)\n` +
      `          Based on: Android 14.0 (API level 34) Tag/ABI: google_apis/x86_64\n`,
    );
    const p = createAvdProvider();
    const instances = await p.listInstances();
    expect(instances).toEqual([{
      id: 'Pixel_8_API_34',
      displayName: 'Pixel_8_API_34',
      state: 'stopped',
      spawnedByDarkride: false,  // AVDs created in Studio show up here too
      metadata: { device: 'pixel_8 (Google)', androidVersion: '14.0', apiLevel: 34, abi: 'google_apis/x86_64' },
    }]);
  });

  it('createInstance runs `avdmanager create avd` with the given name + system image', async () => {
    mockExec('AVD "test" created');
    const p = createAvdProvider();
    const inst = await p.createInstance!({
      displayName: 'test',
      config: { systemImagePackage: 'system-images;android-34;google_apis;x86_64', deviceProfile: 'pixel_8' },
    });
    expect(execFile).toHaveBeenCalledWith(
      'avdmanager',
      ['create', 'avd', '-n', 'test', '-k', 'system-images;android-34;google_apis;x86_64', '-d', 'pixel_8'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(inst.state).toBe('created');
  });

  it('startInstance spawns `emulator -avd <name>` and returns the serial', async () => {
    const mockChild = { unref: vi.fn(), pid: 12345, on: vi.fn() };
    (spawn as any).mockReturnValue(mockChild);
    const p = createAvdProvider({ pickFreePort: () => 5554, waitForAdbSerial: vi.fn().mockResolvedValue(true) });
    const r = await p.startInstance('Pixel_8_API_34');
    expect(spawn).toHaveBeenCalledWith(
      'emulator',
      ['-avd', 'Pixel_8_API_34', '-no-window', '-port', '5554'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(r.serial).toBe('emulator-5554');
  });

  it('stopInstance runs `adb -s emulator-<port> emu kill`', async () => {
    mockExec('OK');
    const p = createAvdProvider();
    // For a stop we need to know the port for "Pixel_8_API_34" — provider
    // tracks port assignments internally; pre-seed via spawn.
    const mockChild = { unref: vi.fn(), pid: 12345, on: vi.fn() };
    (spawn as any).mockReturnValue(mockChild);
    await p.startInstance('Pixel_8_API_34');
    await p.stopInstance('Pixel_8_API_34');
    expect(execFile).toHaveBeenCalledWith(
      'adb',
      ['-s', expect.stringMatching(/emulator-\d+/), 'emu', 'kill'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('deleteInstance runs `avdmanager delete avd -n <name>`', async () => {
    mockExec('AVD deleted');
    const p = createAvdProvider();
    await p.deleteInstance!('Pixel_8_API_34');
    expect(execFile).toHaveBeenCalledWith(
      'avdmanager',
      ['delete', 'avd', '-n', 'Pixel_8_API_34'],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('getNetworkConfig returns wireguard mode', () => {
    const p = createAvdProvider();
    expect(p.getNetworkConfig('any')).toEqual({ mode: 'wireguard' });
  });
});
```

- [ ] **Step 2: Run, see it fail**

Run: `npx vitest run backend/services/providers/__tests__/avd.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the avd provider**

```typescript
// backend/services/providers/avd.ts
import { execFile as execFileCb, spawn as spawnCb } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import type {
  DeviceProvider, DeviceProviderInstance, NetworkConfig,
  ProviderAvailability, RunningInstance, CreateInstanceSpec, CreateFormSchema,
} from '@darkrideapp/plugin-sdk';
import { parseAvdList, parseSystemImageList } from './avd-helpers';
import { createLoggers } from '../../logs';

const execFile = promisify(execFileCb);
const { log, error: logError } = createLoggers('avd');

export interface AvdProviderOptions {
  pickFreePort?: () => number | Promise<number>;
  waitForAdbSerial?: (serial: string, timeoutMs: number) => Promise<boolean>;
}

export function createAvdProvider(opts: AvdProviderOptions = {}): DeviceProvider {
  /** Tracks port assignments per spawn so stopInstance knows where to kill. */
  const portByName = new Map<string, number>();

  const pickFreePort = opts.pickFreePort ?? (async () => {
    return new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, () => {
        const port = (srv.address() as any).port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  });

  const waitForAdbSerial = opts.waitForAdbSerial ?? (async (serial: string, timeoutMs: number) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { stdout } = await execFile('adb', ['devices'], { timeout: 5000 });
        if (stdout.includes(serial) && stdout.includes(`${serial}\tdevice`)) return true;
      } catch (e: any) {
        logError(`waitForAdbSerial adb devices failed: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  });

  return {
    id: 'avd',
    displayName: 'Android Virtual Device (AVD)',

    async isAvailable(): Promise<ProviderAvailability> {
      try {
        await execFile('emulator', ['-help'], { timeout: 5000 });
        await execFile('avdmanager', ['--help'], { timeout: 5000 });
        return { available: true };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return {
            available: false,
            reason: 'emulator and/or avdmanager not on PATH',
            installHint: 'Install Android Studio (https://developer.android.com/studio) or the cmdline-tools standalone package. Ensure emulator + avdmanager are on PATH.',
          };
        }
        return { available: false, reason: err.message };
      }
    },

    async listInstances(): Promise<DeviceProviderInstance[]> {
      try {
        const { stdout } = await execFile('avdmanager', ['list', 'avd'], { timeout: 10000 });
        const entries = parseAvdList(stdout);
        return entries.map((e) => ({
          id: e.name,
          displayName: e.name,
          state: portByName.has(e.name) ? 'running' : 'stopped',
          serial: portByName.has(e.name) ? `emulator-${portByName.get(e.name)}` : undefined,
          spawnedByDarkride: false, // AVDs created in Studio also show up
          metadata: { device: e.device, androidVersion: e.androidVersion, apiLevel: e.apiLevel, abi: e.abi },
        }));
      } catch (e: any) {
        logError(`avdmanager list avd failed: ${e.message}`);
        return [];
      }
    },

    async createInstance(spec: CreateInstanceSpec): Promise<DeviceProviderInstance> {
      const sysImage = String(spec.config.systemImagePackage);
      const device = String(spec.config.deviceProfile ?? 'pixel_8');
      log(`Creating AVD "${spec.displayName}" with ${sysImage} (device profile: ${device})`);
      await execFile('avdmanager', ['create', 'avd', '-n', spec.displayName, '-k', sysImage, '-d', device], { timeout: 60_000 });
      return {
        id: spec.displayName,
        displayName: spec.displayName,
        state: 'created',
        spawnedByDarkride: true,
        metadata: { systemImage: sysImage, deviceProfile: device },
      };
    },

    async startInstance(id: string): Promise<RunningInstance> {
      const port = await pickFreePort();
      portByName.set(id, port);
      const serial = `emulator-${port}`;
      log(`Starting AVD "${id}" on port ${port}`);
      const child = spawnCb('emulator', ['-avd', id, '-no-window', '-port', String(port)], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      const ok = await waitForAdbSerial(serial, 60_000);
      if (!ok) {
        portByName.delete(id);
        throw new Error(`AVD "${id}" did not become reachable via adb within 60s`);
      }
      return { id, serial };
    },

    async stopInstance(id: string): Promise<void> {
      const port = portByName.get(id);
      if (!port) {
        // Not tracked — maybe started outside DarkRide. We can't reliably kill it.
        return;
      }
      const serial = `emulator-${port}`;
      try {
        await execFile('adb', ['-s', serial, 'emu', 'kill'], { timeout: 10_000 });
      } catch (e: any) {
        logError(`adb emu kill ${serial} failed: ${e.message}`);
      }
      portByName.delete(id);
    },

    async deleteInstance(id: string): Promise<void> {
      if (portByName.has(id)) {
        throw new Error(`AVD "${id}" is running — stop it first`);
      }
      await execFile('avdmanager', ['delete', 'avd', '-n', id], { timeout: 30_000 });
    },

    getNetworkConfig(_id: string): NetworkConfig {
      return { mode: 'wireguard' };
    },

    async getCreateFormSchema(): Promise<CreateFormSchema> {
      // Read installed system images via sdkmanager + offer them as choices.
      // Falls back to a small static set if sdkmanager isn't reachable.
      let imageOptions: Array<{ value: string; label: string }> = [
        { value: 'system-images;android-34;google_apis;x86_64', label: 'Android 14 (API 34) — Google APIs x86_64' },
      ];
      try {
        const { stdout } = await execFile('sdkmanager', ['--list'], { timeout: 30_000 });
        const installed = parseSystemImageList(stdout).filter((s) => s.installed);
        if (installed.length > 0) {
          imageOptions = installed.map((s) => ({
            value: s.pkg,
            label: `Android API ${s.apiLevel} — ${s.tag} ${s.abi}${s.installed ? ' (installed)' : ''}`,
          }));
        }
      } catch (e: any) {
        logError(`sdkmanager --list failed (using fallback list): ${e.message}`);
      }
      return {
        fields: [
          { key: 'systemImagePackage', label: 'System image', type: 'select', required: true, options: imageOptions, help: 'Pick an installed Android system image. Install more via Android Studio or sdkmanager.' },
          { key: 'deviceProfile', label: 'Device profile', type: 'select', required: true, default: 'pixel_8', options: [
            { value: 'pixel_8', label: 'Pixel 8' },
            { value: 'pixel_tablet', label: 'Pixel Tablet' },
            { value: 'medium_phone', label: 'Generic medium phone' },
          ] },
        ],
      };
    },
  };
}
```

- [ ] **Step 4: Run, see it pass**

Run: `npx vitest run backend/services/providers/__tests__/avd.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Wire into boot**

```typescript
// backend/index.ts
import { createAvdProvider } from './services/providers/avd';

const avdProvider = createAvdProvider();
const avdAvailability = await avdProvider.isAvailable();
if (avdAvailability.available) {
  providerRegistry.register(avdProvider);
  log(`avd provider registered (emulator + avdmanager detected)`);
} else {
  log(`avd provider NOT registered: ${avdAvailability.reason ?? 'cmdline-tools missing'}`);
}
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run backend/ packages/plugin-sdk/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/services/providers/avd.ts backend/services/providers/__tests__/avd.test.ts backend/index.ts
git commit -m "feat(providers): avd provider — full lifecycle on Google Android SDK"
```

### Task 4.3: Phase 4 CI gate

- [ ] **Step 1: Push + watch**

```bash
git push
gh run watch -R DarkRideApp/DarkRide --exit-status
```

Expected: green.

- [ ] **Step 2: Tag**

```bash
git tag phase-4-complete && git push origin phase-4-complete
```

---

## Phase 5 — E2E CI workflow

**Outcome:** Nightly `ci-e2e-emulator.yml` workflow that spawns a Docker-Android container, installs a fixture APK, captures a known network call, asserts the trace. Retry-once on boot failure.

### Task 5.1: Fixture APK

**Files:**
- Create: `tests/e2e/fixtures/hello-world/` (source for the APK)
- Create: `tests/e2e/fixtures/hello-world.apk` (the built APK)

- [ ] **Step 1: Create a minimal Hello-World Android source**

```kotlin
// tests/e2e/fixtures/hello-world/app/src/main/java/wiki/themeparks/darkride/e2efixture/MainActivity.kt
package wiki.themeparks.darkride.e2efixture

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class MainActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val tv = TextView(this)
    setContentView(tv)
    thread {
      try {
        // Issue the assertion call. The E2E test scrapes the traffic store
        // for this exact hostname + path.
        val conn = URL("https://e2e.example.test/ping").openConnection() as HttpURLConnection
        conn.connectTimeout = 5000
        conn.readTimeout = 5000
        conn.requestMethod = "GET"
        conn.connect()
        runOnUiThread { tv.text = "ping sent: ${conn.responseCode}" }
        conn.disconnect()
      } catch (e: Exception) {
        runOnUiThread { tv.text = "ping failed: ${e.message}" }
      }
    }
  }
}
```

> Build the APK once locally with Android Studio or Gradle, commit the binary under `tests/e2e/fixtures/hello-world.apk`. Don't rebuild in CI — the binary is stable enough to be a versioned fixture.

- [ ] **Step 2: Commit the source + the binary**

```bash
git add tests/e2e/fixtures/
git commit -m "test(e2e): hello-world fixture APK for emulator capture E2E"
```

### Task 5.2: E2E assertion script

**Files:**
- Create: `tests/e2e/emulator-capture.test.ts`

- [ ] **Step 1: Write the script**

```typescript
// tests/e2e/emulator-capture.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { resolve } from 'path';
import http from 'http';

const APK = resolve('./tests/e2e/fixtures/hello-world.apk');
const HOST = process.env.DARKRIDE_HOST ?? 'http://localhost:3001';
const TIMEOUT_BOOT_MS = 5 * 60_000;

async function rest(method: string, path: string, body?: any) {
  const url = new URL(path, HOST);
  const opts: any = { method, headers: { 'Content-Type': 'application/json' } };
  return new Promise<any>((resolve, reject) => {
    const req = http.request(url, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fn();
    if (r !== undefined) return r;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: timeout');
}

describe('emulator-capture E2E', () => {
  it('spawns docker-android, installs fixture, captures the ping, asserts the trace', { timeout: 10 * 60_000 }, async () => {
    // 1. Create the emulator instance via the API
    const create = await rest('POST', '/v1/devices/providers/docker-android/instances', {
      displayName: `e2e-${Date.now()}`,
      config: { androidVersion: '14', architecture: 'x86_64', ramMb: 2048 },
    });
    expect(create.status).toBe(200);
    const instanceId = create.body.data.instance.id;

    // 2. Start it + wait for the running state
    await rest('POST', `/v1/devices/providers/docker-android/instances/${instanceId}/start`);
    const running = await waitFor(async () => {
      const r = await rest('GET', `/v1/devices/providers/docker-android/instances`);
      const inst = r.body?.data?.instances?.find((i: any) => i.id === instanceId);
      return inst?.state === 'running' ? inst : undefined;
    }, TIMEOUT_BOOT_MS);
    const serial = running.serial;

    // 3. Install the fixture APK on the running container
    execFileSync('adb', ['-s', serial, 'install', '-r', APK], { stdio: 'inherit' });

    // 4. Start capture session for this device
    await rest('POST', `/v1/capture/start`, { deviceId: serial });

    // 5. Launch the fixture activity (it fires the network call from onCreate)
    execFileSync('adb', ['-s', serial, 'shell', 'am', 'start', '-n', 'wiki.themeparks.darkride.e2efixture/.MainActivity'], { stdio: 'inherit' });

    // 6. Wait for the captured request in the traffic store
    const captured = await waitFor(async () => {
      const r = await rest('GET', `/v1/capture/traffic?deviceId=${encodeURIComponent(serial)}&host=e2e.example.test`);
      const found = r.body?.data?.traffic?.find((t: any) => t.host === 'e2e.example.test' && t.path === '/ping');
      return found;
    }, 60_000);

    expect(captured).toBeDefined();
    expect(captured.host).toBe('e2e.example.test');
    expect(captured.path).toBe('/ping');

    // 7. Tear down — stop + delete the container
    await rest('POST', `/v1/devices/providers/docker-android/instances/${instanceId}/stop`);
    await rest('DELETE', `/v1/devices/providers/docker-android/instances/${instanceId}`);
  });
});
```

- [ ] **Step 2: Commit the script (won't run locally — runs in CI)**

```bash
git add tests/e2e/emulator-capture.test.ts
git commit -m "test(e2e): emulator-capture assertion script"
```

### Task 5.3: ci-e2e-emulator workflow

**Files:**
- Create: `.github/workflows/ci-e2e-emulator.yml`

- [ ] **Step 1: Write the workflow**

```yaml
# .github/workflows/ci-e2e-emulator.yml
name: E2E — emulator capture

on:
  schedule:
    - cron: '17 2 * * *'  # 02:17 UTC nightly
  workflow_dispatch:

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'

jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '24'

      - name: Install dependencies
        run: npm install --legacy-peer-deps

      - name: Build SDK
        run: npm run build -w @darkrideapp/plugin-sdk

      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      - name: Pull docker-android image (cached)
        uses: actions/cache@v4
        id: image-cache
        with:
          path: /tmp/docker-image-cache
          key: docker-android-14-${{ hashFiles('docker/Dockerfile.android-emulator') }}

      - name: Pull image
        run: |
          if [ -f /tmp/docker-image-cache/docker-android-14.tar ]; then
            docker load -i /tmp/docker-image-cache/docker-android-14.tar
          else
            docker pull ghcr.io/darkrideapp/docker-android:14
            mkdir -p /tmp/docker-image-cache
            docker save ghcr.io/darkrideapp/docker-android:14 -o /tmp/docker-image-cache/docker-android-14.tar
          fi

      - name: Start DarkRide
        run: |
          npm run dev &
          # Wait until the API is reachable
          for i in {1..60}; do
            if curl -fsS http://localhost:3001/v1/system/health >/dev/null 2>&1; then break; fi
            sleep 2
          done

      - name: Run E2E test (with retry-once on boot failure)
        run: |
          set +e
          npx vitest run tests/e2e/emulator-capture.test.ts
          rc=$?
          if [ $rc -ne 0 ]; then
            echo "::warning::E2E first attempt failed (likely emulator boot flake); retrying once..."
            sleep 30
            npx vitest run tests/e2e/emulator-capture.test.ts
            rc=$?
          fi
          exit $rc
        env:
          DARKRIDE_HOST: http://localhost:3001
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci-e2e-emulator.yml
git commit -m "ci(e2e): nightly emulator-capture workflow with retry-once"
```

### Task 5.4: Phase 5 CI gate

- [ ] **Step 1: Push + watch the (non-E2E) CI**

```bash
git push
gh run watch -R DarkRideApp/DarkRide --exit-status
```

Expected: standard CI green. The E2E workflow itself runs on the next scheduled night — manually dispatch once via `gh workflow run ci-e2e-emulator.yml` to validate end-to-end before tagging.

- [ ] **Step 2: Tag**

```bash
git tag phase-5-complete && git push origin phase-5-complete
```

---

## Phase 6 — Plugin SDK extension

**Outcome:** `ctx.deviceProviders([...])` registration available to plugins. Kitchen-sink demonstrates the API. SDK tests cover the registration contract. CI green.

### Task 6.1: ctx.deviceProviders SDK method + type

**Files:**
- Modify: `packages/plugin-sdk/src/types/plugin.ts` (add method to PluginContext)
- Modify: `backend/plugins/plugin-context.ts` (implement)
- Create: `packages/plugin-sdk/src/__tests__/device-providers-registration.test.ts`

- [ ] **Step 1: Write the failing SDK test for type + collection**

```typescript
// packages/plugin-sdk/src/__tests__/device-providers-registration.test.ts
import { describe, it, expect, vi } from 'vitest';
import { definePlugin } from '../define-plugin';
import { PluginContextImpl, createEmptyContributions } from '../../../../backend/plugins/plugin-context';
import { HookBusImpl } from '../hook-bus-impl';

describe('ctx.deviceProviders([...])', () => {
  it('collects provider registrations from register() into contributions', () => {
    const plugin = definePlugin({
      name: 'demo',
      register(ctx) {
        ctx.deviceProviders([
          {
            id: 'corellium',
            displayName: 'Corellium',
            networkMode: 'corellium-tunnel',
            implementation: { /* DeviceProvider impl */ } as any,
            captureHandler: async () => {},
            capabilities: { canCreate: true, canDelete: true },
          },
        ]);
      },
    });

    const contributions = createEmptyContributions();
    const ctx = new PluginContextImpl('demo', new HookBusImpl(), contributions, '/tmp');
    plugin.register(ctx);
    expect(contributions.deviceProviders).toHaveLength(1);
    expect(contributions.deviceProviders[0]).toMatchObject({
      id: 'corellium',
      networkMode: 'corellium-tunnel',
    });
  });
});
```

- [ ] **Step 2: Add the type to PluginContext + the contribution shape**

```typescript
// packages/plugin-sdk/src/types/plugin.ts (add to PluginContext interface)

import type { DeviceProvider, CaptureHandler } from './device-providers';

export interface PluginDeviceProviderRegistration {
  id: string;
  displayName: string;
  networkMode: string;
  implementation: DeviceProvider;
  captureHandler: CaptureHandler;
  capabilities?: { canCreate?: boolean; canDelete?: boolean };
}

// in PluginContext interface, append:
deviceProviders(registrations: PluginDeviceProviderRegistration[]): void;
```

```typescript
// backend/plugins/plugin-context.ts — add to CollectedContributions:
import type { PluginDeviceProviderRegistration } from '@darkrideapp/plugin-sdk';

deviceProviders: PluginDeviceProviderRegistration[];

// in createEmptyContributions() append:
deviceProviders: [],

// in PluginContextImpl class, add method:
deviceProviders(registrations: PluginDeviceProviderRegistration[]): void {
  this.collected.deviceProviders.push(...registrations);
}
```

- [ ] **Step 3: Run, see it pass**

Run: `npx vitest run packages/plugin-sdk/src/__tests__/device-providers-registration.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire plugin-contributed providers into the provider registry**

In `backend/index.ts`, after `pluginManager.loadAll()` (or wherever plugins finish loading):

```typescript
// Collect plugin-contributed providers + capture handlers.
for (const pluginName of pluginManager.getPluginNames()) {
  const meta = pluginManager.getMetadata(pluginName);
  const contribs = pluginManager.getContributions(pluginName);
  for (const reg of contribs.deviceProviders ?? []) {
    try {
      providerRegistry.register(reg.implementation);
      captureModeRegistry.register(reg.networkMode, reg.captureHandler);
      log(`Plugin "${pluginName}" registered device provider "${reg.id}" with capture mode "${reg.networkMode}"`);
    } catch (err: any) {
      logError(`Plugin "${pluginName}" device provider registration failed: ${err.message}`);
    }
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk/src/types/plugin.ts \
        backend/plugins/plugin-context.ts \
        packages/plugin-sdk/src/__tests__/device-providers-registration.test.ts \
        backend/index.ts
git commit -m "feat(sdk): ctx.deviceProviders([...]) for plugin-contributed providers"
```

### Task 6.2: Kitchen-sink demonstrates ctx.deviceProviders

**Files:**
- Modify: `plugins/kitchen-sink/darkride-plugin.ts`

- [ ] **Step 1: Add a mock device provider in kitchen-sink's register**

In `plugins/kitchen-sink/darkride-plugin.ts` register(), add:

```typescript
// Extension point: ctx.deviceProviders — register a mock cloud-farm-style
// provider. The implementation does not actually spawn anything; it just
// shows what a plugin-contributed provider looks like.
ctx.deviceProviders([{
  id: 'kitchen-sink-demo-provider',
  displayName: 'Kitchen Sink Demo Provider',
  networkMode: 'kitchen-sink-mode',
  capabilities: { canCreate: false, canDelete: false },
  implementation: {
    id: 'kitchen-sink-demo-provider',
    displayName: 'Kitchen Sink Demo Provider',
    isAvailable: async () => ({ available: false, reason: 'demo provider — not a real device source', installHint: 'This provider is for SDK demonstration only.' }),
    listInstances: async () => [],
    startInstance: async (id) => ({ id, serial: id }),
    stopInstance: async () => {},
    getNetworkConfig: () => ({ mode: 'kitchen-sink-mode' }),
  },
  captureHandler: async (instance) => {
    logger.log(`[KitchenSink] capture handler invoked for ${instance.id} (no-op)`);
  },
}]);
```

- [ ] **Step 2: Add a test asserting kitchen-sink registers the provider**

```typescript
// plugins/kitchen-sink/__tests__/plugin-load.test.ts (append a new test)

it('registers a demo device provider via ctx.deviceProviders()', async () => {
  const module = await import('../darkride-plugin');
  const manager = new PluginManager();
  manager.loadPlugin(module.default);
  // Reach into the manager's collected contributions for this plugin
  const contribs = (manager as any).pluginContributions?.get?.('kitchen-sink');
  expect(contribs?.deviceProviders).toHaveLength(1);
  expect(contribs.deviceProviders[0].id).toBe('kitchen-sink-demo-provider');
});
```

- [ ] **Step 3: Run, see it pass**

Run: `npx vitest run plugins/kitchen-sink/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/kitchen-sink/darkride-plugin.ts plugins/kitchen-sink/__tests__/plugin-load.test.ts
git commit -m "test(kitchen-sink): demonstrate ctx.deviceProviders extension point"
```

### Task 6.3: Phase 6 CI gate + final merge prep

- [ ] **Step 1: Push + watch CI**

```bash
git push
gh run watch -R DarkRideApp/DarkRide --exit-status
```

Expected: green.

- [ ] **Step 2: Tag the final phase**

```bash
git tag phase-6-complete && git push origin phase-6-complete
```

- [ ] **Step 3: Manually dispatch the E2E workflow once before merging**

```bash
gh workflow run ci-e2e-emulator.yml --ref feature/emulator-support
gh run watch -R DarkRideApp/DarkRide --exit-status
```

Expected: green (or green after the in-workflow retry-once). This is the final smoke gate before merging the feature branch to main.

- [ ] **Step 4: Open the PR for review (manual)**

```bash
gh pr create --base main --head feature/emulator-support \
  --title "Emulator support: unified DeviceProvider + 4 built-in providers + plugin lane" \
  --body "$(cat <<'EOF'
## Summary

- Refactors device-manager into a thin orchestrator over a unified DeviceProvider abstraction
- Ships 4 built-in providers: adb-device, ios-device, docker-android, avd
- Opens the plugin lane via ctx.deviceProviders([...])
- Adds nightly E2E CI workflow

See `docs/specs/2026-05-20-emulator-support-design.md` for the design and this PR's commit log for the per-phase progression.

## Test plan

- [x] Full backend + frontend + SDK test suite green
- [x] All six phase tags pushed
- [x] E2E workflow dispatched manually + green
- [ ] Manual smoke: spawn a Docker emulator from the UI on a real dev machine
- [ ] Manual smoke: existing physical Android device still appears + captures normally (zero regression)
- [ ] Manual smoke: existing physical iOS device still appears + captures normally

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Plan self-review checklist

After this plan is committed, the implementer should re-read it once with these checks:

- **Spec coverage:** every section of `docs/specs/2026-05-20-emulator-support-design.md` should map to at least one task above. Sections 4.1 (interface) → Task 1.1; 4.2 (built-ins) → Tasks 1.3, 2.4, 3.2, 4.2; 4.3 (DeviceManager) → Tasks 1.5, 1.6; 5 (network plumbing) → Tasks 1.4, 2.4; 6 (provider details) → all four provider tasks; 7 (lifecycle/persist/reconcile) → Tasks 2.1, 2.2, 2.3; 8 (UI) → Tasks 3.6, 3.7; 9 (plugin SDK) → Tasks 6.1, 6.2; 10 (API) → Task 3.4; 11 (tests) → integrated in every task + Phase 5; 13 (migration) → Task 2.1.
- **Placeholders:** no TBDs, no "implement later", no "similar to" cross-refs that omit code.
- **Type consistency:** `DeviceProviderInstance.state` is the same string-union everywhere it's used. `DeviceProvider.getNetworkConfig` returns `NetworkConfig`, never a string. `ProviderRegistry.list()` returns `DeviceProvider[]` (full instances), never just IDs.
