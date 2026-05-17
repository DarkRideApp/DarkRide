import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createLoggers } from '../logs';
import type { CloudStorageService as ICloudStorageService } from '@darkrideapp/plugin-sdk';

const logger = createLoggers('cloud-storage');

const UPLOAD_HASH_DB_PATH = path.resolve('./data/cloud-upload-hashes.json');
const MAX_UPLOAD_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

export interface CloudStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  provider: string; // 's3' | 'b2' | 'r2' | 'custom'
}

export interface ListResult {
  prefixes: string[];
  files: { key: string; size: number; lastModified: Date | null }[];
}

interface CachedPresignUrl {
  url: string;
  expiresAt: number; // epoch ms
}

export class CloudStorageService implements ICloudStorageService {
  private client: S3Client | null = null;
  private bucket: string = '';
  private presignCache = new Map<string, CachedPresignUrl>();
  /** Maps "bucket:cloudKey" → md5 hex of last uploaded file */
  private uploadHashes = new Map<string, string>();
  private hashDirty = false;
  private hashFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.loadUploadHashes();
  }

  private loadUploadHashes() {
    try {
      if (fs.existsSync(UPLOAD_HASH_DB_PATH)) {
        const data = JSON.parse(fs.readFileSync(UPLOAD_HASH_DB_PATH, 'utf-8'));
        this.uploadHashes = new Map(Object.entries(data));
        logger.log(`Loaded ${this.uploadHashes.size} upload hashes`);
      }
    } catch {
      // Start fresh if corrupt
    }
  }

  private scheduleHashFlush() {
    this.hashDirty = true;
    if (this.hashFlushTimer) return;
    this.hashFlushTimer = setTimeout(() => {
      this.hashFlushTimer = null;
      this.flushUploadHashes();
    }, 5000);
  }

  private flushUploadHashes() {
    if (!this.hashDirty) return;
    try {
      const dir = path.dirname(UPLOAD_HASH_DB_PATH);
      fs.mkdirSync(dir, { recursive: true });
      const obj = Object.fromEntries(this.uploadHashes);
      fs.writeFileSync(UPLOAD_HASH_DB_PATH, JSON.stringify(obj));
      this.hashDirty = false;
    } catch (err: any) {
      logger.error(`Failed to flush upload hashes: ${err.message}`);
    }
  }

  private hashKey(cloudKey: string): string {
    return `${this.bucket}:${cloudKey}`;
  }

  private computeFileMd5(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(buf).digest('hex');
  }

  configure(config: CloudStorageConfig): void {
    // Destroy existing client if any
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    // Clear presign cache on any reconfigure
    this.presignCache.clear();

    // Validate required fields
    if (!config.endpoint || !config.region || !config.bucket || !config.accessKey || !config.secretKey) {
      this.bucket = '';
      return;
    }

    let endpoint = config.endpoint;
    if (!endpoint.startsWith('http')) {
      endpoint = `https://${endpoint}`;
    }

    const usePathStyle = config.provider === 'b2' || config.provider === 'custom';

    this.client = new S3Client({
      endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: usePathStyle,
    });

    this.bucket = config.bucket;
    logger.log(`Configured for ${config.provider} provider, bucket: ${config.bucket}`);
  }

  shutdown(): void {
    if (this.hashFlushTimer) {
      clearTimeout(this.hashFlushTimer);
      this.hashFlushTimer = null;
    }
    this.flushUploadHashes();
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  getPresignCacheSize(): number {
    return this.presignCache.size;
  }

  /** Upload a file to cloud storage. Returns true if actually uploaded, false if dedup-skipped. */
  async upload(cloudKey: string, localPath: string): Promise<boolean> {
    if (!this.client) return false;

    // Guard against directories
    const stat = fs.statSync(localPath);
    if (stat.isDirectory()) {
      logger.error(`Upload skipped for ${cloudKey}: path is a directory`);
      return false;
    }

    // Dedup: skip if file hash matches last upload
    const md5 = this.computeFileMd5(localPath);
    const hk = this.hashKey(cloudKey);
    if (this.uploadHashes.get(hk) === md5) {
      return false; // Already uploaded identical file
    }

    // Always use multipart for files over 100MB.
    // S3/B2 PutObject has a 2GB/5GB limit depending on provider.
    const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MB
    const useMultipart = stat.size > MULTIPART_THRESHOLD;

    if (useMultipart) {
      logger.log(`Using multipart upload for ${cloudKey} (${(stat.size / 1024 / 1024).toFixed(0)} MB)`);
    }

    // Upload with retries — create a fresh stream on each attempt
    let lastErr: any;
    for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
      try {
        const body = fs.createReadStream(localPath);
        if (useMultipart) {
          const upload = new Upload({
            client: this.client,
            params: {
              Bucket: this.bucket,
              Key: cloudKey,
              Body: body,
            },
            queueSize: 4,
            partSize: 100 * 1024 * 1024, // 100 MB parts (B2 minimum is 5MB, max 10000 parts)
          });
          await upload.done();
        } else {
          await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: cloudKey,
            Body: body,
          }));
        }

        // Success — record hash
        this.uploadHashes.set(hk, md5);
        this.scheduleHashFlush();
        logger.log(`Uploaded ${cloudKey}${useMultipart ? ' (multipart)' : ''}`);
        return true;
      } catch (err: any) {
        lastErr = err;
        if (attempt < MAX_UPLOAD_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          logger.error(`Upload failed for ${cloudKey} (attempt ${attempt}/${MAX_UPLOAD_RETRIES}): ${err.message}, retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    const msg = `Upload failed for ${cloudKey} after ${MAX_UPLOAD_RETRIES} attempts: ${lastErr?.message}`;
    logger.error(msg);
    throw new Error(msg);
  }

  async download(cloudKey: string, localPath: string): Promise<{ error?: string }> {
    if (!this.client) {
      return { error: 'Cloud storage not configured' };
    }

    try {
      const parentDir = path.dirname(localPath);
      fs.mkdirSync(parentDir, { recursive: true });

      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: cloudKey,
      }));

      const body = result.Body as Readable;
      const writeStream = fs.createWriteStream(localPath);
      await pipeline(body, writeStream);

      logger.log(`Downloaded ${cloudKey} to ${localPath}`);
      return {};
    } catch (err: any) {
      logger.error(`Download failed for ${cloudKey}: ${err.message}`);
      return { error: err.message };
    }
  }

  /** Download an object directly into a Buffer (no temp file). */
  async downloadBuffer(cloudKey: string): Promise<{ buffer?: Buffer; error?: string }> {
    if (!this.client) {
      return { error: 'Cloud storage not configured' };
    }

    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: cloudKey,
      }));

      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as AsyncIterable<Buffer>) {
        chunks.push(chunk);
      }
      return { buffer: Buffer.concat(chunks) };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  /**
   * Download multiple keys concurrently, calling `onItem` for each successful download.
   * Returns the number of successful downloads.
   */
  async downloadBatch(
    keys: string[],
    concurrency: number,
    onItem: (key: string, buffer: Buffer, index: number) => void,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    let done = 0;
    let success = 0;

    for (let i = 0; i < keys.length; i += concurrency) {
      const batch = keys.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(async (key, j) => {
          const result = await this.downloadBuffer(key);
          if (result.buffer) {
            onItem(key, result.buffer, i + j);
            return true;
          }
          return false;
        }),
      );
      for (const ok of results) if (ok) success++;
      done += batch.length;
      onProgress?.(done, keys.length);
    }
    return success;
  }

  async delete(cloudKey: string): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: cloudKey,
      }));
      // Invalidate hash cache
      this.uploadHashes.delete(this.hashKey(cloudKey));
      this.scheduleHashFlush();
      logger.log(`Deleted ${cloudKey}`);
    } catch (err: any) {
      logger.error(`Delete failed for ${cloudKey}: ${err.message}`);
    }
  }

  async exists(cloudKey: string): Promise<boolean> {
    if (!this.client) return false;

    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: cloudKey,
      }));
      return true;
    } catch (err: any) {
      return false;
    }
  }

  async presignUrl(cloudKey: string, expiresInSec = 3600): Promise<string | null> {
    if (!this.client) return null;

    // Check cache — return if >10 minutes until expiry
    const cached = this.presignCache.get(cloudKey);
    if (cached) {
      const tenMinutesMs = 10 * 60 * 1000;
      if (cached.expiresAt - Date.now() > tenMinutesMs) {
        return cached.url;
      }
    }

    const url = await getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket,
      Key: cloudKey,
    }), { expiresIn: expiresInSec });

    this.presignCache.set(cloudKey, {
      url,
      expiresAt: Date.now() + expiresInSec * 1000,
    });

    return url;
  }

  async headBucket(): Promise<void> {
    if (!this.client) {
      throw new Error('Cloud storage not configured');
    }

    await this.client.send(new HeadBucketCommand({
      Bucket: this.bucket,
    }));
  }

  async listObjects(prefix: string, delimiter = '/'): Promise<ListResult> {
    if (!this.client) {
      return { prefixes: [], files: [] };
    }

    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix,
      Delimiter: delimiter,
    }));

    const prefixes = (result.CommonPrefixes ?? [])
      .map(p => p.Prefix!)
      .filter(Boolean);

    const files = (result.Contents ?? [])
      .filter(obj => obj.Key !== prefix)
      .map(obj => ({
        key: obj.Key!,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? null,
      }));

    return { prefixes, files };
  }

  /** List ALL object keys under a prefix (paginated, no delimiter). */
  async listAllKeys(prefix: string): Promise<string[]> {
    if (!this.client) return [];

    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      for (const obj of result.Contents ?? []) {
        if (obj.Key) keys.push(obj.Key);
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys;
  }

  /**
   * List ALL objects under a prefix with their ETags (paginated).
   * For single-part uploads, ETag is the MD5 hex hash of the content.
   */
  async listAllKeysWithETags(prefix: string): Promise<{ key: string; etag: string }[]> {
    if (!this.client) return [];

    const items: { key: string; etag: string }[] = [];
    let continuationToken: string | undefined;

    do {
      const result = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      for (const obj of result.Contents ?? []) {
        if (obj.Key && obj.ETag) {
          // Strip surrounding quotes from ETag: "abc123" → abc123
          items.push({ key: obj.Key, etag: obj.ETag.replace(/^"|"$/g, '') });
        }
      }

      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);

    return items;
  }
}
