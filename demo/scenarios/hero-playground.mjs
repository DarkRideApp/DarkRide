/**
 * HERO scenario — DarkRide vs the DarkRide Playground (rooted/Frida-able device).
 *
 * A narrated, choreographed sequence with on-screen captions. The reliable
 * backbone — captions, launching the Playground over adb (it auto-logs-in), and
 * navigating the right panes — always runs. The app-specific UI clicks (Frida,
 * APK findings, WS row) are best-effort: tune the SELECTORS below on your first
 * run; a miss logs and the recording continues (the seeded data + the caption
 * still carry the beat).
 *
 * Prereqs (on the recording machine):
 *   - Playground v1.1+ installed on a connected, Frida-able device:
 *       demo/fetch-playground.sh && adb install -r demo/assets/playground.apk
 *   - `adb` on PATH, a device authorised, `--headed` (WebCodecs device stream).
 *   - Ideally the hero DarkRide from demo/hero-env.sh (clean seeded data).
 */
import { caption, clearCaption } from '../lib/captions.mjs';
import { hasDevice, launchPlayground, relaunchPlayground, stopPlayground } from '../lib/device.mjs';

// ── Tune these against your live UI on the first run ───────────────────────
const SELECTORS = {
  fridaPinScript: 'text=/cert.?pinning/i',   // the cert-pinning-bypass script entry
  fridaRootScript: 'text=/root.?detection/i',
  fridaRun: 'button:has-text("Run"), [data-testid="frida-run"]',
  apkPlayground: 'text=/playground/i',       // the Playground APK row on /ui/apks
  apkFindings: 'text=/finding/i',
  aiOpen: '[data-testid="ai-chat-toggle"], button[aria-label*="AI"]',
};
// ───────────────────────────────────────────────────────────────────────────

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function heroPlayground(page, { baseURL }) {
  if (!hasDevice()) console.warn('  ! no adb device detected — live beats will be empty; seeded data still shows.');

  // Beat helper: set the caption, run the (guarded) actions, hold for readability.
  const beat = async (n, title, subtitle, fn) => {
    console.log(`  ▸ beat ${n}: ${title}`);
    await caption(page, `${n}. ${title}`, subtitle);
    try { await fn(); } catch (e) { console.warn(`    (beat ${n} interaction skipped: ${e.message.split('\n')[0]})`); }
    await wait(2600);
  };

  const goPane = async (path) => {
    await page.goto(`${baseURL}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
    await wait(700);
  };
  const clickSoft = async (sel, timeout = 3500) => {
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout });
    await loc.click();
  };
  const trafficRow = (pathText) => page.locator('.traffic-path', { hasText: pathText }).first();

  await goPane('/ui/network');

  // ── Act 1: capture the (unpinned) login ────────────────────────────────
  await beat(1, 'Capturing live traffic', 'The Playground logs in — the token hits DarkRide instantly', async () => {
    stopPlayground(); await wait(600);
    launchPlayground({ autologin: true });            // fires POST /login (unpinned)
    await trafficRow('/login').waitFor({ state: 'visible', timeout: 12_000 });
    await trafficRow('/login').click();               // open its detail
  });

  // ── Act 2: the pinned call is invisible ─────────────────────────────────
  await beat(2, 'But /profile is certificate-pinned', 'The app pins its authed calls — they never reach the proxy', async () => {
    await goPane('/ui/network?pane=traffic');
    // (nothing to click — the point is the absence; the caption carries it)
  });

  // ── Act 3: one Frida script defeats the pin + root check ─────────────────
  await beat(3, 'Frida defeats the pin and the root check', 'Arm the bypass, respawn the app with it attached', async () => {
    await goPane('/ui/frida');
    await clickSoft(SELECTORS.fridaPinScript).catch(() => {});
    await clickSoft(SELECTORS.fridaRootScript).catch(() => {});
    await clickSoft(SELECTORS.fridaRun).catch(() => {});
    await wait(1500);
    relaunchPlayground({ autologin: true });          // respawns; authed calls now flow
    await wait(2000);
  });

  // ── Act 4: now the pinned calls flow ────────────────────────────────────
  await beat(4, 'Now everything flows', 'profile, feed, telemetry — captured in the clear', async () => {
    await goPane('/ui/network?pane=traffic');
    await trafficRow('/profile').first().click().catch(() => {});
  });

  // ── Act 5: the APK gives up its secrets ─────────────────────────────────
  await beat(5, 'The APK gives up its secrets', 'A hardcoded API key, surfaced and summarised by the agent', async () => {
    await goPane('/ui/apks');
    await clickSoft(SELECTORS.apkPlayground).catch(() => {});
    await wait(1200);
    await clickSoft(SELECTORS.apkFindings).catch(() => {});
    await clickSoft(SELECTORS.aiOpen).catch(() => {});
  });

  // ── Act 6: decode the live WebSocket ────────────────────────────────────
  await beat(6, 'Decoding the live WebSocket', 'Telemetry frames, structured in the panel', async () => {
    await goPane('/ui/network?pane=traffic');
    await trafficRow('/telemetry').first().click().catch(() => {});
  });

  await clearCaption(page);
  await wait(1500);
}
