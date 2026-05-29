import type { ProviderRegistry } from '../services/providers';
import type { DeviceInstancesRepo } from '../services/device-instances-repo';
import { registerEndpoint } from './api-service';

export type VideoTransportResult =
  | { transport: 'scrcpy' }
  | { transport: 'vnc'; wsPath: string };

/**
 * Pure resolver — easy to unit test without standing up an Express stack.
 * The endpoint wrapper at the bottom of this file is the thin HTTP shell.
 */
export function resolveVideoTransport(
  serial: string,
  repo: DeviceInstancesRepo,
  registry: ProviderRegistry,
): VideoTransportResult {
  const row = repo.getBySerial(serial);
  if (!row) return { transport: 'scrcpy' };
  const provider = registry.get(row.providerId);
  if (provider?.videoTransport !== 'vnc') return { transport: 'scrcpy' };
  return { transport: 'vnc', wsPath: `/ws/vnc?serial=${encodeURIComponent(serial)}` };
}

export function registerVideoTransportEndpoint(
  repo: DeviceInstancesRepo,
  registry: ProviderRegistry,
): void {
  registerEndpoint('GET', '/v1/devices/:serial/video-transport', async (req, res) => {
    const serial = decodeURIComponent(req.params.serial);
    res.json({ success: true, data: resolveVideoTransport(serial, repo, registry) });
  }, { requires: ['core.devices:read'] });
}
