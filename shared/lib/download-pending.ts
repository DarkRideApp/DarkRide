/**
 * Stored in `app_sources.last_error` when a version was recorded but its APK has
 * not been tried yet. It is a status, not a failure: the next scheduled check
 * replaces it with the download's outcome.
 *
 * `last_error` is the only place this state lives (no schema change), so anything
 * that shows `lastError` must check {@link isDownloadPendingNote} first and draw
 * this as pending, not as an error. The backend writes it
 * (backend/services/apk-tracker.ts, `isDownloadOwed`; backend/api/apps.ts, the
 * sources/check probe) and the app page reads it (frontend/pages/AppDetail.tsx).
 * Both import it from here so there is one spelling of it.
 */
export const DOWNLOAD_PENDING_NOTE = 'APK not downloaded yet';

/** True when a source's `lastError` is the pending marker rather than a real error. */
export function isDownloadPendingNote(lastError: string | null | undefined): boolean {
  return lastError === DOWNLOAD_PENDING_NOTE;
}
