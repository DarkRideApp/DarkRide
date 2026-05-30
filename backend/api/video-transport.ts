import type { ProviderRegistry } from '../services/providers';
import type { DeviceInstancesRepo } from '../services/device-instances-repo';
import { registerEndpoint } from './api-service';

export type VideoTransportResult =
  | { transport: 'scrcpy' }
  | { transport: 'vnc'; wsPath: string }
  | { transport: 'webrtc'; grpcWebPath: string };

/**
 * The instance that OWNS video for a serial, preferring running. A serial is
 * NOT unique: a docker-android emulator is also observed by the adb-device
 * provider, and host-port reuse can leave a stale adb-device (or stopped
 * docker-android) row sharing the serial. We must pick the running,
 * video-capable instance rather than `getBySerial`'s lowest-rowid match (which
 * would let a stale adb-device row shadow the live emulator → wrong scrcpy
 * path). `cap` names the provider capability the transport requires.
 */
function pickVideoInstance(
  serial: string,
  repo: DeviceInstancesRepo,
  registry: ProviderRegistry,
  transport: 'webrtc' | 'vnc',
  cap: 'getGrpcEndpoint' | 'getVncEndpoint',
) {
  return repo.listBySerial(serial)
    .filter((row) => {
      const provider = registry.get(row.providerId);
      return provider?.videoTransport === transport && typeof provider[cap] === 'function';
    })
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running'))[0];
}

/** The running, gRPC-capable instance for a serial (shared by the grpc-web bridge). */
export function resolveGrpcInstance(serial: string, repo: DeviceInstancesRepo, registry: ProviderRegistry) {
  return pickVideoInstance(serial, repo, registry, 'webrtc', 'getGrpcEndpoint') ?? null;
}

/**
 * Pure resolver — easy to unit test without standing up an Express stack.
 * The endpoint wrapper at the bottom of this file is the thin HTTP shell.
 */
export function resolveVideoTransport(
  serial: string,
  repo: DeviceInstancesRepo,
  registry: ProviderRegistry,
): VideoTransportResult {
  // 'webrtc': the browser's android-emulator-webrtc client speaks grpc-web to
  // this base path; the DarkRide grpc-web bridge forwards to the emulator gRPC.
  if (pickVideoInstance(serial, repo, registry, 'webrtc', 'getGrpcEndpoint')) {
    return { transport: 'webrtc', grpcWebPath: `/v1/devices/${encodeURIComponent(serial)}/grpc` };
  }
  if (pickVideoInstance(serial, repo, registry, 'vnc', 'getVncEndpoint')) {
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
