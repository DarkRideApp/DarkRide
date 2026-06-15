# Emulator Support — Design

> **Status:** Approved 2026-05-20
> **Audience:** DarkRide maintainer + implementer
> **Triggered by:** Onboarding friction (DarkRide requires a real Android device + WiFi config to try) + missing automated E2E coverage of the capture pipeline. Emulators close both.

---

## 1. Goal

Add first-class support for emulators (AVD, Docker-Android) plus a unified bring-your-own-emulator (BYOE) discovery path, and refactor DarkRide's device layer so every device source — physical phones, emulators, containers, future cloud — fits a single `DeviceProvider` contract. The existing capture pipeline (mitmproxy + WireGuard + traffic store) reuses unchanged where it can; new transports plug into a per-mode dispatcher.

---

## 2. v1 scope

Three concurrent user stories ship together:

- **"Try DarkRide without a phone" in ~5 minutes** — user clicks `+ Add emulator`, picks Docker, picks Android version. Image pulls (~3GB once), container boots, WireGuard handshake, device appears in DarkRide, capture works.
- **"Automated E2E test in CI"** — scriptable: spawn container, install a known APK, run capture assertions, tear down. No accumulating orphans across runs.
- **"Manage AVDs from the UI"** — Android-dev user with an existing SDK install creates/starts/stops/deletes AVDs without leaving DarkRide. Existing AVDs (created in Android Studio) also show up via the same provider.

