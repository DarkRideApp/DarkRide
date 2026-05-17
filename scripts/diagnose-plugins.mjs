#!/usr/bin/env node
/**
 * Dump the current plugin state across all layers to help diagnose
 * "plugin shows old version / missing nav / page redirects" issues.
 *
 * Output sections:
 *   1. plugin_state rows (DB authority for what UI sees)
 *   2. plugin_installs rows (replay/recovery source)
 *   3. data/installed-plugins/ disk state
 *   4. For each managed plugin dir: package.json#version, dist/ presence
 *
 * Run from repo root:
 *   node scripts/diagnose-plugins.mjs
 *
 * Honours DATABASE_PATH and DATA_ROOT env vars; falls back to defaults.
 */

import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DB_PATH = process.env.DATABASE_PATH || './data/darkride.db';
const DATA_ROOT = process.env.DATA_ROOT || './data';
const MANAGED_ROOT = join(DATA_ROOT, 'installed-plugins');
const NM = join(MANAGED_ROOT, 'node_modules');

console.log(`DATABASE_PATH = ${DB_PATH}`);
console.log(`MANAGED_ROOT  = ${MANAGED_ROOT}\n`);

if (!existsSync(DB_PATH)) {
  console.error(`DB not found at ${DB_PATH} — adjust DATABASE_PATH and retry.`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

console.log('=== plugin_state (UI source of truth) ===');
try {
  const rows = db.prepare(
    `SELECT name, enabled, installed_via, version, npm_package, updated_at FROM plugin_state ORDER BY name`,
  ).all();
  for (const r of rows) {
    console.log(`  ${r.name}  enabled=${r.enabled}  via=${r.installed_via}  version=${r.version || '(empty)'}  pkg=${r.npm_package ?? '-'}`);
  }
  if (rows.length === 0) console.log('  (no rows)');
} catch (e) { console.log(`  (query failed: ${e.message})`); }

console.log('\n=== plugin_installs (replay source) ===');
try {
  const rows = db.prepare(
    `SELECT name, npm_package, source_url, resolved_ref FROM plugin_installs ORDER BY name`,
  ).all();
  for (const r of rows) {
    console.log(`  ${r.name}  pkg=${r.npm_package}  url=${r.source_url}  ref=${r.resolved_ref ?? '-'}`);
  }
  if (rows.length === 0) console.log('  (no rows)');
} catch (e) { console.log(`  (query failed: ${e.message})`); }

console.log('\n=== plugin_migrations applied ===');
try {
  const rows = db.prepare(
    `SELECT plugin_name, COUNT(*) as n FROM plugin_migrations GROUP BY plugin_name ORDER BY plugin_name`,
  ).all();
  for (const r of rows) console.log(`  ${r.plugin_name}: ${r.n}`);
  if (rows.length === 0) console.log('  (none)');
} catch (e) { console.log(`  (query failed: ${e.message})`); }

console.log('\n=== data/installed-plugins/ disk state ===');
if (!existsSync(MANAGED_ROOT)) {
  console.log('  (managed root does not exist)');
} else {
  const pkg = join(MANAGED_ROOT, 'package.json');
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, 'utf-8'));
      console.log(`  managedRoot/package.json deps: ${JSON.stringify(j.dependencies || {}, null, 0)}`);
    } catch { console.log('  managedRoot/package.json: (parse failed)'); }
  } else {
    console.log('  managedRoot/package.json: MISSING');
  }
  if (!existsSync(NM)) {
    console.log('  node_modules/: MISSING');
  } else {
    for (const top of readdirSync(NM)) {
      if (top.startsWith('@')) {
        const scopeDir = join(NM, top);
        for (const sub of readdirSync(scopeDir)) {
          inspectPluginDir(join(scopeDir, sub), `${top}/${sub}`);
        }
      } else if (top.startsWith('darkride-plugin-')) {
        inspectPluginDir(join(NM, top), top);
      }
    }
  }
}

function inspectPluginDir(dir, name) {
  const pkgJson = join(dir, 'package.json');
  let version = '?', main = '?';
  if (existsSync(pkgJson)) {
    try {
      const j = JSON.parse(readFileSync(pkgJson, 'utf-8'));
      version = j.version ?? '?';
      main = j.main ?? '?';
    } catch {}
  }
  const distEntry = join(dir, 'dist', 'darkride-plugin.js');
  const rootEntry = join(dir, 'darkride-plugin.js');
  const frontend = join(dir, 'frontend', 'plugin.ts');
  const distSize = existsSync(distEntry) ? statSync(distEntry).size : null;
  const checks = [
    `dist/darkride-plugin.js: ${distSize !== null ? distSize + 'B' : 'MISSING'}`,
    `darkride-plugin.js (shim): ${existsSync(rootEntry) ? 'present' : 'absent'}`,
    `frontend/plugin.ts: ${existsSync(frontend) ? 'present' : 'absent'}`,
  ];
  console.log(`  ${name}  v${version}  main=${main}`);
  for (const c of checks) console.log(`    ${c}`);
}

db.close();
