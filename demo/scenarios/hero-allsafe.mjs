/**
 * HERO scenario — DarkRide vs Allsafe.
 *
 * REQUIRES a full live stack (this cannot run in a disk-constrained sandbox):
 *   - DarkRide backend + frontend running (pass its URL via --base-url)
 *   - A booted Android emulator connected to DarkRide (docker-android or a
 *     local AVD; needs KVM + an Android system image ~2-4GB)
 *   - Allsafe installed on it:  adb install demo/assets/allsafe.apk
 *     (run demo/fetch-allsafe.sh first to download the APK)
 *
 * Allsafe is a Frida / cert-pinning / APK-analysis target — it barely
 * generates network traffic — so this hero leans on APK analysis + a Frida
 * cert-pinning bypass (DarkRide's script library), NOT live capture. For a
 * traffic-heavy hero, build the "DarkRide Playground" target instead.
 *
 * Selectors below are best-effort from the app's data-testids; VERIFY them on
 * the first real run and adjust. Storyboard beats are numbered so you can trim
 * to a tight ~25-35s clip.
 */
export default async function heroAllsafe(page, { baseURL }) {
  const step = async (label, fn) => { console.log(`  • ${label}`); await fn(); await page.waitForTimeout(1200); };

  await page.goto(baseURL, { waitUntil: 'networkidle' });

  // 1. Land on the device workspace with the emulator already connected.
  await step('open Devices — emulator online', async () => {
    await page.goto(`${baseURL}/ui/devices`, { waitUntil: 'networkidle' });
    // TODO(verify): a device card for the emulator should be visible.
  });

  // 2. APK analysis — DarkRide decompiles Allsafe and surfaces findings.
  await step('APK analysis: Allsafe findings + hardcoded secrets', async () => {
    await page.goto(`${baseURL}/ui/apks`, { waitUntil: 'networkidle' });
    // TODO(verify): open the Allsafe entry -> analysis -> security findings tab.
  });

  // 3. AI reads the analysis (the MCP / agent angle — the differentiator).
  await step('ask the AI agent to summarise the risks', async () => {
    // TODO(verify): open the AI chat drawer, send a prompt, let the reply stream.
  });

  // 4. Frida — defeat Allsafe's certificate pinning with a built-in script.
  await step('Frida: bypass Allsafe certificate pinning', async () => {
    await page.goto(`${baseURL}/ui/frida`, { waitUntil: 'networkidle' });
    // TODO(verify): pick the cert-pinning-bypass script, target Allsafe, run it.
  });

  // 5. Network — the previously-pinned request now shows up in the workspace.
  await step('Network: the request that pinning used to hide', async () => {
    await page.goto(`${baseURL}/ui/network`, { waitUntil: 'networkidle' });
    // TODO(verify): trigger Allsafe's pinned call on the device; show the row +
    // open its detail. (Drive the device via DarkRide's remote control.)
  });

  await page.waitForTimeout(1500);
}
