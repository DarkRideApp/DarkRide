import { execFileSync } from 'child_process';
import fs from 'fs';

/**
 * Locate a POSIX shell for tests that execute a generated `sh` script.
 *
 * Several tests verify a shell contract by *running* the script rather than
 * string-matching it — the only way to prove the emitted stdout is what the
 * target actually produces. Those tests hardcoded `/bin/sh`, which does not
 * exist on Windows, so they failed with `spawnSync /bin/sh ENOENT` regardless
 * of whether a perfectly good shell was installed (Git Bash ships one on PATH).
 *
 * Resolution order: `/bin/sh` when present (Linux, macOS, CI), then `sh` from
 * PATH (Git Bash / MSYS on Windows). Returns null when neither works, so a
 * caller can skip rather than fail on a machine with no shell at all.
 *
 * Cached: probing spawns a process, and these tests call it repeatedly.
 */
let cached: string | null | undefined;

/**
 * @param run Inject `execFileSync` from `vi.importActual('child_process')` when
 *   the calling suite mocks `child_process` wholesale — otherwise the probe
 *   runs against the mock (which has no `execFileSync`) and reports no shell.
 *   An injected runner bypasses the cache, since it may disagree with the
 *   module-level one.
 */
export function findPosixShell(run?: typeof execFileSync): string | null {
  if (run) return probe(run);
  if (cached !== undefined) return cached;
  cached = probe(execFileSync);
  return cached;
}

function probe(run: typeof execFileSync): string | null {
  if (fs.existsSync('/bin/sh')) return '/bin/sh';
  try {
    // Confirm it actually runs — a `sh` that exists but can't execute is worse
    // than none, because the failure surfaces inside the assertion instead.
    run('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    return 'sh';
  } catch {
    return null;
  }
}

/**
 * Path form to hand to the shell found above. MSYS/Git Bash `sh` does not
 * understand a backslash-separated Windows path as a script argument.
 */
export function toShellPath(p: string): string {
  return p.replace(/\\/g, '/');
}
