import type { ProviderRegistry } from './providers';
import type { DeviceInstancesRepo } from './device-instances-repo';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('shutdown');

/**
 * On graceful shutdown, stop emulator instances DarkRide spawned (so they don't
 * orphan a container + KVM slot + in-container forwarder + stale adb-reverse).
 * BYOE/observed instances (spawnedByDarkride === false) and non-running rows are
 * left untouched. Reconcile-on-boot re-adopts anything still running, so stopping
 * only our spawns is safe. Per-instance errors are logged and swallowed so one
 * failure doesn't block the rest.
 */
export async function stopSpawnedInstances(registry: ProviderRegistry, repo: DeviceInstancesRepo): Promise<void> {
  const targets = repo.listAll().filter((i) => i.spawnedByDarkride && i.state === 'running');
  for (const inst of targets) {
    try {
      const provider = registry.get(inst.providerId);
      if (provider) {
        await provider.stopInstance(inst.runtimeId);
        log(`Stopped spawned instance ${inst.id} (${inst.providerId} ${inst.runtimeId})`);
      }
    } catch (err: any) {
      error(`Failed to stop spawned instance ${inst.id} on shutdown: ${err?.message ?? err}`);
    }
  }
}