Existing physical-Android support is preserved exactly via the `adb-device` provider (an extraction of today's device-manager polling logic). Existing iOS support is preserved exactly via an `ios-device` provider that wraps `IosDeviceManager` and its Python `usbmuxd` bridge.

---

## 3. Non-goals (v1 won't do these)

- **iOS Simulator support** — Mac-only, requires `xcrun simctl`. Plugin lane, v2.
- **Auto-install of the Android SDK** — license-acceptance flow + multi-arch + ongoing maintenance is more than v1 budget. The AVD provider detects + points at install instructions.
- **Cross-provider migration** — moving an AVD's userdata into a Docker container, or vice versa. Each instance lives in its provider.
- **Multi-host orchestration** — DarkRide manages emulators on the same host it runs on. Distributed setups (DarkRide on a laptop, emulators on a build farm) are not in scope.
- **Per-vendor GPU passthrough UI toggle in the Docker provider** — silent auto-detection of common cases ships in v1 (see §6.3); the explicit UI control for per-vendor mode selection is v2.
- **Real-device USB-over-IP** — outside scope.
- **Snapshot / restore** of AVDs and Docker containers. v2.

---

## 4. Architecture overview

### 4.1 The `DeviceProvider` interface

A single contract every device source implements:

```typescript
interface DeviceProvider {
  id: string;                                            // 'adb-device' | 'avd' | 'docker-android' | 'ios-device' | <plugin>
  displayName: string;

  /**
   * Whether prerequisites for this provider are present. Surfaces in the
   * Create Emulator wizard — providers whose prereqs aren't met get a
   * disabled tab + installHint.
   */
  isAvailable(): Promise<{ available: boolean; reason?: string; installHint?: string }>;

  /**
   * Discover instances managed by this provider. Includes BYOE-discovered
   * instances (we didn't spawn but observed) and spawned-by-DarkRide ones.
   */
  listInstances(): Promise<DeviceProviderInstance[]>;

  /**
   * Create a new instance from a provider-specific spec. Optional — providers
   * that can only observe (e.g. adb-device, ios-device) don't implement.
   */
  createInstance?(spec: CreateInstanceSpec): Promise<DeviceProviderInstance>;

  /**
   * Start a previously-created instance. No-op for observe-only providers.
   */
  startInstance(id: string): Promise<RunningInstance>;

  /**
   * Stop a running instance. For DarkRide-spawned instances this kills the
   * underlying process / container / VM. For BYOE-discovered instances this
   * is a no-op at the provider level — DarkRide stops watching, but the
   * underlying process is owned by the user.
   */
  stopInstance(id: string): Promise<void>;

  /**
   * Delete an instance permanently. Optional. Refuses while the instance
   * is in the `running` state.
   */
  deleteInstance?(id: string): Promise<void>;

  /**
   * Declare how traffic from this instance reaches mitmproxy. Built-ins
   * mostly use 'wireguard'; ios-device uses 'ios-bridge'; plugin providers
   * can return any string the plugin registers a captureHandler for.
   */
  getNetworkConfig(id: string): NetworkConfig;

  /**
   * Optional JSON schema for the Create Emulator wizard's per-provider form.
   * Returned to the frontend so the wizard can render type-appropriate inputs
   * without provider-specific frontend code.
   */
  getCreateFormSchema?(): Promise<CreateFormSchema>;
}

type NetworkConfig = { mode: 'wireguard' } | { mode: 'ios-bridge' } | { mode: string; [key: string]: unknown };

interface DeviceProviderInstance {
  id: string;             // provider-scoped (AVD name, container ID, iOS UDID, adb serial)
  displayName: string;
  state: 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  serial?: string;        // adb serial when running, else absent
  spawnedByDarkride: boolean;
  metadata?: Record<string, unknown>;  // provider-specific; persisted as JSON
  lastError?: string;
}
```

### 4.2 The four built-in providers

| Provider | Role | NetworkMode | Lifecycle methods |
|---|---|---|---|
| `adb-device` | Observe ANY adb-reachable Android — physical phones, BYOE AVDs, Genymotion, BlueStacks, custom containers | `wireguard` | `listInstances` only (no spawn/kill) |
| `avd` | Google Android SDK lifecycle. Creates / starts / stops / deletes AVDs | `wireguard` | Full lifecycle |
| `docker-android` | Spawn emulator in a `budtmo/docker-android:emulator_<N>.0` container (pulled directly from Docker Hub) | `emu-http-proxy` | Full lifecycle |
| `ios-device` | Wraps existing `IosDeviceManager` + Python `usbmuxd` bridge. Physical iOS over USB only | `ios-bridge` | `listInstances` only (no spawn/kill) |

Why this split: every device source either *can* be spawned (AVD, Docker) or only observed (physical phones, iOS). The two non-spawning providers (`adb-device`, `ios-device`) keep `createInstance`/`deleteInstance` undefined; the wizard hides their tabs. The two spawning providers implement full lifecycle and appear as wizard options.

### 4.3 DeviceManager — the orchestrator

`DeviceManager` aggregates instances from all registered providers, owns the `device_instances` DB table, runs reconcile-on-boot, and routes capture via the per-mode handler registry.

```
┌────────────────────────────────────────────────────────────┐
│                      DeviceManager                          │
│  · Provider registry  · Instance aggregation                │
│  · Reconcile-on-boot  · CaptureHandler dispatch by mode     │
└────────────────────────────────────────────────────────────┘
                 │              │              │
        ┌────────┴───┐   ┌──────┴────┐   ┌─────┴────┐
        │ adb-device │   │   avd     │   │  docker  │  + ios-device + plugin lane
        └────────────┘   └───────────┘   └──────────┘
```

The current 1200-line `device-manager.ts` refactors into:
- `device-manager.ts` — orchestrator, ~300 lines after refactor
- `services/providers/adb-device.ts` — most of the current polling + setup + battery code moves here
- `services/providers/avd.ts` — new
- `services/providers/docker-android.ts` — new
- `services/providers/ios-device.ts` — wraps existing `IosDeviceManager`
- `services/providers/index.ts` — registry + provider loader

---

## 5. Network plumbing — WireGuard default, override hook for plugins

Every provider declares its `NetworkConfig` from `getNetworkConfig(id)`. DeviceManager's capture wiring looks at the `mode` field and dispatches to a registered `CaptureHandler`:

- `wireguard` — reuses the existing physical-Android pipeline byte-for-byte. Push wg-go binary, generate keypair, configure tunnel, install mitmproxy CA, start tunnel. Used by `adb-device` and `avd`.
- `emu-http-proxy` — used by `docker-android`. mitmproxy runs in HTTP forward-proxy mode on the host; an in-container TCP forwarder relays to the host bridge gateway, and the emulator is pointed at it via `adb reverse` / `settings put global http_proxy`. The budtmo image ships no wg-go and Docker's NAT makes an in-container WireGuard tunnel impractical, so this path replaces WireGuard for docker-android. See the implementation note at the end.
- `ios-bridge` — reuses the existing iOS pipeline. Today's `IosDeviceManager` capture path runs unchanged; the provider's `getNetworkConfig()` returns `{ mode: 'ios-bridge' }`, and DeviceManager dispatches to the existing iOS handler.
- *plugin-defined modes* — e.g. `corellium-tunnel` for a future Corellium provider. The plugin registers its `CaptureHandler` alongside the built-ins via `ctx.deviceProviders([...])`.

The `host-proxy` mode is **not** implemented in v1. It's a reserved name available to future plugin providers that need it (e.g. cloud farms where WireGuard isn't viable). v1 ships the `wireguard`, `emu-http-proxy`, and `ios-bridge` handlers.

