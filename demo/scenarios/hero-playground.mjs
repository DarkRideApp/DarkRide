/**
 * HERO scenario — DarkRide vs the DarkRide Playground target.
 *
 * The Playground (DarkRideApp/playground) is purpose-built so every beat has a
 * clean, branded, repeatable payoff — unlike Allsafe, which has no real traffic.
 * This is the intended hero once the Playground APK is published.
 *
 * REQUIRES a full live stack (not runnable in a disk-constrained sandbox):
 *   - DarkRide backend + frontend running (pass its URL via --base-url)
 *   - An emulator connected to DarkRide with the Playground installed:
 *       demo/fetch-playground.sh && adb install demo/assets/playground.apk
 *   - The Playground API deployed (play-api.darkride.app) or `wrangler dev`.
 *
 * Beats (each exposes a DR{...} flag from the app/API):
 *   1. Login demo/demo -> token appears in Traffic                (capture)
 *   2. /profile is cert-pinned -> Frida pin-bypass -> it appears  (Frida)
 *   3. APK analysis: hardcoded API key + AI summary               (APK analysis)
 *   4. Root/emulator gate -> Frida detection-bypass               (Frida)
 *   5. Insecure token in SharedPrefs -> data-extraction           (data extraction)
 *   6. WebSocket /telemetry frames decode in the frames panel     (decoders)
 *
 * Selectors are best-effort from data-testids; verify on the first real run.
 */
export default async function heroPlayground(page, { baseURL }) {
  const step = async (label, fn) => { console.log(`  • ${label}`); await fn(); await page.waitForTimeout(1200); };

  await page.goto(baseURL, { waitUntil: 'networkidle' });

  await step('open the Network workspace — capture armed', async () => {
    await page.goto(`${baseURL}/ui/network`, { waitUntil: 'networkidle' });
  });

  await step('capture the demo/demo login token', async () => {
    // TODO(verify): drive the Playground login on the device; the POST /login
    // row + its bearer-token response appear in the Traffic pane.
  });

  await step('bypass the cert pin on /profile with Frida', async () => {
    await page.goto(`${baseURL}/ui/frida`, { waitUntil: 'networkidle' });
    // TODO(verify): run the cert-pinning-bypass script against the Playground;
    // the previously-hidden /profile call now shows in Traffic.
  });

  await step('APK analysis: the hardcoded API key + AI summary', async () => {
    await page.goto(`${baseURL}/ui/apks`, { waitUntil: 'networkidle' });
    // TODO(verify): open the Playground APK -> findings -> HARDCODED_API_KEY;
    // ask the AI agent to summarise.
  });

  await step('decode the telemetry WebSocket', async () => {
    await page.goto(`${baseURL}/ui/network?pane=traffic`, { waitUntil: 'networkidle' });
    // TODO(verify): select the /telemetry WS row; frames render in the panel.
  });

  await page.waitForTimeout(1500);
}
