import { readdir, statfs } from 'fs/promises';
import type { Dirent } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

export interface DiskUsage {
  volumeTotalBytes: number;
  volumeFreeBytes: number;
  dirSizes: Record<string, number>;
}

/**
 * Measure the capacity of the volume holding `rootPath` and the
 * block-allocated size of each immediate subdirectory of `rootPath`.
 *
 * Volume numbers come from statfs (free space uses bavail, matching
 * checkDiskSpace in index.ts). Per-directory sizes shell out to
 * `du -s --block-size=1`, which reports the same bytes as CLI `du`.
 * If `du` fails for a directory, that directory is omitted rather than
 * failing the whole measurement.
 */
export async function measureDiskUsage(rootPath: string): Promise<DiskUsage> {
  const stats = await statfs(rootPath);
  const volumeTotalBytes = stats.bsize * stats.blocks;
  const volumeFreeBytes = stats.bsize * stats.bavail;

  let entries: Dirent[] = [];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return { volumeTotalBytes, volumeFreeBytes, dirSizes: {} };
  }

  const subdirs = entries.filter(e => e.isDirectory());
  const dirSizes: Record<string, number> = {};

  await Promise.all(
    subdirs.map(async (dir) => {
      try {
        const { stdout } = await execFileAsync(
          'du',
          // `--` ends option parsing so a subdir whose name starts with `-`
          // can't be read as a flag. `timeout` bounds a stuck du (e.g. a hung
          // network mount) so it can't wedge the snapshot job.
          ['-s', '--block-size=1', '--', path.join(rootPath, dir.name)],
          { maxBuffer: 1024 * 1024, timeout: 30_000 },
        );
        const bytes = parseInt(stdout.split(/\s+/)[0], 10);
        if (Number.isFinite(bytes)) {
          dirSizes[dir.name] = bytes;
        }
      } catch {
        // du unavailable or directory unreadable — skip this dir
      }
    }),
  );

  return { volumeTotalBytes, volumeFreeBytes, dirSizes };
}
