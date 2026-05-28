import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { measureDiskUsage } from './disk-usage';

describe('measureDiskUsage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'darkride-disk-test-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns volume totals and per-subdir sizes', async () => {
    mkdirSync(path.join(root, 'apks'));
    mkdirSync(path.join(root, 'couchbase'));
    writeFileSync(path.join(root, 'apks', 'a.bin'), Buffer.alloc(4096));
    writeFileSync(path.join(root, 'couchbase', 'b.bin'), Buffer.alloc(8192));
    // a loose file at the root should NOT appear as a directory entry
    writeFileSync(path.join(root, 'darkride.db'), Buffer.alloc(1024));

    const result = await measureDiskUsage(root);

    expect(result.volumeTotalBytes).toBeGreaterThan(0);
    expect(result.volumeFreeBytes).toBeGreaterThan(0);
    expect(Object.keys(result.dirSizes).sort()).toEqual(['apks', 'couchbase']);
    // du reports block-allocated bytes; each non-empty dir is at least its file size
    expect(result.dirSizes.apks).toBeGreaterThanOrEqual(4096);
    expect(result.dirSizes.couchbase).toBeGreaterThanOrEqual(8192);
  });

  it('returns volume stats with empty dirSizes when root has no subdirs', async () => {
    const result = await measureDiskUsage(root);
    expect(result.volumeTotalBytes).toBeGreaterThan(0);
    expect(result.dirSizes).toEqual({});
  });
});
