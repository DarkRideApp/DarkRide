import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtemp, rm, readdir, stat } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';
import { importSessionZip } from './session-import';
import * as schema from '../db/schema';

function makeDb() {
  const sqlite = new Database(':memory:');
  // Minimal schema for what session-import touches: automation_sessions,
  // screenshots, devices, captured_traffic, websocket_messages.
  sqlite.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE automation_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER,
      device_id TEXT,
      name TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      logs TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL,
      -- Managed-automations denormalisation (migration 0093) — keep in sync with schema.ts
      managed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      name TEXT,
      dom_snapshot TEXT,
      captured_at INTEGER NOT NULL
    );
    CREATE TABLE captured_traffic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      device_id TEXT,
      timestamp INTEGER,
      method TEXT,
      url TEXT,
      host TEXT,
      path TEXT,
      status_code INTEGER,
      request_headers TEXT,
      request_body TEXT,
      response_headers TEXT,
      response_body TEXT,
      response_size INTEGER
    );
    CREATE TABLE websocket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      traffic_id INTEGER,
      session_id INTEGER,
      direction TEXT,
      opcode INTEGER,
      payload TEXT,
      timestamp INTEGER
    );
  `);
  return drizzle(sqlite, { schema });
}

describe('importSessionZip', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'session-import-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('imports clean screenshots without issue', async () => {
    const screenshotPath = join(tmpDir, 'session-screenshots');
    const zip = new AdmZip();
    zip.addFile('screenshots/a.png', Buffer.from('PNG-bytes-a'));
    zip.addFile('screenshots/b.png', Buffer.from('PNG-bytes-b'));

    const db = makeDb();
    const result = await importSessionZip(db as any, zip.toBuffer(), screenshotPath);

    expect(result.screenshotCount).toBe(2);
    const written = (await readdir(screenshotPath)).sort();
    expect(written).toEqual(['a.png', 'b.png']);
  });

  it('rejects screenshot entries with path-traversal (zipslip)', async () => {
    const screenshotPath = join(tmpDir, 'session-screenshots');
    const escapeMarker = join(tmpDir, 'escape-marker.png');

    // adm-zip normalises '..' at addFile time, so to construct a realistic
    // malicious zip (the kind `zip --symlinks` or a hand-crafted attacker
    // produces) we mutate entryName after the fact.
    const zip = new AdmZip();
    zip.addFile('screenshots/placeholder.png', Buffer.from('OWNED'));
    zip.getEntries()[0].entryName = 'screenshots/../escape-marker.png';

    const db = makeDb();
    await expect(
      importSessionZip(db as any, zip.toBuffer(), screenshotPath),
    ).rejects.toThrow(/outside/i);

    // Critical assertion: no file landed outside screenshotPath.
    await expect(stat(escapeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects screenshot entries containing nested ../ sequences', async () => {
    const screenshotPath = join(tmpDir, 'session-screenshots');
    const escapeMarker = join(dirname(tmpDir), 'far-escape.png');

    const zip = new AdmZip();
    zip.addFile('screenshots/placeholder.png', Buffer.from('FAR-OWNED'));
    zip.getEntries()[0].entryName = 'screenshots/a/../../far-escape.png';

    const db = makeDb();
    await expect(
      importSessionZip(db as any, zip.toBuffer(), screenshotPath),
    ).rejects.toThrow(/outside/i);

    await expect(stat(escapeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
