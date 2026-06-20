import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression guard for the recurring `adb shell "su -c '<cmd>'"` quoting bug.
 *
 * adbShell() runs adb via execFile with NO host shell, so a backtick-wrapped
 * `"su -c '<cmd>'"` reaches the *device* shell verbatim and is parsed as ONE
 * bogus command word → "inaccessible or not found", even on a properly-rooted
 * device. It broke CA-cert injection and WireGuard setup (see suShell's doc in
 * device-manager.ts). The correct path is suShell(), which emits the bare
 * `su -c '<cmd>'`. This test fails the build if any service reintroduces the
 * wrapped form passed to a device shell.
 *
 * The host-shell idiom `adb shell "su -c '...'"` (a full command STRING that
 * includes `adb shell`, run through a host shell) is a different, valid form
 * and does not match the pattern below — it lacks the leading backtick+quote.
 */
function tsSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsSourceFiles(full);
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) return [full];
    return [];
  });
}

// The buggy form always wrote a template literal beginning with `"su -c …
const BUGGY = /`\s*"su -c/;

describe('su -c quoting guard', () => {
  it('no backend service passes a backtick-wrapped "su -c to a device shell (use suShell instead)', () => {
    const servicesDir = __dirname;
    const offenders: string[] = [];
    for (const file of tsSourceFiles(servicesDir)) {
      readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        // Skip comment lines — the suShell() doc deliberately quotes the bad form.
        if (/^\s*(\*|\/\/)/.test(line)) return;
        if (BUGGY.test(line)) offenders.push(`${file.replace(servicesDir + '/', '')}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
