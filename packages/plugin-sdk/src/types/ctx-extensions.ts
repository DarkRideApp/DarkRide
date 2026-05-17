import type { CloudFileRow, AutomationRow, ApkHandle, ApkVersionMeta } from './host-tables';

export interface SettingsApi {
  get(key: string): Promise<string | null>;
  getJson<T>(key: string): Promise<T | null>;
  set(key: string, value: string): Promise<void>;
  setJson(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** List all keys matching the optional prefix. Returns key+value pairs. */
  list(prefix?: string): Promise<Array<{ key: string; value: string }>>;
}

export interface CloudFilesApi {
  listByNamespace(namespace: string, filter?: {
    retain?: boolean;
    beforeCreatedAt?: Date;
  }): Promise<CloudFileRow[]>;

  setSyncState(id: number, state: string): Promise<void>;
  setSyncError(id: number, error: string | null): Promise<void>;
  setRetain(id: number, retain: boolean): Promise<void>;
  delete(id: number): Promise<void>;

  upsertByCloudKey(record: {
    cloudKey: string;
    namespace: string;
    relativePath: string;
    fileType: string;
    fileSize: number;
    syncState: string;
    syncError?: string | null;
    retain?: boolean;
    lastAccessed?: Date;
  }): Promise<void>;
}

export interface AutomationsApi {
  list(): Promise<AutomationRow[]>;
}

export interface WebsocketApi {
  /** Broadcast a message. message.type identifies the channel; clients with
   *  matching subscription receive it (filtered) or all clients (unfiltered). */
  broadcast(message: Record<string, unknown>): void;

  /** Register a filtered channel — broadcasts on this channel only deliver to
   *  clients whose subscription set includes the channel name. */
  registerChannel(channel: string, opts?: { requires?: string[] }): void;
}

export interface ApkApi {
  lookupVersion(versionId: number): Promise<ApkVersionMeta | null>;
  ensureLocal(handle: ApkHandle): Promise<string>;
  analysisDbPath(handle: ApkHandle): string;
}

export interface PathsApi {
  /** Resolve a relative path under DATA_ROOT to its absolute filesystem path.
   *  For plugin-scoped storage prefer ctx.files() — this is for interop with
   *  external processes that need an absolute path. */
  fileStorage(relativePath: string): string;
}
