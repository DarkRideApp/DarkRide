import { eq } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { deviceInstances } from '../db/schema';
import type { ProviderRegistry } from '../services/providers';
import type { DeviceInstancesRepo } from '../services/device-instances-repo';
import type { AppDatabase } from '../db/index';
import { broadcastToAll } from '../websocket/index';
import { forgetDeviceRow } from '../services/forget-device';
import { adbCommand } from '../services/device-manager';
import { createLoggers } from '../logs';

const { log: dpLog } = createLoggers('devices-providers-api');

/** Injectable side-effects, overridden in tests to avoid touching real adb. */
export interface DevicesProvidersDeps {
  /** Drop an `adb connect <host:port>` entry. Defaults to real `adb disconnect`. */
  adbDisconnect?: (serial: string) => Promise<void>;
}

/**
 * Register the `/v1/devices/providers/*` REST endpoints. See spec §10.
 * The endpoints delegate to the provider registry + device-instances repo.
 * Authentication: `core.devices:manage` scope (consistent with other
 * device endpoints).
 */
export function registerDevicesProvidersEndpoints(
  registry: ProviderRegistry,
  repo: DeviceInstancesRepo,
  db?: AppDatabase,
  deps: DevicesProvidersDeps = {},
): void {
  const adbDisconnect = deps.adbDisconnect ?? (async (serial: string) => {
    await adbCommand(['disconnect', serial]);
  });

  /**
   * Drop a stale `adb connect <host:port>` entry for a managed emulator that
   * is being stopped, deleted, or recreated. docker-android emulators are
   * reached over TCP (serial = `localhost:<hostPort>`); when the container
   * goes away the adb server keeps the endpoint in its device list (shown as
   * "offline"), and the device poller then re-inserts an orphaned `devices`
   * row with no backing instance — whose detail page falls back to scrcpy
   * because `resolveVideoTransport` can't map the serial to a provider. This
   * keeps adb's view in sync with the container lifecycle. Non-fatal on
   * failure; no-op for non-network serials (USB / iOS UDIDs have no `:port`).
   */
  async function dropAdbEndpoint(serial: string | null | undefined): Promise<void> {
    if (!serial || !/:\d+$/.test(serial)) return;
    try {
      await adbDisconnect(serial);
      dpLog(`adb disconnect ${serial} (instance lifecycle)`);
    } catch (e: any) {
      dpLog(`adb disconnect ${serial} failed (non-fatal): ${e?.message ?? e}`);
    }
  }
  // GET /v1/devices/providers — list providers + availability + capabilities
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
    const { displayName, config, autoStart } = req.body as { displayName?: string; config?: Record<string, unknown>; autoStart?: boolean };
    if (!displayName || typeof displayName !== 'string') {
      res.status(400).json({ success: false, error: 'displayName is required' });
      return;
    }
    // Insert the row immediately so the API can respond in milliseconds.
    // For docker-android, the underlying createInstance may need to pull
    // a multi-GB image first; we don't want to keep the HTTP request open
    // for the duration of that. The row starts in 'pulling' state (with
    // an empty runtimeId until the container materialises), the response
    // returns instantly, and the rest runs in background — broadcasting
    // progress + final state via WebSocket.
    const row = repo.insert({
      providerId: p.id ?? req.params.id,
      runtimeId: '',
      displayName,
      serial: null,
      state: 'pulling',
      spawnedByDarkride: true,
      spawnMetadata: (config ?? {}) as Record<string, unknown>,
    });
    broadcastToAll({ type: 'provider-instance-updated', instance: row });
    res.json({ success: true, data: { instance: row } });

    // Fire-and-forget the actual creation.
    (async () => {
      try {
        const inst = await p.createInstance!(
          { displayName, config: config ?? {} },
          {
            onPullProgress: (progress) => {
              broadcastToAll({
                type: 'provider-instance-updated',
                instance: repo.getById(row.id),
                pullProgress: progress,
              });
            },
          },
        );
        repo.updateRuntimeId(row.id, inst.id);
        // Preserve the provider's richer metadata (image, arch, ramMb, …)
        // which the wizard config alone doesn't carry.
        if (inst.metadata) {
          // No setMetadata helper today — go direct.
          (repo as any).db.update(deviceInstances)
            .set({ spawnMetadata: inst.metadata, lastStateAt: new Date() })
            .where(eq(deviceInstances.id, row.id))
            .run();
        }
        repo.updateState(row.id, inst.state);
        broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });

        // The modal sets autoStart=true so users get one continuous
        // pulling → starting → running flow without having to click
        // Start manually after the pull completes. We do it here on the
        // server so the frontend doesn't have to race the broadcast.
        if (autoStart && p.startInstance) {
          repo.updateState(row.id, 'starting');
          broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
          try {
            const r = await p.startInstance(inst.id);
            repo.updateSerial(row.id, r.serial ?? null);
            repo.updateState(row.id, 'running');
          } catch (startErr: any) {
            repo.updateState(row.id, 'error', startErr?.message ?? String(startErr));
          }
          broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
        }
      } catch (err: any) {
        repo.updateState(row.id, 'error', err?.message ?? String(err));
        broadcastToAll({ type: 'provider-instance-updated', instance: repo.getById(row.id) });
      }
    })();
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

      // If the underlying container is in an unrecoverable post-exit
      // state (the common case for docker-android: budtmo's image
      // strips /etc/passwd's root entry on first boot, so `docker
      // start` of an exited container fails with "unable to find
      // user root"), recreate it from the saved spec rather than
      // surfacing the alarming raw Docker error.
      let runtimeId = row.runtimeId;
      if ((row.state === 'error' || row.state === 'stopped') && p.createInstance && p.deleteInstance) {
        const meta = row.spawnMetadata ?? {};
        // The old container is being replaced by a fresh one that may bind a
        // different random host port. Tear down the old adb endpoint + its
        // adb-seeded devices row first, so the new container doesn't compete
        // with an orphaned `localhost:<oldPort>` serial that no longer maps to
        // this instance — that orphan's detail page would resolve to scrcpy
        // instead of VNC. Clear the row's serial too; the new startInstance
        // repopulates it below once the fresh port is bound.
        await dropAdbEndpoint(row.serial);
        if (row.serial && db) {
          try { forgetDeviceRow(db, row.serial); } catch (e: any) {
            dpLog(`Failed to clean up devices row ${row.serial} during recreate: ${e?.message ?? e}`);
          }
        }
        repo.updateSerial(row.id, null);
        try { await p.deleteInstance(runtimeId); } catch { /* container may already be gone */ }
        const fresh = await p.createInstance({
          displayName: row.displayName ?? `instance-${row.id}`,
          config: meta as Record<string, unknown>,
        });
        runtimeId = fresh.id;
        repo.updateRuntimeId(row.id, runtimeId);
      }

      const r = await p.startInstance(runtimeId);
      // Persist the resolved serial — required for CaptureSessionManager's
      // provider lookup (it routes by deviceInstances.serial → providerId).
      repo.updateSerial(row.id, r.serial ?? null);
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
      // The container is down — drop its adb endpoint so the stopped emulator
      // doesn't linger in `adb devices` (and get re-seeded as an orphan row).
      await dropAdbEndpoint(row.serial);
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
      // The container is gone, so any adb-discovered `devices` row that
      // was tracking this instance's serial is now stale. Drop it so the
      // user doesn't end up with an unactionable "online" device card
      // (lastSeen is still recent for ~2 minutes after the container dies,
      // which suppresses the Forget button on the device card).
      // Disconnect the adb endpoint BEFORE forgetting the row: the device
      // poller upserts every entry `adb devices` reports, so a still-connected
      // (now "offline") endpoint would otherwise be re-inserted as an orphan
      // moments after we delete it — reappearing as a phantom adb device.
      await dropAdbEndpoint(row.serial);
      if (row.serial && db) {
        try {
          if (forgetDeviceRow(db, row.serial)) {
            dpLog(`Cleaned up devices row ${row.serial} after instance ${row.id} delete`);
          }
        } catch (e: any) {
          // Don't fail the whole request — the instance IS gone; an
          // orphaned device row is recoverable via the Forget button.
          dpLog(`Failed to clean up devices row ${row.serial}: ${e?.message ?? e}`);
        }
      }
      // Broadcast so the Devices page (or any other WS client) drops the
      // row from its UI without a full refresh. `provider-instance-updated`
      // doesn't cover deletes — the row no longer exists to send — so we
      // emit a dedicated event with just enough identity for clients to
      // remove the right card.
      broadcastToAll({ type: 'provider-instance-deleted', id: row.id, providerId: p.id });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  }, { requires: ['core.devices:manage'] });
}
