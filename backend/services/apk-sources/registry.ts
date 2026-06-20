import type { RemoteApkSource } from './types';

/**
 * Holds the set of remote APK sources the tracker iterates each cycle.
 * Insertion order is preserved so the UI lists sources deterministically.
 */
export class SourceRegistry {
  private sources = new Map<string, RemoteApkSource>();

  register(source: RemoteApkSource): this {
    this.sources.set(source.id, source);
    return this;
  }

  get(id: string): RemoteApkSource | undefined {
    return this.sources.get(id);
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  all(): RemoteApkSource[] {
    return [...this.sources.values()];
  }

  ids(): string[] {
    return [...this.sources.keys()];
  }
}
