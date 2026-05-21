import { registerEndpoint } from './api-service';
import type { ProviderRegistry } from '../services/providers';
import type { DeviceInstancesRepo } from '../services/device-instances-repo';
import { broadcastToAll } from '../websocket/index';

/**
 * Register the `/v1/devices/providers/*` REST endpoints. See spec §10.
 * The endpoints delegate to the provider registry + device-instances repo.
 * Authentication: `core.devices:manage` scope (consistent with other
 * device endpoints).
 */
export function registerDevicesProvidersEndpoints(
  registry: ProviderRegistry,
  repo: DeviceInstancesRepo,
): void {
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
    const { displayName, config } = req.body as { displayName?: string; config?: Record<string, unknown> };
    if (!displayName || typeof displayName !== 'string') {
      res.status(400).json({ success: false, error: 'displayName is required' });
      return;
    }
    try {
      const inst = await p.createInstance({ displayName, config: config ?? {} });
      const row = repo.insert({
        providerId: p.id ?? req.params.id,
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

      // If the underlying container is in an unrecoverable post-exit
      // state (the common case for docker-android: budtmo's image
      // strips /etc/passwd's root entry on first boot, so `docker
      // start` of an exited container fails with "unable to find
      // user root"), recreate it from the saved spec rather than
      // surfacing the alarming raw Docker error.
      let runtimeId = row.runtimeId;
      if ((row.state === 'error' || row.state === 'stopped') && p.createInstance && p.deleteInstance) {
        const meta = row.spawnMetadata ?? {};
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
