#!/usr/bin/env node
/**
 * Generic demo recorder. Launches Chromium, runs a scenario module against a
 * (typically local) DarkRide instance, and saves a webm. Pair with to-gif.sh
 * to produce the mp4 + optimized GIF.
 *
 *   node demo/record.mjs --scenario demo/scenarios/hero-allsafe.mjs \
 *     --base-url http://localhost:5173 --out demo/out --name hero
 *
 * Flags:
 *   --scenario <path>   scenario module (default: demo/scenarios/smoke.mjs)
 *   --base-url <url>     DarkRide web URL the scenario navigates (default about:blank)
 *   --out <dir>          output dir (default: demo/out)
 *   --name <basename>    output basename (default: scenario file name)
 *   --width/--height     viewport (default 1280x800)
 *   --headed             run headed (watch it live)
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const scenarioPath = arg('scenario', 'demo/scenarios/smoke.mjs');
const baseURL = arg('base-url', 'about:blank');
const outDir = arg('out', 'demo/out');
const width = Number(arg('width', 1280));
const height = Number(arg('height', 800));
const headed = !!arg('headed', false);
const name = arg('name', path.basename(scenarioPath).replace(/\.mjs$/, ''));

mkdirSync(outDir, { recursive: true });

const scenario = (await import(pathToFileURL(path.resolve(scenarioPath)).href)).default;
if (typeof scenario !== 'function') {
  console.error(`Scenario ${scenarioPath} must export default async (page, ctx) => {}`);
  process.exit(1);
}

const browser = await chromium.launch({ headless: !headed });
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2, // crisp capture
  recordVideo: { dir: outDir, size: { width, height } },
});
const page = await context.newPage();
const video = page.video();

let failed = false;
try {
  await scenario(page, { baseURL, width, height });
} catch (err) {
  failed = true;
  console.error('Scenario failed:', err?.message ?? err);
} finally {
  await context.close(); // finalizes the webm
  const webm = path.join(outDir, `${name}.webm`);
  if (video) { await video.saveAs(webm); await video.delete().catch(() => {}); console.log(`\n▶ recorded ${webm}`); }
  await browser.close();
}
process.exit(failed ? 1 : 0);
