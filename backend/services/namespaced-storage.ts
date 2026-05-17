import fs from 'fs';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import type { AppDatabase } from '../db/index';
import type { CloudStorageService } from './cloud-storage';
import { cloudFiles } from '../db/schema';
import { createLoggers } from '../logs';
import type { NamespacedStorage } from '@darkrideapp/plugin-sdk';
import { absoluteLocalPath, toRelativeLocalPath, getDataRoot } from '../config/paths';

const { error: logError } = createLoggers('file-storage');

export class NamespacedStorageImpl implements NamespacedStorage {
  constructor(
    private namespace: string,
    private localRoot: string,          // e.g., data/plugins/maps/
    private db: AppDatabase | null,     // null in pure unit tests
    private cloudStorage: CloudStorageService | null,
    private cloudKeyPrefix?: string,    // e.g., 'plugins/maps/' or 'apks/' — defaults to plugins/{namespace}/
  ) {}

  /** Resolve and validate a file path — throws on traversal attempts */
  private safePath(filePath: string): string {
    // Decode any URL-encoded characters first
    const decoded = decodeURIComponent(filePath);
    const resolved = path.resolve(this.localRoot, decoded);
    const normalizedRoot = path.resolve(this.localRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(this.localRoot)) {
      throw new Error(`Path traversal rejected: "${filePath}" resolves outside namespace`);
    }
    return resolved;
  }

  private localPath(filePath: string): string {
    return this.safePath(filePath);
  }

  private cloudKey(filePath: string): string {
    // Validate path before constructing cloud key
    this.safePath(filePath);
    const prefix = this.cloudKeyPrefix ?? `plugins/${this.namespace}/`;
    return `${prefix}${filePath}`;
  }

  async write(filePath: string, data: Buffer, options?: { retain?: boolean }): Promise<void> {
    const local = this.localPath(filePath);
    const dir = path.dirname(local);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(local, data);

    // Track in DB for cloud sync + LRU
    if (this.db) {
      const key = this.cloudKey(filePath);
      const now = new Date();
      const existing = this.db.select()
        .from(cloudFiles)
        .where(eq(cloudFiles.cloudKey, key))
        .all();

      if (existing.length > 0) {
        this.db.update(cloudFiles)
          .set({
            relativePath: toRelativeLocalPath(local),
            fileSize: data.length,
            syncState: 'pending_upload',
            syncError: null,
            retain: options?.retain ?? existing[0].retain,
            lastAccessed: now,
            namespace: this.namespace,
          })
          .where(eq(cloudFiles.cloudKey, key))
          .run();
      } else {
        this.db.insert(cloudFiles)
          .values({
            namespace: this.namespace,
            relativePath: toRelativeLocalPath(local),
            cloudKey: key,
            fileType: path.extname(filePath).replace('.', '') || 'bin',
            fileSize: data.length,
            syncState: 'pending_upload',
            retain: options?.retain ?? false,
            lastAccessed: now,
            createdAt: now,
          })
          .run();
      }
    }
  }

  async read(filePath: string): Promise<Buffer> {
    const local = this.localPath(filePath);

    // Try local first
    if (fs.existsSync(local)) {
      this.bumpAccessed(filePath);
      return fs.readFileSync(local);
    }

    // Fall back to cloud
    if (this.cloudStorage?.isConfigured()) {
      const key = this.cloudKey(filePath);
      const dir = path.dirname(local);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const result = await this.cloudStorage.download(key, local);
      if (result?.error) {
        throw new Error(`Cloud download failed for ${this.namespace}/${filePath}: ${result.error}`);
      }

      if (fs.existsSync(local)) {
        this.updateState(filePath, 'synced');
        return fs.readFileSync(local);
      }
    }

    throw new Error(`File not found: ${this.namespace}/${filePath}`);
  }

  async getFilePath(filePath: string): Promise<string> {
    const local = this.localPath(filePath);

    if (fs.existsSync(local)) {
      this.bumpAccessed(filePath);
      return local;
    }

    // Download from cloud
    if (this.cloudStorage?.isConfigured()) {
      const key = this.cloudKey(filePath);
      const dir = path.dirname(local);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const result = await this.cloudStorage.download(key, local);
      if (result?.error) {
        throw new Error(`Cloud download failed for ${this.namespace}/${filePath}: ${result.error}`);
      }

      if (fs.existsSync(local)) {
        this.updateState(filePath, 'synced');
        return local;
      }
    }

    throw new Error(`File not found: ${this.namespace}/${filePath}`);
  }

