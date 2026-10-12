/**
 * Human-readable explanation for a node's run outcome, shared by Canvas's hover tooltip and
 * SidePanel's "Last run" block so the wording can't drift between the two. `skipped` carries no
 * error of its own (backend/services/ai-jobs/pipeline-runner.ts:179) — the real message lives on
 * whichever upstream node actually failed.
 */
export function runStatusMessage(status: string, error?: string): string {
  if (status === 'cached') return 'Reused from a previous run.';
  if (status === 'ok') return 'Succeeded.';
  if (status === 'failed') return error ?? 'Failed.';
  if (status === 'skipped') return 'Skipped — an upstream node failed.';
  if (status === 'inactive') return 'Not part of this run.';
  return status;
}

/** `wasMemoized` overrides the underlying status for display purposes — same rule Canvas's statusFor uses. */
export function displayRunStatus(entry: { status: string; wasMemoized?: boolean }): string {
  return entry.wasMemoized ? 'cached' : entry.status;
}
