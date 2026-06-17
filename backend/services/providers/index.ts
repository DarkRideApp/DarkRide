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