  url(filePath: string): string {
    return `/v1/files/${this.namespace}/${filePath}`;
  }

  async exists(filePath: string): Promise<boolean> {
    const local = this.localPath(filePath);
    if (fs.existsSync(local)) return true;

    // Check cloud
    if (this.cloudStorage?.isConfigured()) {
      return this.cloudStorage.exists(this.cloudKey(filePath));
    }

    return false;
  }

  async delete(filePath: string): Promise<void> {
    const local = this.localPath(filePath);
    try {
      if (fs.existsSync(local)) fs.unlinkSync(local);
    } catch { /* ignore */ }

    // Delete from cloud
    if (this.cloudStorage?.isConfigured()) {
      try {
        await this.cloudStorage.delete(this.cloudKey(filePath));
      } catch { /* ignore */ }
    }

    // Remove DB tracking
    if (this.db) {
      this.db.delete(cloudFiles)
        .where(eq(cloudFiles.cloudKey, this.cloudKey(filePath)))
        .run();
    }
  }

  async list(prefix: string): Promise<string[]> {
    const resultSet = new Set<string>();

    // Walk local filesystem
    const localDir = this.localPath(prefix);
    if (fs.existsSync(localDir)) {
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else {
            // Normalize to forward slashes for cross-platform consistency
            resultSet.add(path.relative(this.localRoot, full).split(path.sep).join('/'));
          }
        }
      };
      walk(localDir);
    }

    // Include cloud-only files from DB (evicted from disk but still available).
    // relativePath is DATA_ROOT-relative (e.g. "plugins/maps/subdir/file.bin"),
    // so strip the namespaced localRoot prefix to return a namespace-relative
    // path matching what the filesystem walk emits.
    if (this.db) {
      const pathFromDataRoot = path.relative(
        getDataRoot(),
        this.localRoot,
      ).split(path.sep).join('/');
      const fullPrefix = `${pathFromDataRoot}/${prefix}`;
      const rows = this.db.select({ relativePath: cloudFiles.relativePath })
        .from(cloudFiles)
        .where(and(
          eq(cloudFiles.namespace, this.namespace),
          eq(cloudFiles.syncState, 'cloud_only'),
        ))
        .all();
      for (const row of rows) {
        if (row.relativePath.startsWith(fullPrefix)) {
          resultSet.add(row.relativePath.slice(pathFromDataRoot.length + 1));
        }
      }
    }

    return Array.from(resultSet);
  }

  isCloudConfigured(): boolean {
    return this.cloudStorage?.isConfigured() ?? false;
  }

  async flush(): Promise<void> {
    if (!this.db || !this.cloudStorage?.isConfigured()) return;

    const pending = this.db.select()
      .from(cloudFiles)
      .where(and(
        eq(cloudFiles.namespace, this.namespace),
        eq(cloudFiles.syncState, 'pending_upload'),
      ))
      .all();

    for (const file of pending) {
      try {
        await this.cloudStorage.upload(file.cloudKey, absoluteLocalPath(file.relativePath));
        this.db.update(cloudFiles)
          .set({ syncState: 'synced', syncError: null })
          .where(eq(cloudFiles.id, file.id))
          .run();
      } catch (err: any) {
        this.db.update(cloudFiles)
          .set({ syncError: err.message })
          .where(eq(cloudFiles.id, file.id))
          .run();
        logError(`Flush upload failed for ${file.cloudKey}: ${err.message}`);
      }
    }
  }

  // --- Internal helpers ---

  private bumpAccessed(filePath: string): void {
    if (!this.db) return;
    this.db.update(cloudFiles)
      .set({ lastAccessed: new Date() })
      .where(eq(cloudFiles.cloudKey, this.cloudKey(filePath)))
      .run();
  }

  private updateState(filePath: string, state: string): void {
    if (!this.db) return;
    this.db.update(cloudFiles)
      .set({ syncState: state, lastAccessed: new Date() })
      .where(eq(cloudFiles.cloudKey, this.cloudKey(filePath)))
      .run();
  }
}
