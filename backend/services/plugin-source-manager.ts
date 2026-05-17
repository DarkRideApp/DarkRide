import { eq } from 'drizzle-orm';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pluginSources } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const execFileAsync = promisify(execFile);
const { log, error } = createLoggers('plugin-sources');

export interface MarketplacePlugin {
  name: string;
  displayName: string;
  description: string;
  author: string;
  repo: string;
  latestVersion: string;
  category: string;
  license: string;
  npmPackage: string;
  minDarkrideVersion?: string;
  signature?: string;
  signedBy?: string;
  source?: string; // which source this came from
  installUrl?: string; // for git sources: git+https://...
}

export interface SourceFetchResult {
  sourceName: string;
  sourceType: string;
  plugins: MarketplacePlugin[];
  error?: string;
}

export class PluginSourceManager {
  private cache: { results: SourceFetchResult[]; fetchedAt: number } | null = null;
  private static CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(private db: AppDatabase) {}

  getAll() {
    return this.db.select().from(pluginSources).all();
  }

  getEnabled() {
    return this.db.select().from(pluginSources)
      .where(eq(pluginSources.enabled, true))
      .all();
  }

  add(source: { name: string; type: 'registry' | 'git'; url: string; authToken?: string }): number {
    // Check for duplicate URL
    const existing = this.db.select().from(pluginSources)
      .where(eq(pluginSources.url, source.url)).get();
    if (existing) throw new Error('A source with this URL already exists');

    const result = this.db.insert(pluginSources).values({
      name: source.name,
      type: source.type,
      url: source.url,
      authToken: source.authToken ?? null,
      enabled: true,
      isDefault: false,
      priority: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();
    return Number(result.lastInsertRowid);
  }

  update(id: number, updates: { name?: string; url?: string; authToken?: string; enabled?: boolean }) {
    const source = this.db.select().from(pluginSources)
      .where(eq(pluginSources.id, id)).get();
    if (!source) throw new Error('Source not found');

    this.db.update(pluginSources).set({
      ...updates,
      updatedAt: new Date(),
    }).where(eq(pluginSources.id, id)).run();
  }

  remove(id: number) {
    const source = this.db.select().from(pluginSources)
      .where(eq(pluginSources.id, id)).get();
    if (!source) throw new Error('Source not found');
    if (source.isDefault) throw new Error('Cannot remove the default source');

    this.db.delete(pluginSources).where(eq(pluginSources.id, id)).run();
  }

  async fetchRegistry(source: { url: string; authToken?: string | null; name: string }): Promise<MarketplacePlugin[]> {
    const headers: Record<string, string> = {};
    if (source.authToken) headers['Authorization'] = `Bearer ${source.authToken}`;

    const response = await fetch(source.url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json() as any;
    const plugins = data.plugins || [];
    return plugins.map((p: any) => ({ ...p, source: source.name }));
  }

  async fetchGitRepo(source: { url: string; authToken?: string | null; name: string }): Promise<MarketplacePlugin | null> {
    const tempDir = mkdtempSync(join(tmpdir(), 'darkride-plugin-'));
    try {
      const cloneUrl = source.authToken
        ? source.url.replace(/^https:\/\//, `https://token:${source.authToken}@`)
        : source.url;

      await execFileAsync('git', ['clone', '--depth', '1', cloneUrl, tempDir], {
        timeout: 30_000,
      });

      // Check for darkride-plugin entry
      const hasEntry = existsSync(join(tempDir, 'darkride-plugin.ts'))
        || existsSync(join(tempDir, 'darkride-plugin.js'));
      if (!hasEntry) return null;

      // Read package.json
      const pkgPath = join(tempDir, 'package.json');
      if (!existsSync(pkgPath)) return null;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      return {
        name: pkg.name?.replace(/^@[^/]+\//, '').replace(/^darkride-plugin-/, '').replace(/^plugin-/, '') || 'unknown',
        displayName: pkg.displayName || pkg.name || 'Unknown Plugin',
        description: pkg.description || '',
        author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || '',
        repo: '',
        latestVersion: pkg.version || '0.0.0',
        category: pkg.keywords?.includes('darkride-plugin') ? 'community' : 'uncategorized',
        license: pkg.license || 'Unknown',
        npmPackage: pkg.name || '',
        source: source.name,
        installUrl: `git+${source.url}`,
      };
    } catch (err: any) {
      error(`Failed to fetch git repo ${source.url}: ${err.message}`);
      return null;
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }

  async fetchAll(bustCache = false): Promise<SourceFetchResult[]> {
    if (!bustCache && this.cache && Date.now() - this.cache.fetchedAt < PluginSourceManager.CACHE_TTL_MS) {
      return this.cache.results;
    }

    const sources = this.getEnabled();
    const results: SourceFetchResult[] = [];

    await Promise.all(sources.map(async (source) => {
      try {
        if (source.type === 'registry') {
          const plugins = await this.fetchRegistry(source);
          results.push({ sourceName: source.name, sourceType: source.type, plugins });
        } else if (source.type === 'git') {
          const plugin = await this.fetchGitRepo(source);
          results.push({
            sourceName: source.name,
            sourceType: source.type,
            plugins: plugin ? [plugin] : [],
          });
        }
      } catch (err: any) {
        results.push({ sourceName: source.name, sourceType: source.type, plugins: [], error: err.message });
      }
    }));

    this.cache = { results, fetchedAt: Date.now() };
    return results;
  }

  getCacheFetchedAt(): number | null {
    return this.cache?.fetchedAt ?? null;
  }

  /**
   * Return the flat list of plugins from the cache without triggering a fetch.
   * Used by /v1/plugins/installed to compute updateAvailable cheaply — the
   * endpoint mustn't pay the network cost. Returns [] if cache is empty.
   */
  getCachedPlugins(): MarketplacePlugin[] {
    if (!this.cache) return [];
    return this.cache.results.flatMap(r => r.plugins);
  }
}