---

## 6. Provider details

### 6.1 `adb-device`

- `isAvailable()` — checks `adb` on PATH. Always true if adb is present (which DarkRide already requires).
- `listInstances()` — runs `adb devices`, returns one instance per row. The provider-scoped `id` is the adb serial verbatim (e.g. `emulator-5554`, `R3CR70JX...`); the global `device_instances.serial` column matches.
- `startInstance`, `stopInstance` — no-ops (we didn't spawn; we don't kill).
- `getNetworkConfig()` — `{ mode: 'wireguard' }`.
- This provider is what makes BYOE work for free: an existing AVD or Genymotion already running shows up immediately, no plugin install required.

Extracted from the existing `device-manager.ts` polling loop. Most of the current device-manager code becomes "what `adb-device` does."

### 6.2 `avd`

- `isAvailable()` — checks both `emulator` and `avdmanager` on PATH; if missing, returns `installHint: "Install Android Studio or Android command-line tools — see <link>"`.
- `listInstances()` — `avdmanager list avd` parsed. Includes AVDs the user created in Android Studio (free BYOE-of-AVDs).
- `createInstance(spec)` — `avdmanager create avd -n <name> -k <system-image-package>`. UI form collects Android version, API level, RAM, device profile.
- `startInstance(id)` — spawns `emulator -avd <id> -no-window -port <free-port>` as a child process tracked by DarkRide. Once up, the new emulator appears in `adb devices` and `adb-device` picks it up.
- `stopInstance(id)` — `adb -s emulator-<port> emu kill` (graceful) + child-process reaper as fallback.
- `deleteInstance(id)` — `avdmanager delete avd -n <name>`. Refuses if running.

**Dedup with adb-device:** a running AVD shows up in both provider listings. DeviceManager dedupes by serial number; the `avd`-provider entry wins for UI presentation (richer metadata + lifecycle controls), while `adb-device`'s entry is the authoritative source for capture-pipeline state.

### 6.3 `docker-android`

- `isAvailable()` — connects to Docker socket (`/var/run/docker.sock` or `DOCKER_HOST`); failure returns `installHint`.
- `listInstances()` — `docker ps --filter label=darkride.emulator=true`. Only our containers.
- `createInstance(spec)` — `docker pull` if the requested image is absent (progress streamed to UI); creates a stopped container with a free adb port mapped; persists container ID + port to `device_instances`.
- `startInstance(id)` — `docker start <id>`. Wait for adbd inside the container to bind. `adb connect localhost:<port>`. Device flows through `adb-device`.
- `stopInstance(id)` — `docker stop` with timeout, falls back to `docker kill`.
- `deleteInstance(id)` — `docker rm`. Container labels carry enough metadata to reconcile after a DarkRide restart.
- `getNetworkConfig()` — `{ mode: 'emu-http-proxy' }`.

