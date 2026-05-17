#!/usr/bin/env node
/**
 * Copy non-TypeScript plugin assets from plugins/<name>/ to dist/plugins/<name>/.
 *
 * Why this exists: tsc only emits .js for .ts inputs. Plugin migrations (.sql),
 * config files (.json), and other static assets are not compiled — they need
 * to be copied verbatim to the output tree. Without this, dist/plugins/<name>/
 * contains the compiled plugin code but not its migrations, and the runtime
 * plugin migrator silently skips them.
 *
 * Runs as part of `npm run build`, after tsc, before vite.
 * Cross-platform (no shell-specific commands).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ASSET_PATTERNS = [
  /\.sql$/,           // migrations
  /\.json$/,          // configs, schemas, manifests
];

function shouldCopy(file) {
  return ASSET_PATTERNS.some((re) => re.test(file));
}

function copyTree(src, dst) {
  if (!fs.existsSync(src)) return 0;
  let count = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      // Skip __tests__ and node_modules — those are dev-only or duplicated by npm.
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      count += copyTree(srcPath, dstPath);
    } else if (entry.isFile() && shouldCopy(entry.name)) {
      fs.copyFileSync(srcPath, dstPath);
      count += 1;
    }
  }
  return count;
}

const PLUGINS_DIR = path.resolve('plugins');
const DIST_PLUGINS_DIR = path.resolve('dist/plugins');

if (!fs.existsSync(PLUGINS_DIR)) {
  console.log('No plugins/ directory found, skipping plugin asset copy.');
  process.exit(0);
}

let totalFiles = 0;
let plugins = 0;
for (const name of fs.readdirSync(PLUGINS_DIR)) {
  const src = path.join(PLUGINS_DIR, name);
  if (!fs.statSync(src).isDirectory()) continue;
  const dst = path.join(DIST_PLUGINS_DIR, name);
  const copied = copyTree(src, dst);
  if (copied > 0) {
    plugins += 1;
    totalFiles += copied;
  }
}

console.log(`Copied ${totalFiles} plugin asset(s) across ${plugins} plugin(s).`);
