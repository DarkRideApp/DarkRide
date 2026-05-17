/** Scoped file storage — local-first with transparent cloud sync */
export interface NamespacedStorage {
  /** Write a file. Stored locally, queued for cloud sync. */
  write(filePath: string, data: Buffer, options?: { retain?: boolean }): Promise<void>;

  /** Read a file. Local first, downloads from cloud if evicted. */
  read(filePath: string): Promise<Buffer>;

  /** Get guaranteed local file path. Downloads from cloud if not on disk. */
  getFilePath(filePath: string): Promise<string>;

  /** Get HTTP URL for serving this file to clients. */
  url(filePath: string): string;

  /** Check if file exists (local or cloud). */
  exists(filePath: string): Promise<boolean>;

  /** Delete file from local disk and cloud. */
  delete(filePath: string): Promise<void>;

  /** List files under a prefix. Returns relative paths within this namespace. */
  list(prefix: string): Promise<string[]>;

  /** Force all pending writes in this namespace to cloud. */
  flush(): Promise<void>;
}
