import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect } from 'vitest';
import * as schema from '../../../db/schema';
import { runSink } from './sink';
import { getNote, setNote } from '../../apk-notes';

function makeDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE tracked_apps (id INTEGER PRIMARY KEY, package_name TEXT NOT NULL, app_name TEXT, auto_analyse INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE apk_versions (id INTEGER PRIMARY KEY, tracked_app_id INTEGER NOT NULL, version_code INTEGER NOT NULL, version_name TEXT, filename TEXT NOT NULL, file_size INTEGER, device_id TEXT, source TEXT DEFAULT 'device', downloaded_at INTEGER NOT NULL);
    CREATE TABLE apk_notes (version_id INTEGER PRIMARY KEY REFERENCES apk_versions(id) ON DELETE CASCADE, content TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
  `);
  const db = drizzle(sqlite, { schema });
  db.insert(schema.trackedApps).values({ id: 1, packageName: 'x', createdAt: new Date() }).run();
  db.insert(schema.apkVersions).values({ id: 431, trackedAppId: 1, versionCode: 1, filename: 'x.apk', downloadedAt: new Date() }).run();
  return db;
}

// Every node's input is wrapped by source-node-id, even with exactly one incoming edge —
// Tasks 13-17 establish this for the whole executor (e.g. the linear-chain test's
// `{ trigger: { appName: 'x', versionId: 431 } }`). The plan's first draft of this task had
// write-full-document/write-section read `input.markdown`/`input.section` directly, which
// would read `undefined` through the real executor and write the literal string "undefined"
// into the note on every run — caught in the SDD pre-flight scan before this task was
// dispatched. config.from names which predecessor's output to unwrap first, same convention
// as Report's sections[].from; these tests use the real wrapped shape throughout.
describe('runSink', () => {
  it('apk-analysis/write-full-document writes each Report section into the note', async () => {
    const db = makeDb();
    await runSink(
      { writeFn: 'apk-analysis/write-full-document', from: 'report' },
      { report: { markdown: '## Overview\nHello.\n\n## Maps\nTiles.\n', sections: [
        { title: 'Overview', body: 'Hello.' },
        { title: 'Maps', body: 'Tiles.' },
      ] } },
      { db, versionId: 431 },
    );
    expect(getNote(db, 431)).toBe('## Overview\nHello.\n## Maps\nTiles.\n');
  });

  it('write-full-document keeps sections it does not own, e.g. a prior Quick Rescan Diff Summary (I1)', async () => {
    // Regression guard: this sink used to setNote() the whole Report markdown, wiping the Quick
    // Rescan zone's Diff Summary and any hand-written section every time Full Analysis ran.
    const db = makeDb();
    setNote(db, 431, '## Diff Summary\nNew endpoint /v2/waits.\n\n## My Notes\nChecked by hand.\n\n## Overview\nStale overview.\n');
    await runSink(
      { writeFn: 'apk-analysis/write-full-document', from: 'report' },
      { report: { markdown: 'ignored', sections: [
        { title: 'Overview', body: 'Fresh overview.' },
        { title: 'Wait Times', body: 'Polls /waits.' },
      ] } },
      { db, versionId: 431 },
    );
    const note = getNote(db, 431);
    expect(note).toContain('## Diff Summary\nNew endpoint /v2/waits.');
    expect(note).toContain('## My Notes\nChecked by hand.');
    expect(note).toContain('## Overview\nFresh overview.');
    expect(note).not.toContain('Stale overview.');
    expect(note).toContain('## Wait Times\nPolls /waits.');
  });

  it('apk-analysis/write-section patches just one section, leaving others untouched', async () => {
    const db = makeDb();
    await runSink(
      { writeFn: 'apk-analysis/write-full-document', from: 'report' },
      { report: { sections: [{ title: 'Overview', body: 'Old.' }, { title: 'Diff Summary', body: 'Old diff.' }] } },
      { db, versionId: 431 },
    );
    await runSink(
      { writeFn: 'apk-analysis/write-section', from: 'agent-diff', section: 'Diff Summary' },
      { 'agent-diff': { text: 'New diff.' } },
      { db, versionId: 431 },
    );
    const note = getNote(db, 431);
    expect(note).toContain('## Overview\nOld.');
    expect(note).toContain('## Diff Summary\nNew diff.');
  });

  it('throws (not an unhandled rejection) when the target version does not exist', async () => {
    const db = makeDb();
    await expect(
      runSink({ writeFn: 'apk-analysis/write-full-document', from: 'report' }, { report: { sections: [{ title: 'x', body: 'y' }] } }, { db, versionId: 999999 }),
    ).rejects.toThrow();
  });

  it('throws on an unregistered writeFn name', async () => {
    const db = makeDb();
    await expect(runSink({ writeFn: 'nope' }, {}, { db, versionId: 431 })).rejects.toThrow(/Unknown sink/);
  });

  it('treats an inherited Object.prototype key as unregistered rather than resolving it', async () => {
    const db = makeDb();
    await expect(runSink({ writeFn: 'constructor' }, {}, { db, versionId: 431 })).rejects.toThrow(/Unknown sink "constructor"/);
  });

  it('write-full-document writes nothing (and never the literal text "undefined") when "from" is omitted or its source has no sections', async () => {
    const db = makeDb();
    setNote(db, 431, '## Diff Summary\nKeep me.\n');
    await runSink({ writeFn: 'apk-analysis/write-full-document' }, {}, { db, versionId: 431 });
    await runSink({ writeFn: 'apk-analysis/write-full-document', from: 'report' }, { report: { markdown: 'x' } }, { db, versionId: 431 });
    expect(getNote(db, 431)).toBe('## Diff Summary\nKeep me.\n');
  });
});