**Image strategy:** the provider pulls `budtmo/docker-android:emulator_<N>.0` directly from Docker Hub — no custom image. (The original plan baked wg-go + Frida into a `ghcr.io/darkrideapp/docker-android:<ver>` image; that was dropped. With `emu-http-proxy` capture there's no in-container WireGuard to pre-bake for, and Frida is pushed at runtime when needed, so a custom image bought nothing over tracking budtmo as a moving upstream.) See the implementation note at the end.

The **mitmproxy CA cert is NOT baked into the image** — it's regenerated per DarkRide install. The runtime CA install path (push via `adb push` + remount `/system` rw + drop into `/system/etc/security/cacerts/`) is the same as today's physical-device flow. The Docker image just needs to be a `userdebug` build with `/system` writable after `adb root` + remount, which budtmo already provides.

**GPU passthrough (auto-detect, no UI knob):** at `startInstance` time the provider inspects the host:
- On Linux, if `/dev/dri` exists, pass `--device /dev/dri:/dev/dri` to `docker run` (Intel/AMD GPU access for the emulator).
- If the NVIDIA Container Toolkit is installed (detected by probing `docker info` for the `nvidia` runtime), pass `--gpus all` (NVIDIA GPU access).
- On macOS / Windows, GPU-to-container passthrough is not practical; the provider falls back to software rendering and surfaces a one-line "GPU passthrough not available on this host — using software rendering" note in the wizard.

Per-vendor explicit toggles (force-software, force-host-GPU, vendor-specific overrides) are deferred to v2. The auto-detect default covers the common Linux dev-machine and CI-runner cases for free.

### 6.4 `ios-device`

- `isAvailable()` — checks `usbmuxd` reachable + `python/ios_bridge.py` present.
- `listInstances()` — proxies to `IosDeviceManager.getDevices()`. Includes paired iOS devices over USB.
- `startInstance`, `stopInstance` — no-ops at the provider level. The `markBusy`/`markIdle` hooks on the capture-session boundary continue to work as today.
- `createInstance`, `deleteInstance` — not implemented.
- `getNetworkConfig()` — `{ mode: 'ios-bridge' }`. DeviceManager dispatches `ios-bridge` to the existing iOS capture path.

`IosDeviceManager` is not deleted or rewritten — it becomes the implementation detail of `ios-device`. Existing iOS tests and capture flows stay green.

---

## 7. Lifecycle, persistence, reconcile

### 7.1 Lifecycle states

```
created → starting → running ↔ stopping → stopped → (deleted)
                       │
                       └→ error
```

- `created` — record exists in DB, underlying resource not yet allocated (or allocated but not started). Docker containers in this state exist on the daemon but are `docker stop`'d; AVDs exist on disk but the emulator process isn't running.
- `starting` — `startInstance()` called; we're waiting for adbd to bind or process to be ready.
- `running` — capture pipeline can flow.
- `stopping` — `stopInstance()` called; waiting for clean shutdown.
- `stopped` — resource exists but isn't active.
- `error` — last lifecycle action failed; `last_error` carries a structured reason.

### 7.2 Persistence

New `device_instances` table — one row per managed instance across all providers:

```typescript
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
}, t => ({ pk: primaryKey({ columns: [t.instanceId, t.key] }) }));
```

Existing `devices` table gains a nullable `instance_id` foreign-key to `device_instances`.

The split between `devices` and `device_instances` is deliberate. `devices` is "telemetry + setup state of a thing currently online with capture configured." `device_instances` is "thing we've registered to manage, whether or not it's online right now." A Docker container in `created` state has a `device_instances` row but no `devices` row; it boots, adbd binds, polling sees the new serial, a `devices` row is inserted and linked back via `instance_id`.

### 7.3 Reconcile on boot

For each registered provider, call `listInstances()` and diff against `device_instances` rows. Three cases:

- **In DB, not in provider** — instance disappeared externally (container removed, AVD deleted). Mark row `stopped` and surface in UI; user can clean up.
- **In provider, not in DB** — BYOE auto-discovery. Insert row with `spawned_by_darkride=false`.
- **State mismatch** — update DB to match reality.

Reconcile is parallelised per-provider with a 5-second time-bound on each call, so a single unresponsive provider can't slow boot.

### 7.4 Teardown

- DarkRide-spawned: `stopInstance()` actually kills. On DarkRide shutdown, all DarkRide-spawned `running` instances get `stopInstance()` called.
- BYOE-discovered: `stopInstance()` is a no-op at the provider level. DarkRide stops watching, but the user manages their own AVD/container lifecycle.

---

## 8. UI

### 8.1 Devices page (existing, extended)

- `+ Add emulator` button top-right of the Devices page.
- Type badge on each row: `physical` / `avd` / `docker` / `ios` / `<plugin-id>`.
- Provider-aware action menu — Start / Stop / Delete shown only when the underlying provider supports them. Physical and BYOE adb-device rows have no Stop button (didn't spawn → don't kill). AVD-provider rows show a richer menu including Edit Config.
- State chip — `Running` / `Booting...` / `Stopped` / `Error: <reason>`. Error surfaces `device_instances.last_error`.

### 8.2 Create Emulator wizard

Single modal with tabs (one per provider that supports `createInstance`). Each tab:

- Shows the provider's `isAvailable()` result. If unavailable, the tab body shows a structured "what's missing + how to install" hint. The form is hidden.
- Renders a provider-specific config form. The form schema comes from `provider.getCreateFormSchema()`.
- "Create & start" creates the row in `device_instances`, calls `provider.createInstance(spec)` then `provider.startInstance(id)`. Progress events stream over WebSocket — the modal renders a phase indicator (pull → boot → tunnel up → ready).

`ios-device` and `adb-device` do not appear as wizard tabs (no `createInstance`). They surface only as discovered devices on the Devices page.

---

## 9. Plugin SDK extension

New `ctx` surface method, called from `register()`:

```typescript
ctx.deviceProviders([{
  id: 'corellium-cloud',
  displayName: 'Corellium Cloud',
  capabilities: { canCreate: true, canDelete: true },
  networkMode: 'corellium-tunnel',
  implementation: CorelliumProvider,
  captureHandler: corelliumCaptureHandler,
}]);
```

New type exports from `@darkrideapp/plugin-sdk`:

- `DeviceProvider` — the contract interface
- `DeviceProviderInstance` — the per-instance shape
- `NetworkConfig`, `NetworkMode` (extensible string literal union)
- `CreateInstanceSpec`, `RunningInstance`, `CreateFormSchema`
- `CaptureHandler` — function signature for handling a per-mode capture wiring

`captureHandler` is the seam letting a plugin-defined `networkMode` participate in the capture pipeline. Built-in `wireguard` and `ios-bridge` handlers ship in core; plugin handlers register alongside.

---

## 10. REST + WebSocket API surface

New endpoints under `/v1/devices/providers/`:

```
GET    /v1/devices/providers                                       — list providers + isAvailable + capabilities
GET    /v1/devices/providers/:id/create-form                       — JSON schema for the create form
GET    /v1/devices/providers/:id/instances                         — list instances managed by this provider
POST   /v1/devices/providers/:id/instances                         — create new instance (provider-specific body)
POST   /v1/devices/providers/:id/instances/:instId/start
POST   /v1/devices/providers/:id/instances/:instId/stop
DELETE /v1/devices/providers/:id/instances/:instId
```

Existing `GET /v1/devices` is extended to include `providerId` + `instanceId` per row when the device is one we manage. Existing capture endpoints stay unchanged — they branch on `networkMode` via the dispatcher registered by the provider.

New WebSocket message types:

- `provider-instance-updated` — broadcast on every `device_instances` state transition. Body: full instance row. UI uses this to drive the Devices page chips without polling.
- Existing `device-updated` continues to fire for capture-pipeline-relevant changes.

---

## 11. Testing strategy

### 11.1 Unit tests per provider

`backend/services/providers/<provider>.test.ts` for each. Mock `child_process`, Docker SDK, Python-bridge spawn. Cover every `DeviceProvider` method plus failure paths (Docker daemon down, AVD SDK missing, usbmuxd unreachable). Pattern matches existing `plugin-installer.test.ts` for child-process mocking.

### 11.2 DeviceManager integration tests

Aggregation across multiple mock providers, reconcile-on-boot diffing for all three cases, serial-based dedup between providers, capture-mode dispatch routing.

### 11.3 E2E in CI (the headline test)

New CI workflow `ci-e2e-emulator.yml`, scheduled nightly + manual via `workflow_dispatch`. Not on every PR (Docker pulls + emulator boot is too slow to gate every commit).

Steps:
- Pull `ghcr.io/darkrideapp/docker-android:14` (cached across runs via GitHub Actions cache).
- Spawn a container via the `docker-android` provider's public API.
- Install a known fixture APK — a small "Hello World" with a single `https://e2e.example/ping` call, committed to the repo.
- Start a capture session.
- Trigger the app's network call.
- Assert the captured request appears in the traffic store with the expected hostname.
- Tear down the container.

Target wall time: under 8 minutes on a `ubuntu-latest` runner with KVM nested virt. Acceptable to be slow — runs nightly.

**Known flake rate.** Community reports ~5–10% spurious failure rate for Android emulator runs on hosted GitHub runners (boot timeout, adbd race, kernel quirks). v1 mitigates by **retry-once on boot failure** inside the workflow; only the second consecutive failure marks the run red. The nightly cadence makes this acceptable. If the rate degrades materially, the escape hatch is documented in §14 (deferred) — swap the runner label to a self-hosted runner; same workflow file.

### 11.4 Plugin SDK tests

`packages/plugin-sdk/__tests__/device-providers.test.ts` — registration shape, type exports, capture-handler dispatch contract.

### 11.5 Frontend tests

Devices page renders per-provider type badges + provider-aware action menus. Create Emulator wizard handles unavailable-tab rendering + provider-specific form schema. WebSocket-driven state transitions update chips without polling.

---

## 12. Open risks (validate during implementation)

- **WireGuard userspace tunnel through Qemu user-mode networking** — AVDs use a synthetic NAT'd network stack; wg-go is UDP-over-anything and should pass but is empirical. **Mitigation:** prototype in week 1 of implementation; if blocked, fall back to per-provider `host-proxy` mode for the affected provider.
- **Docker container nesting with WG inside** — three network layers stacked. Likely works; debug pain if it doesn't. Same week-1 prototype validates both this and the previous risk.
- **First-pull UX for the docker-android image** — 3GB is a real download. **Mitigation:** pre-pull check + UI progress + cancel button. Ship a smaller "lite" Android version (AOSP 11) as default for the "5-min onboarding" path.
- **Reconcile-on-boot startup time** — user with 20 stopped instances + Docker daemon paused could slow boot if calls are sequential. **Mitigation:** parallelise per-provider, time-bound each call, surface partial results.
- **Hosted-runner emulator flake on GitHub Actions** — community-reported ~5–10% spurious failure rate for Android emulators on `ubuntu-latest`. **Mitigation:** retry-once inside the workflow + nightly schedule absorbs occasional reruns. **Escape hatch:** self-hosted GitHub runner with the same workflow file (see §14).
- **License acceptance for AVD SDK install hint** — Google's SDK license is interactive in some tooling. Our install hint just points at Android Studio / cmdline-tools; the user accepts via their installer of choice. No license-text in DarkRide.

---

## 13. Migration

Zero destructive changes to existing data:

1. Drizzle migration `0092_device_instances.sql`:
   - Creates `device_instances` and `device_instance_config` tables.
   - Adds nullable `instance_id` column to `devices`.
2. First boot under the new code: DeviceManager runs reconcile. Every device adb already sees gets a `device_instances` row with `provider_id='adb-device'`, `spawned_by_darkride=false`. Existing iOS devices get rows under `provider_id='ios-device'`. The `devices.instance_id` is backfilled at the same time.
3. No data loss; no rollback risk. The migration is purely additive plus the backfill.

The existing `device-manager.ts` (1200 lines) refactors into the orchestrator (~300 lines) plus the four provider files listed in §4.3. The capture pipeline (mitmproxy-manager, capture-session-manager, traffic-hook-registry) stays untouched — only DeviceManager's call sites switch from platform conditionals to `provider.getNetworkConfig().mode` dispatching.

---

## 14. Deferred to v2

| Item | Rough cost | Notes |
|---|---|---|
| iOS Simulator provider | ~3 days | Plugin lane, requires Mac contributor. `xcrun simctl`-driven. |
| Cloud-farm providers (Corellium, BrowserStack, AWS Device Farm) | ~5 days each | Plugin lane. Open architecture — we don't gate on these. |
| Snapshot / restore for AVDs + Docker containers | ~1 week | High value for test reproducibility. |
| Per-vendor GPU passthrough UI toggle | ~2 days | Linux auto-detect ships in v1 (§6.3); v2 adds an explicit knob for force-software / force-host-GPU / vendor overrides. |
| Self-hosted GitHub runner for E2E | ~0.5 day | If hosted-runner flake (§12) becomes intolerable. Same workflow file, just swap the `runs-on` label. |
| Provider-defined capture modes beyond `wireguard` + `ios-bridge` | already supported | Architecture allows it (plugin `captureHandler`); we just don't ship one in v1. |

---

## 15. Phased delivery (rough sketch — formal plan via writing-plans)

Implementation will be sequenced so CI gates each major stage:

1. **Phase 1 — Provider abstraction + adb-device extraction.** Define the interface, refactor existing `device-manager.ts` into the new shape, all existing tests stay green. CI on the branch is green at end of phase.
2. **Phase 2 — ios-device wrap.** Wrap `IosDeviceManager`; iOS tests stay green. Adds reconcile-on-boot logic with `device_instances` table migration.
3. **Phase 3 — docker-android provider + image.** Build + publish `ghcr.io/darkrideapp/docker-android:<version>`. Docker daemon detection. Wizard tab. The "5-min onboarding" story is live.
4. **Phase 4 — avd provider.** Detection, listing, create/start/stop/delete. The "manage AVDs from UI" story is live.
5. **Phase 5 — E2E CI workflow.** Nightly job that validates the docker-android happy path end-to-end. The "automated E2E test in CI" story is live.
6. **Phase 6 — Plugin SDK extension.** `ctx.deviceProviders([...])` + type exports + tests. Architecture promise (plugin lane) is verifiable from outside core.

Each phase ends with: full test suite green, CI green on the branch, manual smoke test of the new provider's happy path. Branch stays unmerged through all six phases.

---

## Implementation note (2026-06-15)

Two things shipped differently from the original plan above. Recording them here so the doc matches reality.

- **docker-android capture uses `emu-http-proxy`, not WireGuard.** mitmproxy runs in HTTP forward-proxy mode on the host, an in-container TCP forwarder relays traffic to the host bridge gateway, and the emulator is pointed at it via `adb reverse` / `settings put global http_proxy`. Why: the `budtmo/docker-android` image ships no wg-go binary, and Docker's NAT makes an in-container WireGuard tunnel impractical. WireGuard was **not** dropped — `adb-device` (physical Android) and `avd` still use it; iOS still uses `ios-bridge`.
- **No custom Docker image.** The implementation pulls `budtmo/docker-android:emulator_<N>.0` directly from Docker Hub. The planned `ghcr.io/darkrideapp/docker-android:<ver>` image (with pre-baked wg-go / Frida) was dropped: with `emu-http-proxy` there's no in-container WireGuard to bake in, so a custom image bought nothing over tracking budtmo directly.

Capture is dispatched through `CaptureModeRegistry`, which `CaptureSessionManager.resolveCaptureMode` selects per device from its provider's `getNetworkConfig(serial).mode`. Registered handlers: `wireguard`, `emu-http-proxy`, `ios-bridge` (see `backend/services/capture-handlers.ts`).
