import fs from 'fs';
import path from 'path';
import { eq } from 'drizzle-orm';
import { apkNotes, apkVersions, trackedApps } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { getApkDir, analysisNotesPath } from '../utils/apk-paths';
import { createLoggers } from '../logs';

const { log, error } = createLoggers('apk-notes');

/** Returns the stored note content for a version, or empty string if none. */
export function getNote(db: AppDatabase, versionId: number): string {
  const row = db.select().from(apkNotes).where(eq(apkNotes.versionId, versionId)).all()[0];
  return row?.content ?? '';
}

/** Upsert a note for a version. */
export function setNote(db: AppDatabase, versionId: number, content: string): void {
  const now = new Date();
  const existing = db.select({ versionId: apkNotes.versionId }).from(apkNotes)
    .where(eq(apkNotes.versionId, versionId)).all()[0];
  if (existing) {
    db.update(apkNotes)
      .set({ content, updatedAt: now })
      .where(eq(apkNotes.versionId, versionId))
      .run();
  } else {
    db.insert(apkNotes).values({ versionId, content, updatedAt: now }).run();
  }
}

/**
 * Replace or insert a `## <section>` block in the note.
 * Mirrors the old file-based patch semantics so call-site swap is mechanical.
 */
export function patchNoteSection(
  db: AppDatabase,
  versionId: number,
  section: string,
  content: string,
): string {
  const existing = getNote(db, versionId);
  const header = `## ${section}`;
  const sectionRegex = new RegExp(
    `(^|\\n)${escapeRegex(header)}\\n[\\s\\S]*?(?=\\n## |$)`,
  );

  let updated: string;
  if (sectionRegex.test(existing)) {
    updated = existing.replace(sectionRegex, `$1${header}\n${content.trimEnd()}\n`);
  } else {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    updated = `${existing}${sep}${header}\n${content.trimEnd()}\n`;
  }

  setNote(db, versionId, updated);
  return updated;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One-time backfill: read any `notes.md` files still on disk into the DB.
 * Idempotent (primary key on versionId). Disk files are left in place as
 * a safety net — they'll be removed in a follow-up release.
 */
export function backfillNotesFromDisk(db: AppDatabase): void {
  const apkDir = getApkDir();
  if (!fs.existsSync(apkDir)) return;

  const apps = db.select({ id: trackedApps.id, packageName: trackedApps.packageName })
    .from(trackedApps).all();

  let imported = 0;
  let skipped = 0;

  for (const app of apps) {
    const versions = db.select().from(apkVersions)
      .where(eq(apkVersions.trackedAppId, app.id)).all();

    for (const version of versions) {
      const notesPath = analysisNotesPath(app.packageName, version.versionCode);
      if (!fs.existsSync(notesPath)) continue;

      const alreadyImported = db.select({ v: apkNotes.versionId }).from(apkNotes)
        .where(eq(apkNotes.versionId, version.id)).all()[0];
      if (alreadyImported) { skipped++; continue; }

      try {
        const content = fs.readFileSync(notesPath, 'utf-8');
        if (content.trim() === '') { skipped++; continue; }
        setNote(db, version.id, content);
        imported++;
      } catch (err: any) {
        error(`Failed to import notes for ${app.packageName} v${version.versionCode}: ${err.message}`);
      }
    }
  }

  if (imported > 0 || skipped > 0) {
    log(`Notes backfill complete — imported=${imported}, already-imported-or-empty=${skipped}`);
  }
}
