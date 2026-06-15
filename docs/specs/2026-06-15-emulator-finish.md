# Emulator Support — Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the working-but-unfinished emulator-support branch to a mergeable, secure, internally-consistent state: remove the dead VNC stack (closing an auth bypass), make the capture-mode dispatch architecture real instead of a no-op shim, collapse the duplicate device-poll path, fix the review's HIGH/MEDIUM findings, and reconcile the docs.

**Architecture:** The branch already ships a unified `DeviceProvider` contract, a `device_instances` table, and WebRTC/gRPC video. This plan finishes the two half-built pillars from the original design — per-mode **capture dispatch** (`CaptureModeRegistry`) and **provider-driven device polling** — without changing any externally-observable capture behavior. WireGuard remains the capture path for physical Android (`adb-device`) and AVD; `emu-http-proxy` stays the path for `docker-android`; `ios-bridge` for iOS. The work is a refactor to first-class dispatch plus targeted bug fixes, not a behavior change.

**Tech Stack:** TypeScript/Node, Express, `ws` WebSockets, Drizzle ORM + better-sqlite3, Vitest (forks pool), React 19 frontend, `@darkrideapp/plugin-sdk` workspace package.

---

## Ground rules (every task obeys these)

- **TDD, no exceptions.** Write the failing test first, run it, confirm it fails for the right reason, then implement. The regression test and the fix land in the **same commit**.
- **Run the gate before each commit:** `npm run typecheck && npx vitest run <touched test files>`; before the final task run the full `npx vitest run` (baseline: 3902 passed, 58 skipped, 0 failed).
- **Behavior parity is the bar for Phases 2-3.** Physical-device WireGuard capture and physical-device discovery must behave byte-for-byte as before. Tests assert the existing flows still fire in the same order.
- **WS broadcast mocks** match the real shape `{ type: 'restapi', id, status, body }` where a test stands in for a websocket message.
- **Drizzle migrations** (none expected in this plan, but if one is added): multi-statement files need `--> statement-breakpoint` between statements, and the new journal entry's `when` must exceed the **max** of every prior entry.
- **Prose:** no em dashes, no "delve/robust/comprehensive/crucial" filler in code comments or docs.
- **Do NOT push or tag.** The final task stops at a clean, green working tree. The user pushes and opens the PR.

## File Structure (what each task creates or changes)

**Phase 1 — VNC deletion**
- Delete: `backend/websocket/vnc-proxy.ts`, `backend/websocket/__tests__/vnc-proxy.test.ts`, `frontend/lib/video/VncViewer.tsx`, `frontend/lib/video/__tests__/VncViewer.test.tsx`, `docs/HANDOFF-2026-05-30-emulator-vnc.md`
- Edit: `backend/index.ts`, `backend/websocket/index.ts`, `backend/services/providers/docker-android.ts`, `backend/api/video-transport.ts`, `frontend/pages/DeviceView.tsx`, `packages/plugin-sdk/src/types/device-providers.ts`, `package.json`
- Update tests: `backend/services/providers/docker-android.test.ts`, `backend/api/video-transport.test.ts`

**Phase 2 — Real capture dispatch**
- Edit (contract): `backend/services/capture-mode-registry.ts` (host-shaped handler type + context)
- Create: `backend/services/capture-handlers.ts` (the three extracted handlers) + `backend/services/capture-handlers.test.ts`
- Edit: `backend/services/capture-session-manager.ts` (call `dispatch`), `backend/index.ts` (register the three real handlers)

**Phase 3 — Provider-driven polling**
- Edit: `backend/services/device-manager.ts` (`start()` drives `pollDevicesFromProviders`), `backend/index.ts` (comment cleanup)
- Test: `backend/services/device-manager.test.ts`

**Phase 4 — Review fixes**
- Edit + test: `backend/api/video-transport.ts` + `.test.ts` (H3), `backend/services/device-instances-repo.ts` (+ ORDER BY, `updateMetadata`), `backend/index.ts` (M1 shutdown), `backend/services/providers/docker-android.ts` + `.test.ts` (M3), `backend/api/emulator-grpc-bridge.test.ts` (M4), `backend/api/devices-providers.ts` (L1)

**Phase 5 — Docs + capture test**
- Edit: `docs/specs/2026-05-20-emulator-support-design.md`
- Create: `backend/services/capture-session-manager.emu.test.ts` (fast mocked-Docker emu-http-proxy proof)

**Phase 6 — Release prep**
- Edit: `package.json` (version bump)

---

## Task 1: Delete the VNC backend bridge and its wiring

**Files:**
- Delete: `backend/websocket/vnc-proxy.ts`, `backend/websocket/__tests__/vnc-proxy.test.ts`
- Modify: `backend/websocket/index.ts`, `backend/index.ts`

This removes the CRITICAL finding: the `/ws/vnc` bridge authenticated nothing (unlike `/ws`, which validates `darkride_sid` at `backend/websocket/index.ts:141-167`).

- [ ] **Step 1: Confirm the current test baseline is green for the files you will touch**

Run: `npx vitest run backend/websocket`
Expected: PASS (includes `vnc-proxy.test.ts` for now).

- [ ] **Step 2: Delete the VNC bridge module and its test**

```bash
git rm backend/websocket/vnc-proxy.ts backend/websocket/__tests__/vnc-proxy.test.ts
```

- [ ] **Step 3: Remove the `setupVncProxy` machinery from `backend/websocket/index.ts`**

