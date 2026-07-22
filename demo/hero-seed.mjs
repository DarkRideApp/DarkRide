#!/usr/bin/env node
/**
 * Seed a fresh DarkRide with curated, on-brand hero traffic so a recording
 * shows clean Playground data instead of your local test captures.
 *
 *   node demo/hero-seed.mjs --api http://localhost:3399 --user hero --pass hero-demo-pass
 *
 * Logs in via the API (cookie + CSRF handled by Playwright's request context),
 * then POSTs a realistic Playground session to /v1/traffic/ingest.
 */
import { request } from 'playwright';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const api = arg('api', 'http://localhost:3399');
const user = arg('user', 'hero');
const pass = arg('pass', 'hero-demo-pass');
const HOST = 'https://play-api.darkride.app';
const UA = 'Playground/1.0 (Android 14; Pixel 8)';

const j = (o) => JSON.stringify(o);
const H = { 'content-type': 'application/json', 'user-agent': UA };

// A believable Playground session, newest last (ingest order = capture order).
const ROWS = [
  { request: { method: 'POST', url: `${HOST}/login`, headers: { ...H }, body: j({ username: 'demo', password: 'demo' }) },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: j({ token: 'eyJhbGciOiJIUzI1NiJ9.demo.sig', flag: 'DR{captured-the-login}' }) } },
  { request: { method: 'GET', url: `${HOST}/profile`, headers: { ...H, authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo.sig' } },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: j({ username: 'demo', displayName: 'Demo User', email: 'demo@playground.darkride.app', apiKey: 'pk_live_playground_DEMO_do_not_ship_this' }) } },
  { request: { method: 'GET', url: `${HOST}/feed`, headers: { ...H, authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo.sig' } },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: j({ items: [{ id: 1, title: 'Welcome to the Playground' }, { id: 2, title: 'Try intercepting this call' }, { id: 3, title: 'Analyse the APK' }] }) } },
  { request: { method: 'GET', url: `${HOST}/feed`, headers: { ...H } },
    response: { status: 401, headers: { 'content-type': 'application/json' }, body: j({ error: 'unauthorized' }) } },
  { request: { method: 'GET', url: `${HOST}/profile`, headers: { ...H, authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.demo.sig' } },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: j({ username: 'demo', displayName: 'Demo User', email: 'demo@playground.darkride.app', apiKey: 'pk_live_playground_DEMO_do_not_ship_this' }) } },
];

const ctx = await request.newContext({ baseURL: api, extraHTTPHeaders: {} });
const login = await ctx.post('/v1/auth/login', { data: { providerId: 'core.local', credentials: { username: user, password: pass } } });
const loginBody = await login.json();
if (!loginBody.success) { console.error(`Login failed for ${user}: ${loginBody.error || login.status()}`); process.exit(1); }
const csrf = loginBody.csrfToken;

let ok = 0;
for (const row of ROWS) {
  const res = await ctx.post('/v1/traffic/ingest', { headers: { 'X-CSRF-Token': csrf }, data: row });
  if (res.ok()) ok++; else console.error(`ingest failed (${res.status()}): ${row.request.method} ${row.request.url}`);
}
await ctx.dispose();
console.log(`✔ seeded ${ok}/${ROWS.length} hero traffic rows into ${api}`);
process.exit(ok === ROWS.length ? 0 : 1);
