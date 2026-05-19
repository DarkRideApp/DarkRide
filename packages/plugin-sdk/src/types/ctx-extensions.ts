import type { CloudFileRow, AutomationRow, ApkHandle, ApkVersionMeta } from './host-tables';
import type { Dispatcher } from 'undici';

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

// --- DispatcherApi ---

/**
 * Egress configuration for an outbound HTTP request. Today only SOCKS5
 * is supported; HTTP / HTTPS / PAC proxy variants can be added when a
 * real consumer needs them.
 *
 * The host pools dispatchers by structural equality — two calls to
 * `ctx.dispatcher(spec)` with equal specs return the same instance,
 * which deduplicates Agents across plugins and bounds the TCP
 * connection rate against any one upstream endpoint.
 */
export type DispatcherSpec = {
  type: 'socks5';
  host: string;
  port: number;
  auth?: { username: string; password: string };
  /**
   * Max concurrent TCP connections this Agent will open. Default 8 —
   * chosen conservatively to avoid handshake-rate throttling on
   * commercial SOCKS endpoints (NordVPN's observed throttle threshold
   * is well below undici's default of 100).
   */
  connections?: number;
};

/**
 * Get or create a pooled undici Dispatcher for the given egress spec.
 * Structurally-equal specs return the same instance; the host owns
 * the Agent lifecycle and destroys it at shutdown.
 *
 * @example
 *   import { fetch } from 'undici';
 *   const dispatcher = ctx.dispatcher({
 *     type: 'socks5',
 *     host: 'us.socks.nordhold.net',
 *     port: 1080,
 *     auth: { username: '…', password: '…' },
 *   });
 *   const res = await fetch('https://example.com', { dispatcher });
 */
export interface DispatcherApi {
  (spec: DispatcherSpec): Dispatcher;
}
