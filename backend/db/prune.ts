import { lt, and, eq, not, notInArray, inArray, sql } from 'drizzle-orm';
import { unlink } from 'fs/promises';
import { existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { automationSessions, screenshots, capturedTraffic, websocketMessages, injectedApks, aiConversations, apiEndpointSessions, notificationHistory } from './schema';
import type { AppDatabase } from './index';
import { createLoggers } from '../logs';
import type { FileStorageService } from '../services/file-storage';
import { getDataRoot } from '../config/paths';

const { log } = createLoggers('prune');

export async function pruneOldData(
  db: AppDatabase,
  pruneDays: number,
  screenshotPath: string,
  fileSync?: FileStorageService,
): Promise<void> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - pruneDays);

  // Find pinned session IDs so we can exclude their related data
  const pinnedSessionIds = db
    .select({ id: automationSessions.id })
    .from(automationSessions)
    .where(eq(automationSessions.isPinned, true))
    .all()
    .map(s => s.id);

  // Build screenshot filter: old + not belonging to pinned sessions
  const screenshotConditions = pinnedSessionIds.length > 0
    ? and(lt(screenshots.capturedAt, cutoffDate), notInArray(screenshots.sessionId, pinnedSessionIds))
    : lt(screenshots.capturedAt, cutoffDate);

  // Get screenshots to delete from disk
  const oldScreenshots = db
    .select({ filename: screenshots.filename })
    .from(screenshots)
    .where(screenshotConditions)
    .all();

  // Delete screenshot files from disk and cloud
  for (const screenshot of oldScreenshots) {
    try {
      await unlink(join(screenshotPath, screenshot.filename));
    } catch {
      // File may already be deleted
    }

    // Clean up from cloud storage if tracked
    if (fileSync) {
      // Parse sessionId from filename pattern: {sessionId}_{timestamp}_{name}.png
      const match = screenshot.filename.match(/^(\d+)_/);
      if (match) {
        const cloudKey = `sessions/${match[1]}/${screenshot.filename}`;
        try {
          await fileSync.removeFile(cloudKey);
        } catch {
          // Ignore cloud cleanup errors
        }
      }
    }
  }

  // Build conditions for related tables
  const wsConditions = pinnedSessionIds.length > 0
    ? and(lt(websocketMessages.timestamp, cutoffDate), notInArray(websocketMessages.sessionId, pinnedSessionIds))
    : lt(websocketMessages.timestamp, cutoffDate);

  const trafficConditions = pinnedSessionIds.length > 0
    ? and(lt(capturedTraffic.capturedAt, cutoffDate), notInArray(capturedTraffic.sessionId, pinnedSessionIds))
    : lt(capturedTraffic.capturedAt, cutoffDate);

  // Delete from database in correct FK order:
  // 1. Screenshots (references sessions)
  db.delete(screenshots).where(screenshotConditions).run();

  // 2. WebSocket messages — delete by timestamp AND by referencing old traffic entries
  //    (WS messages can have a newer timestamp than the traffic entry they reference)
  db.delete(websocketMessages).where(wsConditions).run();

  // Also delete any remaining WS messages whose parent traffic entry is about to be deleted
  // (these have newer timestamps than the traffic but still reference it via FK)
  const trafficSubquery = db.select({ id: capturedTraffic.id }).from(capturedTraffic).where(trafficConditions);
  db.delete(websocketMessages).where(
    inArray(websocketMessages.trafficId, trafficSubquery),
  ).run();

  // 3. Captured traffic
  db.delete(capturedTraffic).where(trafficConditions).run();

  // Clean up API catalogue session links before deleting sessions
  const sessionConditions = pinnedSessionIds.length > 0
    ? and(lt(automationSessions.startedAt, cutoffDate), not(eq(automationSessions.isPinned, true)))
    : lt(automationSessions.startedAt, cutoffDate);
  const sessionIdsToDelete = db.select({ id: automationSessions.id })
    .from(automationSessions)
    .where(sessionConditions)
    .all()
    .map(s => s.id);
  for (const sid of sessionIdsToDelete) {
    db.delete(apiEndpointSessions).where(eq(apiEndpointSessions.sessionId, sid)).run();
  }

  // A child artifact with a newer timestamp than the cutoff survives the
  // time-window deletes above while its parent session is deleted by startedAt
  // (long-lived capture-rule sessions do exactly this). Mop up every remaining
  // child of the exact sessions being removed so the session delete below can't
  // trip foreign_keys=ON. Subquery form avoids the SQLite bound-variable limit.
  const deletedSessionCondition = and(lt(automationSessions.startedAt, cutoffDate), not(eq(automationSessions.isPinned, true)));
  const sessionsBeingDeleted = () => db.select({ id: automationSessions.id }).from(automationSessions).where(deletedSessionCondition);
  db.delete(screenshots).where(inArray(screenshots.sessionId, sessionsBeingDeleted())).run();
  db.delete(websocketMessages).where(inArray(websocketMessages.sessionId, sessionsBeingDeleted())).run();
  // A WS frame can carry sessionId=NULL (the capture context wasn't resolved at
  // frame time) yet still reference — via trafficId — a captured_traffic row
  // owned by a doomed session. The sessionId sweep above misses those, so delete
  // them by trafficId against the traffic about to go (mirroring the timestamp
  // path's safety net above) before removing the traffic they point at.
  const trafficBeingDeleted = db.select({ id: capturedTraffic.id }).from(capturedTraffic).where(inArray(capturedTraffic.sessionId, sessionsBeingDeleted()));
  db.delete(websocketMessages).where(inArray(websocketMessages.trafficId, trafficBeingDeleted)).run();
  db.delete(capturedTraffic).where(inArray(capturedTraffic.sessionId, sessionsBeingDeleted())).run();

  db.delete(automationSessions).where(deletedSessionCondition).run();

  // Prune old AI conversations
  db.delete(aiConversations).where(lt(aiConversations.updatedAt, cutoffDate)).run();

  // Prune old notification history
  db.delete(notificationHistory).where(lt(notificationHistory.createdAt, cutoffDate)).run();

  // Prune expired injected APKs (3-day TTL, independent of pruneDays)
  const injectedCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const expiredInjected = db.select().from(injectedApks)
    .where(lt(injectedApks.createdAt, injectedCutoff))
    .all();

  for (const row of expiredInjected) {
    const filePath = resolve(join(getDataRoot(), 'apks-injected'), row.filename);
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch {}
  }

  if (expiredInjected.length > 0) {
    db.delete(injectedApks).where(lt(injectedApks.createdAt, injectedCutoff)).run();
    log(`Pruned ${expiredInjected.length} expired injected APKs`);
  }
}

/**
 * Mark stale "running" sessions as failed.
 * When `staleMinutes` is 0, ALL running sessions are considered stale (used on startup
 * since nothing can legitimately be running when the server just started).
 * Otherwise, only sessions older than `staleMinutes` are cleaned.
 * Returns the number of sessions cleaned up.
 */
export function cleanStaleSessions(db: AppDatabase, staleMinutes: number = 30): number {
  const condition = staleMinutes === 0
    ? eq(automationSessions.status, 'running')
    : and(
        eq(automationSessions.status, 'running'),
        lt(automationSessions.startedAt, new Date(Date.now() - staleMinutes * 60 * 1000)),
      );

  const stale = db
    .select({ id: automationSessions.id })
    .from(automationSessions)
    .where(condition)
    .all();

  if (stale.length === 0) return 0;

  for (const session of stale) {
    db.update(automationSessions)
      .set({
        status: 'failed',
        completedAt: new Date(),
        logs: JSON.stringify([{
          timestamp: new Date().toISOString(),
          method: '__error__',
          params: {},
          error: 'Session marked as failed: stale running state (app crash or exit)',
          durationMs: 0,
        }]),
      })
      .where(eq(automationSessions.id, session.id))
      .run();
  }

  return stale.length;
}