Remove the import of `createVncBridge`/`defaultConnectTcp` (around line 13), and the entire `VncProxyDeps` interface + `setupVncProxy` function + the unauthenticated `vncWss.on('connection')` handler (around lines 287-342). Leave the shared upgrade router (`registerRoute`, lines 133-139) intact — it is generic and used by `/ws` only after this change.

Verify nothing else in the file references `vnc`:
Run: `grep -ni vnc backend/websocket/index.ts`
Expected: no matches.

- [ ] **Step 4: Remove the VNC wiring from `backend/index.ts`**

Remove the `setupVncProxy` import (around line 6), the `vncWss = setupVncProxy(...)` call (around line 910), and the `vncWss` teardown block inside `shutdown()` (around lines 1513-1518). 

Run: `grep -ni "vnc" backend/index.ts`
Expected: no matches.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no references to the deleted symbols).

- [ ] **Step 6: Run the backend websocket + server tests**

Run: `npx vitest run backend/websocket backend/index`
Expected: PASS. (If a test imported `setupVncProxy`, it was deleted in Step 2.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix(emulator): remove unauthenticated /ws/vnc bridge (closes auth bypass)"
```

---

## Task 2: Delete the VNC frontend viewer and the docker-android VNC endpoint

**Files:**
- Delete: `frontend/lib/video/VncViewer.tsx`, `frontend/lib/video/__tests__/VncViewer.test.tsx`
- Modify: `frontend/pages/DeviceView.tsx`, `backend/services/providers/docker-android.ts`, `backend/services/providers/docker-android.test.ts`

- [ ] **Step 1: Delete the viewer and its test**

```bash
git rm frontend/lib/video/VncViewer.tsx frontend/lib/video/__tests__/VncViewer.test.tsx
```

- [ ] **Step 2: Remove VNC from `frontend/pages/DeviceView.tsx`**

Remove the `VncViewer` import (around line 9), the `'vnc'` member of the transport union and the `vncWsPath` field (around lines 58-59), and the `transport === 'vnc'` render branch (around lines 594-598). The `'webrtc'` and `'scrcpy'` branches stay.

Run: `grep -ni vnc frontend/pages/DeviceView.tsx`
Expected: no matches.

- [ ] **Step 3: Update the docker-android provider test FIRST (TDD: tests describe the new contract)**

In `backend/services/providers/docker-android.test.ts`, delete the `getVncEndpoint` test cases and the assertion that port `5900` is exposed/bound. Keep the `8554` (gRPC) loopback assertions.

Run: `npx vitest run backend/services/providers/docker-android.test.ts`
Expected: FAIL — the provider still binds 5900 / still has `getVncEndpoint`, so removed-behavior assertions that remain elsewhere are gone but the file should now compile and pass *only after* Step 4. (If the test still references the deleted symbols, fix the test file first; it must compile.)

- [ ] **Step 4: Remove the VNC surface from `backend/services/providers/docker-android.ts`**

Remove `getVncEndpoint` (around lines 541-552), the `5900` `ExposedPort` and `PortBindings` entries (around lines 403 and 411), and the "dormant fallback" comment block (around lines 267-268). Leave `videoTransport: 'webrtc'` and `getGrpcEndpoint` exactly as they are.

- [ ] **Step 5: Run the provider test**

Run: `npx vitest run backend/services/providers/docker-android.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck (frontend + backend)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix(emulator): drop VncViewer + docker-android VNC endpoint (WebRTC is the path)"
```

---

## Task 3: Remove the `vnc` transport from the resolver and the SDK contract; drop the dep and handoff doc

**Files:**
- Modify: `backend/api/video-transport.ts`, `backend/api/video-transport.test.ts`, `packages/plugin-sdk/src/types/device-providers.ts`, `package.json`
- Delete: `docs/HANDOFF-2026-05-30-emulator-vnc.md`

- [ ] **Step 1: Update `backend/api/video-transport.test.ts` FIRST**

Delete the test case that expects `{ transport: 'vnc', wsPath: ... }`. Keep the `webrtc`, `scrcpy`, and the running-vs-stale `webrtc` cases.

- [ ] **Step 2: Remove the `vnc` branch from the resolver**

In `backend/api/video-transport.ts`:
- Remove the `{ transport: 'vnc'; wsPath: string }` member of `VideoTransportResult` (line 7).
- Narrow `pickVideoInstance`'s `transport` param to `'webrtc'` and `cap` to `'getGrpcEndpoint'` (drop the `'vnc'`/`'getVncEndpoint'` unions, lines 23-24).
- Delete the `if (pickVideoInstance(... 'vnc' ...))` block (lines 53-54).

The resolver now returns `webrtc` or `scrcpy` only.

- [ ] **Step 3: Remove the `vnc` transport + `getVncEndpoint` from the SDK contract**

In `packages/plugin-sdk/src/types/device-providers.ts`:
- In the `videoTransport?` union (line 158) remove `'vnc'`, leaving `'webrtc' | 'scrcpy'`.
- Delete the `getVncEndpoint?` method and its doc block (lines 160-165).
- Update the `videoTransport` doc comment (lines 149-157) to drop the `'vnc'` bullet.

- [ ] **Step 4: Rebuild the SDK (tests resolve against the built package)**

Run: `npm run build -w @darkrideapp/plugin-sdk`
Expected: build OK.

- [ ] **Step 5: Drop the `@novnc/novnc` dependency and the stale handoff doc**

```bash
npm uninstall @novnc/novnc
git rm docs/HANDOFF-2026-05-30-emulator-vnc.md
```

Confirm no source still imports it:
Run: `grep -rn "@novnc/novnc" backend frontend packages --include=*.ts --include=*.tsx`
Expected: no matches.

- [ ] **Step 6: Typecheck + the two touched test files + a VNC-wide grep**

Run: `npm run typecheck && npx vitest run backend/api/video-transport.test.ts`
Expected: PASS.
Run: `grep -rni "getvncendpoint\|/ws/vnc\|VncViewer\|vnc-proxy" backend frontend packages --include=*.ts --include=*.tsx`
Expected: no matches (the VNC stack is fully gone).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix(emulator): remove vnc transport from resolver + SDK contract, drop @novnc/novnc"
```

---

## Task 4: Define the host-shaped capture-handler contract

**Files:**
- Modify: `backend/services/capture-mode-registry.ts`
- Test: `backend/services/capture-mode-registry.test.ts` (create if absent)

**Why a host-shaped contract:** the SDK `CaptureHandler` is `(instance, config) => Promise<void>` (device-providers.ts:111) — it cannot carry `sessionId`, `mitmOptions`, subsystem-status broadcasting, or the `emuHttpProxy` return that real capture needs (see `capture-session-manager.ts:148-279`). No plugin contributes a capture handler today (the four modes are core), so per YAGNI the registry becomes a **host** concern with a richer handler. The thin SDK `DeviceProviderContribution.captureHandler` stays as a forward-declaration; wiring a plugin-supplied handler is explicitly deferred (documented in Step 3).

- [ ] **Step 1: Write the failing test for the new registry shape**

Create/extend `backend/services/capture-mode-registry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createCaptureModeRegistry, type CaptureModeContext } from './capture-mode-registry';

function ctx(over: Partial<CaptureModeContext> = {}): CaptureModeContext {
  return {
    deviceId: 'localhost:32770',
    sessionId: 1,
    platform: 'android',
    mode: 'wireguard',
    mitmOptions: {},
    setSubsystem: vi.fn(),
    ...over,
  } as CaptureModeContext;
}

describe('CaptureModeRegistry', () => {
  it('dispatches to the handler registered for the context mode and returns its result', async () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', async () => ({ tunnelActivated: true }));
    const result = await reg.dispatch(ctx({ mode: 'wireguard' }));
    expect(result).toEqual({ tunnelActivated: true });
  });

  it('throws when no handler is registered for the mode', async () => {
    const reg = createCaptureModeRegistry();
    await expect(reg.dispatch(ctx({ mode: 'nope' }))).rejects.toThrow(/no capture handler/i);
  });

  it('refuses duplicate registration of the same mode', () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', async () => ({ tunnelActivated: false }));
    expect(() => reg.register('wireguard', async () => ({ tunnelActivated: false }))).toThrow(/already registered/i);
  });
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx vitest run backend/services/capture-mode-registry.test.ts`
Expected: FAIL (the current `dispatch(instance, config)` signature and SDK import don't match; `CaptureModeContext` is not exported).

- [ ] **Step 3: Rewrite `backend/services/capture-mode-registry.ts` with the host contract**

```ts
import type { CaptureSubsystemStatus } from './capture-session-manager';

/** Subsystem keys the handler reports progress against. */
export type SubsystemKey = keyof CaptureSubsystemStatus;
export type SubsystemState = 'pending' | 'ok' | 'skipped' | 'warning' | 'error';

/**
 * Everything a capture-mode handler needs to wire one device's capture.
 * Built host-side per startCapture call. Handlers must not assume a
 * provider instance exists — physical devices arrive via the bare ADB
 * tracker with no managed instance (`instance` is then null).
 */
export interface CaptureModeContext {
  /** adb serial, e.g. "localhost:32770" or a physical device serial. */
  deviceId: string;
  sessionId: number;
  platform: 'android' | 'ios';
  /** NetworkConfig.mode resolved for this device. */
  mode: string;
  /** Options already assembled for mitmproxy (proxy mode, intercept hooks, tlsProfile). */
  mitmOptions: Record<string, unknown>;
  /** Broadcast a subsystem status transition (wraps CaptureSessionManager.broadcastStatus). */
  setSubsystem: (key: SubsystemKey, status: SubsystemState) => void;
}

export interface CaptureModeResult {
  /** True when a WireGuard tunnel was activated (drives teardown). */
  tunnelActivated: boolean;
  /** Set by emu-http-proxy so the API response can report the proxy host/port. */
  emuHttpProxy?: { host: string; port: number };
}

export type CaptureHandler = (ctx: CaptureModeContext) => Promise<CaptureModeResult>;

export interface CaptureModeRegistry {
  register(mode: string, handler: CaptureHandler): void;
  has(mode: string): boolean;
  dispatch(ctx: CaptureModeContext): Promise<CaptureModeResult>;
}

export function createCaptureModeRegistry(): CaptureModeRegistry {
  const handlers = new Map<string, CaptureHandler>();
  return {
    register(mode, handler) {
      if (handlers.has(mode)) throw new Error(`Capture mode "${mode}" is already registered`);
      handlers.set(mode, handler);
    },
    has(mode) {
      return handlers.has(mode);
    },
    async dispatch(ctx) {
      const handler = handlers.get(ctx.mode);
      if (!handler) throw new Error(`No capture handler registered for mode "${ctx.mode}"`);
      return handler(ctx);
    },
  };
}
```

NOTE: `CaptureSubsystemStatus` is already declared in `capture-session-manager.ts`; if it is not exported, export it there in this step (`export interface CaptureSubsystemStatus`). Do not import the SDK `CaptureHandler`/`NetworkConfig` here anymore.

- [ ] **Step 4: Run the test**

Run: `npx vitest run backend/services/capture-mode-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (the old SDK-typed callers in index.ts will now fail — that is expected and fixed in Task 6)**

Run: `npm run typecheck 2>&1 | grep -E "capture-mode|index.ts" | head`
Expected: errors only at the `index.ts` no-op registration (signature mismatch). That is wired correctly in Task 6. Do not "fix" it by reverting the contract.

- [ ] **Step 6: Commit**

```bash
git add backend/services/capture-mode-registry.ts backend/services/capture-mode-registry.test.ts backend/services/capture-session-manager.ts
git commit -m "refactor(capture): host-shaped CaptureModeRegistry contract (context in, result out)"
```

---

## Task 5: Extract the three capture-mode handlers

**Files:**
- Create: `backend/services/capture-handlers.ts`, `backend/services/capture-handlers.test.ts`
- Reference (do not yet change): `backend/services/capture-session-manager.ts:148-264` (the inline branches being extracted)

The three handlers are pure functions over the context plus the host services they need. To keep them testable and avoid a god-context, pass the services explicitly via a small factory.

- [ ] **Step 1: Write the failing test**

Create `backend/services/capture-handlers.test.ts`. Mock the two managers; assert each handler drives the same calls the inline code does today.

```ts
import { describe, it, expect, vi } from 'vitest';
import { makeCaptureHandlers } from './capture-handlers';

function deps() {
  return {
    mitmproxyManager: {
      startCapture: vi.fn().mockResolvedValue({ /* tunnelInfo */ wgConfig: 'x' }),
      startHttpProxyCapture: vi.fn().mockResolvedValue({ port: 8081 }),
      isCapturing: vi.fn().mockReturnValue(true),
    },
    deviceManager: {
      injectMitmproxyCaCert: vi.fn().mockResolvedValue(undefined),
      activateWireGuardTunnel: vi.fn().mockResolvedValue(undefined),
      setupEmulatorHttpProxy: vi.fn().mockResolvedValue(undefined),
    },
    spawnContainerHttpForwarder: vi.fn().mockResolvedValue(undefined),
    getActiveDockerClient: vi.fn().mockReturnValue({}),
    lookupRuntimeId: vi.fn().mockReturnValue('container123'),
    waitForTunnelReady: vi.fn().mockResolvedValue(true),
  };
}

const ctx = (over = {}) => ({
  deviceId: 'localhost:32770', sessionId: 1, platform: 'android' as const,
  mode: 'wireguard', mitmOptions: {}, setSubsystem: vi.fn(), ...over,
});

describe('capture handlers', () => {
  it('wireguard: starts capture, injects CA, activates tunnel, returns tunnelActivated', async () => {
    const d = deps();
    const h = makeCaptureHandlers(d as any);
    const r = await h.wireguard(ctx());
    expect(d.mitmproxyManager.startCapture).toHaveBeenCalled();
    expect(d.deviceManager.injectMitmproxyCaCert).toHaveBeenCalledWith('localhost:32770');
    expect(d.deviceManager.activateWireGuardTunnel).toHaveBeenCalled();
    expect(r.tunnelActivated).toBe(true);
  });

  it('emu-http-proxy: starts http proxy, spawns forwarder, returns emuHttpProxy host 10.0.2.2', async () => {
    const d = deps();
    const h = makeCaptureHandlers(d as any);
    const r = await h['emu-http-proxy'](ctx({ mode: 'emu-http-proxy' }));
    expect(d.mitmproxyManager.startHttpProxyCapture).toHaveBeenCalled();
    expect(d.spawnContainerHttpForwarder).toHaveBeenCalled();
    expect(d.deviceManager.setupEmulatorHttpProxy).toHaveBeenCalledWith('localhost:32770', '10.0.2.2', 8081);
    expect(r).toEqual({ tunnelActivated: false, emuHttpProxy: { host: '10.0.2.2', port: 8081 } });
  });

  it('emu-http-proxy: throws when no docker client/runtimeId', async () => {
    const d = deps(); d.getActiveDockerClient = vi.fn().mockReturnValue(null);
    const h = makeCaptureHandlers(d as any);
    await expect(h['emu-http-proxy'](ctx({ mode: 'emu-http-proxy' }))).rejects.toThrow(/no container handle/i);
  });

  it('ios-bridge: starts capture, skips on-device setup, tunnelActivated false', async () => {
    const d = deps();
    const h = makeCaptureHandlers(d as any);
    const r = await h['ios-bridge'](ctx({ platform: 'ios', mode: 'ios-bridge' }));
    expect(d.mitmproxyManager.startCapture).toHaveBeenCalled();
    expect(d.deviceManager.activateWireGuardTunnel).not.toHaveBeenCalled();
    expect(r.tunnelActivated).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx vitest run backend/services/capture-handlers.test.ts`
Expected: FAIL (`makeCaptureHandlers` does not exist).

- [ ] **Step 3: Implement `backend/services/capture-handlers.ts`**

Move the bodies of the three inline branches from `capture-session-manager.ts:162-264` verbatim into named handlers, threading state through `ctx.setSubsystem` instead of the inline `subsystems[...] = ...; this.broadcastStatus(...)` pairs, and returning `{ tunnelActivated, emuHttpProxy? }`. The `wireguard` handler must preserve the `tunnelInfo == null` "already running" sub-branch (subsystems → skipped) exactly. Pull `gateway`, `lookupRuntimeId`, `spawnContainerHttpForwarder`, `getActiveDockerClient`, `waitForTunnelReady` through the `deps` object so the file has no `this`.

The factory signature:

```ts
export interface CaptureHandlerDeps {
  mitmproxyManager: { startCapture: Function; startHttpProxyCapture: Function; isCapturing: (id: string) => boolean };
  deviceManager: { injectMitmproxyCaCert: Function; activateWireGuardTunnel: Function; setupEmulatorHttpProxy: Function };
  spawnContainerHttpForwarder: Function;
  getActiveDockerClient: () => unknown;
  lookupRuntimeId: (deviceId: string) => string | undefined;
  waitForTunnelReady: (deviceId: string) => Promise<boolean>;
}
export function makeCaptureHandlers(deps: CaptureHandlerDeps): Record<'wireguard' | 'emu-http-proxy' | 'ios-bridge', CaptureHandler> { ... }
```

(Use precise types from the real managers rather than `Function` in the implementation; `Function` here is shorthand for the plan.)

- [ ] **Step 4: Run the test**

Run: `npx vitest run backend/services/capture-handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: the handlers file is clean; `capture-session-manager.ts` still has the inline branches (removed in Task 6) so it also still typechecks.

- [ ] **Step 6: Commit**

```bash
git add backend/services/capture-handlers.ts backend/services/capture-handlers.test.ts
git commit -m "refactor(capture): extract wireguard/emu-http-proxy/ios-bridge handlers"
```

---

## Task 6: Route `startCapture` through `dispatch` and register the real handlers

**Files:**
- Modify: `backend/services/capture-session-manager.ts`, `backend/index.ts`
- Test: `backend/services/capture-session-manager.test.ts` (existing — must stay green)

This is the behavior-parity task. The inline `if (isDockerAndroid) … else if (android) … else …` block (lines 162-264) is replaced by: resolve `mode`, build the `CaptureModeContext`, call `this.captureModeRegistry.dispatch(ctx)`, apply the result.

- [ ] **Step 1: Confirm the existing capture-session-manager tests pass (your parity baseline)**

Run: `npx vitest run backend/services/capture-session-manager.test.ts`
Expected: PASS. Note the count; it must not drop.

- [ ] **Step 2: Add `setCaptureModeRegistry` use + mode resolution in `capture-session-manager.ts`**

Resolve the mode for a device:

```ts
private resolveCaptureMode(deviceId: string, platform: 'android' | 'ios'): string {
  const providerId = this.getProviderIdForDevice(deviceId);
  if (providerId) {
    const provider = this.providerRegistry?.get(providerId);
    if (provider) return provider.getNetworkConfig(deviceId).mode;
  }
  return platform === 'ios' ? 'ios-bridge' : 'wireguard';
}
```

(If `CaptureSessionManager` has no `providerRegistry` handle, add a `setProviderRegistry` setter mirroring `device-manager.ts`, wired in `index.ts`.)

- [ ] **Step 3: Replace the inline branch (lines 162-264) with a dispatch call**

```ts
const mode = this.resolveCaptureMode(deviceId, platform);
const result = await this.captureModeRegistry!.dispatch({
  deviceId,
  sessionId,
  platform,
  mode,
  mitmOptions,
  setSubsystem: (key, status) => {
    subsystems[key] = status;
    this.broadcastStatus(deviceId, 'capturing', sessionId, undefined, subsystems);
  },
});
tunnelActivated = result.tunnelActivated;
const emuHttpProxy = result.emuHttpProxy;
```

Keep everything before (session row creation, busy guard, mitmOptions assembly) and after (activeSessions.set, capture-rules kickoff, return value, the catch/cleanup) unchanged.

- [ ] **Step 4: Run the capture-session-manager tests — confirm parity**

Run: `npx vitest run backend/services/capture-session-manager.test.ts`
Expected: PASS, same count as Step 1. If a test stubbed `mitmproxyManager.startCapture` directly, it still passes because the wireguard handler calls the same method. If any test fails, the extraction changed an order or argument — fix the handler to match, not the test.

- [ ] **Step 5: Register the three real handlers in `backend/index.ts`**

Replace the no-op block (lines 280-285) with real registration, building the handler deps from the already-constructed `mitmproxyManager`, `deviceManager`, and the imported `spawnContainerHttpForwarder`/`getActiveDockerClient`:

```ts
const captureHandlers = makeCaptureHandlers({
  mitmproxyManager,
  deviceManager,
  spawnContainerHttpForwarder,
  getActiveDockerClient,
  lookupRuntimeId: (serial) => db.select({ runtimeId: deviceInstances.runtimeId })
    .from(deviceInstances).where(eq(deviceInstances.serial, serial)).all()[0]?.runtimeId,
  waitForTunnelReady: (serial) => captureSessionManager.waitForTunnelReady(serial),
});
captureModeRegistry.register('wireguard', captureHandlers.wireguard);
captureModeRegistry.register('emu-http-proxy', captureHandlers['emu-http-proxy']);
captureModeRegistry.register('ios-bridge', captureHandlers['ios-bridge']);
```

(`captureModeRegistry` must be constructed before `captureSessionManager` and passed in via the existing `setCaptureModeRegistry`. `waitForTunnelReady` may need to be made `public` on `CaptureSessionManager` or moved into the handler deps differently; pick the smaller change and keep it internal.)

- [ ] **Step 6: Typecheck + full server-area tests**

Run: `npm run typecheck && npx vitest run backend/services backend/index backend/api/capture.test.ts`
Expected: PASS. The Task 4 `index.ts` signature error is now resolved.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(capture): dispatch capture through CaptureModeRegistry (wireguard/emu-http-proxy/ios-bridge)"
```

---

## Task 7: Make provider-driven polling the live path

**Files:**
- Modify: `backend/services/device-manager.ts`, `backend/index.ts`
- Test: `backend/services/device-manager.test.ts`

Today `start()` (device-manager.ts:390-394) runs `pollAdbDevices` on a 5s interval; `pollDevicesFromProviders` (line 514) is test-only. The provider path must drive discovery while preserving identical physical-device behavior (the `adb-device` provider wraps the same adb parsing).

- [ ] **Step 1: Read `pollDevicesFromProviders` and confirm it reconciles the same `devices` rows as `pollAdbDevices`**

Confirm (by reading device-manager.ts:514+ and `adb-device.ts`) that iterating provider instances yields the same serials/online state the legacy path produced. If there is a gap (e.g. `pollAdbDevices` also updates `device_properties` or standby state that the provider path omits), the swap must preserve it — note the gap and carry that logic into the provider path.

- [ ] **Step 2: Write the failing test**

In `backend/services/device-manager.test.ts`, add a test that `start()` populates devices from the registered provider, not the legacy adb call:

```ts
it('start() discovers devices through the provider registry', async () => {
  const dm = DeviceManager.getInstance(db);
  const fakeProvider = makeFakeAdbProvider([{ serial: 'emulator-5554', state: 'running' }]);
  const reg = createProviderRegistry(); reg.register(fakeProvider);
  dm.setProviderRegistry(reg);
  await dm.pollDevicesFromProviders();
  expect(db.select().from(devices).all().map(d => d.id)).toContain('emulator-5554');
});
```

(Match the helper/fixtures already used in this test file; the point is the provider path writes the `devices` row.)

- [ ] **Step 3: Run it — confirm current behavior**

Run: `npx vitest run backend/services/device-manager.test.ts`
Expected: the new test may already pass for `pollDevicesFromProviders` directly; the real change is `start()` calling it. Add an assertion that `start()` schedules `pollDevicesFromProviders` (spy on it) and fails until Step 4.

- [ ] **Step 4: Swap the interval in `start()`**

Change device-manager.ts:392-393 to call `pollDevicesFromProviders` when a provider registry is wired, falling back to `pollAdbDevices` only if none is set (defensive — in production one is always set in index.ts):

```ts
start(): void {
  const poll = () => this.providerRegistry ? this.pollDevicesFromProviders() : this.pollAdbDevices();
  poll();
  this.pollTimer = setInterval(poll, ADB_POLL_INTERVAL);
  this.standbyTimer = setInterval(() => this.checkStandby(), 10000);
}
```

Keep `pollAdbDevices` as the fallback implementation (do not delete it — the `adb-device` provider delegates to the same parsing, and the fallback covers a misconfigured boot). Update the `index.ts:271-274` comment to state Phase 2 is done.

- [ ] **Step 5: Run device-manager + a broad backend pass**

Run: `npx vitest run backend/services/device-manager.test.ts backend/services/providers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(devices): drive discovery through pollDevicesFromProviders"
```

---

## Task 8: Fix video-instance resolution on running-vs-running serial collision (H3)

**Files:**
- Modify: `backend/services/device-instances-repo.ts`, `backend/api/video-transport.ts`
- Test: `backend/api/video-transport.test.ts`

`pickVideoInstance` sorts only running-first; when two video-capable instances share a serial and are both `running`, the comparator returns 0 and `listBySerial` (no ORDER BY) yields rowid-ascending = the oldest/stale row.

- [ ] **Step 1: Write the failing test**

In `backend/api/video-transport.test.ts`:

```ts
it('prefers the most-recently-updated instance when two running rows share a serial', () => {
  // two webrtc-capable docker-android rows, both running, same serial;
  // the newer (higher lastStateAt) one must win
  const repo = makeRepoWith([
    { id: 1, providerId: 'docker-android', serial: 'localhost:32770', state: 'running', lastStateAt: new Date('2026-06-15T09:00:00Z') },
    { id: 2, providerId: 'docker-android', serial: 'localhost:32770', state: 'running', lastStateAt: new Date('2026-06-15T09:05:00Z') },
  ]);
  const got = resolveGrpcInstance('localhost:32770', repo, registryWithWebrtcDockerAndroid());
  expect(got?.id).toBe(2);
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx vitest run backend/api/video-transport.test.ts`
Expected: FAIL (returns id 1, the lower rowid).

- [ ] **Step 3: Add a recency ORDER BY to `listBySerial`**

In `device-instances-repo.ts:109-112`:

```ts
listBySerial(serial: string): DeviceInstanceRow[] {
  return this.db.select().from(deviceInstances)
    .where(eq(deviceInstances.serial, serial))
    .orderBy(desc(deviceInstances.lastStateAt))
    .all() as DeviceInstanceRow[];
}
```

Import `desc` from `drizzle-orm`. Keep `pickVideoInstance`'s running-first sort (it is now a stable sort over recency-ordered input, so running+newest wins).

- [ ] **Step 4: Clear the stale serial on stop (prevents the collision at the source)**

Where an instance transitions to stopped/error after a container stop (provider `stopInstance` path in `backend/api/devices-providers.ts` stop handler, around line 242), call `repo.updateSerial(instId, null)` so a recycled host port can't resurface a stale row under the new emulator's serial. Add a one-line test asserting the serial is nulled on stop if the stop handler has test coverage; otherwise assert via the repo.

- [ ] **Step 5: Run the test**

Run: `npx vitest run backend/api/video-transport.test.ts backend/services/device-instances-repo.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix(video): deterministic recency tiebreak + clear stale serial on stop (H3)"
```

---

## Task 9: Stop darkride-spawned emulators on shutdown (M1)

**Files:**
- Modify: `backend/index.ts`
- Test: `backend/index.test.ts` if present, else a focused unit around the teardown helper

**Decision:** darkride-spawned containers (`spawnedByDarkride === true`) are **stopped** on graceful shutdown. They hold ~2-4 GB RAM and a KVM slot each; leaving them running orphans the in-container forwarder and adb-reverse with no cleanup. BYOE/observed instances are left untouched. (Reconcile-on-boot already re-adopts anything still running, so this is safe for fast restarts of BYOE devices.)

- [ ] **Step 1: Write the failing test for the teardown helper**

Extract the teardown into a testable function `stopSpawnedInstances(registry, repo)` and test it:

```ts
it('stops only darkride-spawned running instances', async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const registry = { get: () => ({ stopInstance: stop }) } as any;
  const repo = { listAll: () => [
    { id: 1, providerId: 'docker-android', runtimeId: 'c1', state: 'running', spawnedByDarkride: true },
    { id: 2, providerId: 'adb-device', runtimeId: '', state: 'running', spawnedByDarkride: false },
  ] } as any;
  await stopSpawnedInstances(registry, repo);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledWith('c1');
});
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx vitest run backend/services/stop-spawned-instances.test.ts`
Expected: FAIL (helper does not exist).

- [ ] **Step 3: Implement the helper and call it from `shutdown()`**

Create `backend/services/stop-spawned-instances.ts` with `stopSpawnedInstances(registry, repo)` that iterates `repo.listAll()`, filters `spawnedByDarkride && state==='running'`, and `await`s `registry.get(providerId)?.stopInstance(runtimeId)` each, catching and logging per-instance errors (one failure must not block the rest). Call it inside `shutdown()` (backend/index.ts:~1505) before the HTTP server closes, with a short overall timeout so shutdown never hangs.

- [ ] **Step 4: Run the test + typecheck**

Run: `npm run typecheck && npx vitest run backend/services/stop-spawned-instances.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(emulator): stop darkride-spawned instances on shutdown (M1)"
```

---

## Task 10: Bind adb 5555 to loopback (M3) + repo.updateMetadata (L1)

**Files:**
- Modify: `backend/services/providers/docker-android.ts`, `backend/services/providers/docker-android.test.ts`, `backend/services/device-instances-repo.ts`, `backend/api/devices-providers.ts`

- [ ] **Step 1: Write the failing test for loopback 5555**

In `docker-android.test.ts`, extend the port-binding assertions to require `HostIp: '127.0.0.1'` on `5555/tcp` (mirroring the existing 8554 assertion):

```ts
expect(hostConfig.PortBindings['5555/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '0' }]);
```

- [ ] **Step 2: Run it — confirm it fails**

Run: `npx vitest run backend/services/providers/docker-android.test.ts`
Expected: FAIL (current binding has no `HostIp`, so adb is on 0.0.0.0).

- [ ] **Step 3: Add `HostIp: '127.0.0.1'` to the 5555 binding** (docker-android.ts:~406)

- [ ] **Step 4: Write the failing test for `updateMetadata`**

In `device-instances-repo.test.ts`:

```ts
it('updateMetadata replaces spawnMetadata and bumps lastStateAt', () => {
  const row = repo.insert({ providerId: 'docker-android', runtimeId: 'c1', state: 'pulling', spawnedByDarkride: true });
  repo.updateMetadata(row.id, { image: 'budtmo/docker-android:emulator_14.0', ramMb: 2048 });
  expect(repo.getById(row.id)!.spawnMetadata).toMatchObject({ image: expect.any(String), ramMb: 2048 });
});
```

- [ ] **Step 5: Implement `updateMetadata` and use it**

Add to `device-instances-repo.ts`:

```ts
updateMetadata(id: number, metadata: Record<string, unknown>): void {
  this.db.update(deviceInstances)
    .set({ spawnMetadata: metadata, lastStateAt: new Date() })
    .where(eq(deviceInstances.id, id))
    .run();
}
```

Replace the `(repo as any).db.update(...)` block in `devices-providers.ts:148-151` with `repo.updateMetadata(row.id, inst.metadata)`.

- [ ] **Step 6: Run the tests + typecheck**

Run: `npm run typecheck && npx vitest run backend/services/providers/docker-android.test.ts backend/services/device-instances-repo.test.ts backend/api/devices-providers.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix(emulator): bind adb 5555 to loopback (M3) + repo.updateMetadata helper (L1)"
```

---

## Task 11: Auth/scope gate + cancellation tests for the grpc-web bridge (M4)

**Files:**
- Modify: `backend/api/emulator-grpc-bridge.test.ts`

The bridge declares `requires: ['core.devices:read']` (emulator-grpc-bridge.ts:~228) but the test mounts the router without the auth middleware, so the gate is unverified; the `res.close` upstream-cancel path is also untested.

- [ ] **Step 1: Add a test that mounts the real auth middleware and asserts 401/403 without scope**

Build the app the way the suite's authed API tests do (find an existing example that wires `authMiddleware` + a session/api-key), then:

```ts
it('rejects grpc-web without core.devices:read', async () => {
  const res = await request(appWithAuth).post('/v1/devices/localhost%3A32770/grpc').send(Buffer.from([0]));
  expect([401, 403]).toContain(res.status);
});
```

- [ ] **Step 2: Add a test that destroying the client response cancels the upstream gRPC call**

```ts
it('cancels the upstream gRPC call when the client disconnects', async () => {
  const cancel = vi.fn();
  // inject a fake upstream whose .cancel is `cancel`; simulate res 'close'
  // then assert cancel was called (mirror the bridge's res.on('close') wiring)
  ...
  expect(cancel).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run backend/api/emulator-grpc-bridge.test.ts`
Expected: PASS (these assert existing behavior; if Step 1 fails, the bridge is genuinely missing the gate — add the `requires` to the route, which would be a real fix, and note it).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(emulator): cover grpc-web auth gate + client-disconnect cancellation (M4)"
```

---

## Task 12: Reconcile the design doc + add a fast emu-http-proxy capture test (Phase 5)

**Files:**
- Modify: `docs/specs/2026-05-20-emulator-support-design.md`
- Create: `backend/services/capture-session-manager.emu.test.ts`

- [ ] **Step 1: Reconcile the design doc with shipped reality**

Edit the doc where it claims docker-android capture uses WireGuard: state that docker-android uses `emu-http-proxy` (mitmproxy forward-proxy + in-container TCP forwarder + `adb reverse`), and that physical Android (`adb-device`) and AVD keep WireGuard. Where §6.3 promises a custom `ghcr.io/darkrideapp/docker-android` image with pre-baked wg-go/Frida, note that the shipped implementation pulls `budtmo/docker-android:emulator_<N>.0` directly and the custom image was dropped. Do not rewrite the whole doc; correct the two claims and add a short "Implementation note (2026-06-15)" paragraph.

- [ ] **Step 2: Write a fast mocked-Docker test proving the emu-http-proxy capture wiring**

Create `backend/services/capture-session-manager.emu.test.ts` that constructs a `CaptureSessionManager` with mocked managers + a `deviceInstances` row for a `docker-android` serial, stubs `getActiveDockerClient`/`spawnContainerHttpForwarder`, calls `startCapture('localhost:32770')`, and asserts the result is `{ sessionId, httpProxy: { host: '10.0.2.2', port } }` and that `setupEmulatorHttpProxy` was called. This gives the emu-http-proxy path gate-lane coverage (today only the nightly Docker e2e exercises it).

- [ ] **Step 3: Run it**

Run: `npx vitest run backend/services/capture-session-manager.emu.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs+test(emulator): reconcile design doc; gate-lane emu-http-proxy capture test"
```

---

## Task 13: Release prep + full verify

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the version**

Bump `package.json` `version` (minor bump from the current value, since this completes a feature).

- [ ] **Step 2: Full typecheck**

Run: `npm run typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 3: Full suite, clean box**

Run: `npx vitest run`
Expected: 0 failed. Pass count >= 3902 (new tests add to it); 58 skipped is fine. The `tests/e2e/**` Docker e2e stays excluded.

- [ ] **Step 4: Final VNC-gone + dead-code grep**

Run: `grep -rni "vnc\|setupVncProxy\|getVncEndpoint\|@novnc" backend frontend packages --include=*.ts --include=*.tsx`
Expected: no matches.
Run: `grep -rn "Phase 1: no-op\|Phase 2 swaps" backend/index.ts`
Expected: no matches (comments updated).

- [ ] **Step 5: Confirm clean tree + commit the bump**

```bash
git status   # should show only package.json staged after the bump
git add package.json
git commit -m "chore(emulator): finish emulator support — version bump"
```

- [ ] **Step 6: STOP. Do not push or tag.** Report the final state (commits, test counts, what changed) and hand back to the user for push + PR.

---

## Self-Review (run before handing to execution)

**Spec coverage:**
- CRITICAL `/ws/vnc` auth bypass → Tasks 1-3 (delete the stack). ✓
- H1 dead CaptureModeRegistry → Tasks 4-6 (host contract, extract handlers, dispatch). ✓
- H2 double poll path → Task 7. ✓
- H3 video resolution → Task 8. ✓
- M1 shutdown teardown → Task 9. ✓
- M3 adb 5555 loopback → Task 10. ✓
- M4 grpc auth/cancel tests → Task 11. ✓
- L1 `(repo as any).db` cast → Task 10. ✓
- Docs reconcile + capture gate test → Task 12. ✓
- WireGuard preserved for physical + AVD → Tasks 5-6 keep the `wireguard` handler behavior identical; Task 6 Step 4 asserts parity. ✓
- M2 (WebRTC RTCPeerConnection leak) is intentionally NOT in this plan — it requires forking/wrapping a third-party class and is bounded per-navigation; tracked as follow-up, not a merge blocker. Called out here so it is a deliberate omission, not a gap.

**Type consistency:** `CaptureModeContext`/`CaptureModeResult`/`CaptureHandler` (host) are defined in Task 4 and consumed identically in Tasks 5-6. `makeCaptureHandlers` signature in Task 5 matches its call site in Task 6. `updateMetadata`/`listBySerial` signatures in Tasks 8/10 match their repo definitions.

**Placeholder scan:** handler bodies in Task 5 say "move verbatim from lines 162-264" with the exact source range rather than re-pasting 100 lines; that is a precise instruction, not a TODO. Test code is concrete. No "add error handling" hand-waves.
