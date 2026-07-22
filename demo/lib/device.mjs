/**
 * Drive the Playground app on a connected device over adb, so the hero can
 * generate real traffic on cue (deterministic — no fragile screen taps). The
 * Playground v1.1+ auto-logs-in when launched with `--ez autologin true`.
 */
import { execFileSync } from 'node:child_process';

const PKG = 'app.darkride.playground';

export function adb(args, { allowFail = true } = {}) {
  try {
    return execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (!allowFail) throw e;
    console.warn(`    (adb ${args.join(' ')} failed: ${e.message.split('\n')[0]})`);
    return '';
  }
}

export function hasDevice() {
  const out = adb(['devices']);
  return out.split('\n').slice(1).some(l => l.trim().endsWith('\tdevice'));
}

/** Launch the Playground and (by default) auto-login, kicking off its API calls. */
export function launchPlayground({ autologin = true } = {}) {
  const extra = autologin ? ['--ez', 'autologin', 'true'] : [];
  adb(['shell', 'am', 'start', '-n', `${PKG}/.LoginActivity`, ...extra]);
}

export function stopPlayground() {
  adb(['shell', 'am', 'force-stop', PKG]);
}

/** Re-run the app cleanly (used before/after arming Frida). */
export function relaunchPlayground(opts) {
  stopPlayground();
  launchPlayground(opts);
}
