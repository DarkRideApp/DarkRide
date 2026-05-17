#!/usr/bin/env node
/**
 * Generates changelog.json from git history for production deployments
 * where .git is not available. Run locally before deploying.
 *
 * Usage: node scripts/generate-changelog.js
 *
 * The Ansible deploy task runs this before rsync so the file is included
 * in the deployment bundle. The backend reads it from process.cwd().
 */
const { execFileSync } = require('child_process');
const { writeFileSync } = require('fs');
const { join } = require('path');

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const GIT_FORMAT = ['%H', '%h', '%s', '%b', '%an', '%aI'].join(FIELD_SEP) + RECORD_SEP;
const MAX_COMMITS = 500;

const rootDir = join(__dirname, '..');

const countOut = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: rootDir, encoding: 'utf-8' });
const total = parseInt(countOut.trim(), 10) || 0;

const stdout = execFileSync('git', [
  'log',
  `--format=${GIT_FORMAT}`,
  `-n`, String(MAX_COMMITS),
], { cwd: rootDir, encoding: 'utf-8' });

const commits = stdout
  .split(RECORD_SEP)
  .filter((record) => record.trim())
  .map((record) => {
    const fields = record.trim().split(FIELD_SEP);
    return {
      hash: fields[0] || '',
      shortHash: fields[1] || '',
      title: fields[2] || '',
      body: (fields[3] || '').trim(),
      author: fields[4] || '',
      date: fields[5] || '',
    };
  });

const outPath = join(rootDir, 'changelog.json');
writeFileSync(outPath, JSON.stringify({ total, commits }, null, 2));
console.log(`Generated changelog.json with ${commits.length} commits (${total} total)`);
