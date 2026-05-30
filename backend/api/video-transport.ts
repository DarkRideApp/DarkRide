import type { ProviderRegistry } from '../services/providers';
import type { DeviceInstancesRepo } from '../services/device-instances-repo';
import { registerEndpoint } from './api-service';

export type VideoTransportResult =
  | { transport: 'scrcpy' }
  | { transport: 'vnc'; wsPath: string }
  | { transport: 'webrtc'; grpcWebPath: string };

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
  // 'webrtc': the browser's android-emulator-webrtc client speaks grpc-web to
  // this base path; the DarkRide grpc-web bridge forwards to the emulator gRPC.
  if (provider?.videoTransport === 'webrtc') {
    return { transport: 'webrtc', grpcWebPath: `/v1/devices/${encodeURIComponent(serial)}/grpc` };
  }
  if (provider?.videoTransport === 'vnc') {
    return { transport: 'vnc', wsPath: `/ws/vnc?serial=${encodeURIComponent(serial)}` };
  }
  return { transport: 'scrcpy' };
}

export function registerVideoTransportEndpoint(
  repo: DeviceInstancesRepo,
  registry: ProviderRegistry,
): void {
  registerEndpoint('GET', '/v1/devices/:serial/video-transport', async (req, res) => {
    // Express already URL-decodes path params, so req.params.serial is the
    // raw serial (e.g., "localhost:32770"). A second decodeURIComponent would
    // throw URIError on any serial containing a literal '%' character.
    const serial = req.params.serial;
    res.json({ success: true, data: resolveVideoTransport(serial, repo, registry) });
  }, { requires: ['core.devices:read'] });
}
