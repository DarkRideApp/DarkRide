import { and, eq, like } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { apkDiffReports } from '../db/schema';
import { computeVersionAvailability } from './apk-availability';
import { createLoggers } from '../logs';

const { log } = createLoggers('apk-diff-backfill');

/**
 * One-time rollout task: convert previously-failed diffs whose sides are now
 * restorable (cloud or needs-reanalyze) into the new `skipped` status, so the
 * UI can surface a Restore button instead of a dead-end "failed" card.
 *
 * Idempotent: second run is a no-op because matched rows have already moved out
 * of `status = 'failed'`.
 */
export function backfillFailedDiffs(db: BetterSQLite3Database<any>): number {
  const candidates = db
    .select()
    .from(apkDiffReports)
    .where(
      and(
        eq(apkDiffReports.status, 'failed'),
        like(apkDiffReports.error, '%Analysis database not available%'),
      ),
    )
    .all();

  let changed = 0;
  const restorable = (s: string) => s === 'cloud' || s === 'needs-reanalyze' || s === 'local';
  for (const report of candidates) {
    try {
      const newAvail = computeVersionAvailability(db, report.apkVersionId);
      const oldAvail = computeVersionAvailability(db, report.compareVersionId);
      if (!restorable(newAvail.state) || !restorable(oldAvail.state)) continue;

      const sides: string[] = [];
      if (newAvail.state !== 'local') sides.push(`new version (${newAvail.state})`);
      if (oldAvail.state !== 'local') sides.push(`old version (${oldAvail.state})`);
      const reason =
        sides.length > 0
          ? `${sides.join(' and ')} not local; restore before running`
          : 'restorable after retention fix';

      db.update(apkDiffReports)
        .set({
          status: 'skipped',
          error: reason,
        })
        .where(eq(apkDiffReports.id, report.id))
        .run();
      changed++;
    } catch (e) {
      // Version not found or other problem — leave the report alone
    }
  }
  if (changed > 0) log(`Backfilled ${changed} failed diffs to skipped status`);
  return changed;
}
