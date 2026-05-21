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
      // We don't store a "why" string here — DeviceInstancesRepo only persists
      // lastError when state === 'error'. If you want a stored diagnostic for
      // disappeared devices, transition state to 'error' instead.
      repo.updateState(r.id, 'stopped');
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
