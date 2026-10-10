import { eq, and } from 'drizzle-orm';
import type { AppDatabase } from '../../db/index';
import { aiPipelineRuns, aiPipelineNodeRuns, settings } from '../../db/schema';
import { runPipeline, type NodeExecutors, type ExecutionCtx, type RunResult } from './pipeline-runner';
import type { PipelineGraph } from './types';
import { createLoggers } from '../../logs';

const { log, error } = createLoggers('ai-jobs-run-executor');

export interface StartPipelineRunOptions {
  db: AppDatabase;
  pipelineVersionId: number;
  graph: PipelineGraph;
  triggerNodeId: string;
  input: Record<string, unknown>;
  reuseUnchanged?: boolean;
  triggeredBy: 'manual' | 'apk-analysis-complete';
  executors: NodeExecutors;
  /**
   * A thunk, not a pre-built ctx — called AFTER the 'running' row is inserted, inside the same
   * try/catch that wraps `runPipeline` itself. A synchronous throw from this (e.g. a bad input)
   * is caught exactly like a `runPipeline` rejection and marks the run 'failed', so there is
   * always a row to retry against. Building ctx as an argument expression BEFORE calling this
   * function (the REST handler's original design) meant a throw there happened before any row
   * existed — nothing to mark failed, and (now that execution is async) no HTTP-level signal
   * either, since the response has often already gone out by the time ctx would be needed.
   */
  buildCtx: () => ExecutionCtx;
  /** Fires once the run settles, success or failure, with the full result (nodes: [] on a crash
   * before `runPipeline` ever returned one; `crashError` then carries the thrown message, so a
   * caller writing a failure note can say why instead of a bare "failed"). Both callers use this to drive their own
   * broadcast/failure-note side effects — this module has no opinion on what a "pipeline run
   * finishing" should visibly do. Called exactly once, after the DB row is already final; a throw
   * from it is logged and never re-marks the run or calls it a second time. */
  onSettled?: (result: RunResult, crashError?: string) => void;
}

export type StartPipelineRunResult =
  | { ok: true; runId: number }
  | { ok: false; error: string; alreadyRunningRunId: number };

/**
 * Starts a pipeline run and returns immediately with its runId; the real execution happens in
 * the background. Shared by the REST /run endpoint and apk-analyzer.ts's production trigger
 * paths specifically so a REST-triggered run and an auto-triggered run can never race on the
 * same pipeline version — found in the final whole-branch review: before this function existed,
 * REST runs lived entirely in `ai_pipeline_runs` while apk-analyzer.ts's own auto/manual runs had
 * no DB record at all, so the two paths had no way to even notice they were racing on the same
 * note.
 *
 * The concurrency guard keys on `pipelineVersionId` alone, matching the REST endpoint's original
 * (already-shipped, already-reviewed) behavior — it does NOT distinguish which real-world input
 * (e.g. which APK version) a run is for, so two runs of the same pipeline VERSION against two
 * DIFFERENT inputs will also 409 each other. Narrower, input-aware concurrency is real, valuable
 * follow-up work — not done here; see the plan's Open Questions.
 *
 * The check-then-insert below is race-free without a transaction: better-sqlite3 is synchronous
 * and nothing between the SELECT and the INSERT yields the event loop, so no other caller can
 * interleave.
 */
export function startPipelineRun(opts: StartPipelineRunOptions): StartPipelineRunResult {
  const { db, pipelineVersionId, graph, triggerNodeId, input, reuseUnchanged, triggeredBy, executors, buildCtx, onSettled } = opts;

  const alreadyRunning = db.select().from(aiPipelineRuns)
    .where(and(eq(aiPipelineRuns.pipelineVersionId, pipelineVersionId), eq(aiPipelineRuns.status, 'running')))
    .all()[0];
  if (alreadyRunning) {
    return { ok: false, error: `A run is already running for this pipeline version (run ${alreadyRunning.id})`, alreadyRunningRunId: alreadyRunning.id };
  }

  const now = new Date();
  const runId = db.insert(aiPipelineRuns).values({
    pipelineVersionId, triggerNodeId, triggeredBy,
    input, reuseUnchanged: !!reuseUnchanged, status: 'running', startedAt: now,
  }).run().lastInsertRowid as number;

  let priorNodeRuns: Record<string, { inputHash: string; output: Record<string, unknown> }> | undefined;
  if (reuseUnchanged) {
    priorNodeRuns = {};
    // Ascending by id, so a later (more recent) run's node output always overwrites an earlier
    // one's in the loop below — relying on unordered default row-scan order isn't a guaranteed
    // contract, so order explicitly.
    const priorRuns = db.select().from(aiPipelineRuns).where(eq(aiPipelineRuns.pipelineVersionId, pipelineVersionId)).orderBy(aiPipelineRuns.id).all();
    for (const priorRun of priorRuns) {
      const priorNodes = db.select().from(aiPipelineNodeRuns)
        .where(and(eq(aiPipelineNodeRuns.runId, priorRun.id), eq(aiPipelineNodeRuns.status, 'ok')))
        .all();
      for (const nr of priorNodes) {
        if (nr.inputHash && nr.output) priorNodeRuns[nr.nodeId] = { inputHash: nr.inputHash, output: nr.output };
      }
    }
  }

  // Fire-and-forget: the caller gets runId back immediately. Found in the final review that the
  // client's REST timeout (30s, packages/plugin-sdk/src/react/hooks/useWebSocketManager.ts:200)
  // is far shorter than a real multi-AgentCall run (minutes) — awaiting runPipeline inline before
  // responding (the original design) made every real run time out client-side while the server
  // kept going, leaving the client with no runId and the UI permanently wedged on "Running…".
  void (async () => {
    let settled: RunResult;
    let crashError: string | undefined;
    try {
      const ctx = buildCtx();
      const result = await runPipeline(graph, triggerNodeId, input, executors, ctx, { reuseUnchanged, priorNodeRuns });
      const finishedAt = new Date();
      for (const nodeResult of result.nodes) {
        db.insert(aiPipelineNodeRuns).values({
          runId, nodeId: nodeResult.nodeId, status: nodeResult.status,
          output: nodeResult.output, error: nodeResult.error,
          // inputHash must be persisted, not just wasMemoized: the priorNodeRuns loader above
          // filters on `nr.inputHash && nr.output`, so without it memoization can never fire.
          inputHash: nodeResult.inputHash, wasMemoized: !!nodeResult.wasMemoized,
          startedAt: now, finishedAt,
        }).run();
      }
      db.update(aiPipelineRuns).set({ status: result.status, finishedAt }).where(eq(aiPipelineRuns.id, runId)).run();
      settled = result;
    } catch (err) {
      // Any throw between inserting the 'running' row and finalizing it (buildCtx, runPipeline,
      // a node-run insert) must still leave the row terminal — otherwise the guard above 409s
      // every later run of this version forever.
      crashError = err instanceof Error ? err.message : String(err);
      error(`Pipeline run ${runId} crashed: ${crashError}`);
      db.update(aiPipelineRuns).set({ status: 'failed', finishedAt: new Date() }).where(eq(aiPipelineRuns.id, runId)).run();
      settled = { status: 'failed', nodes: [] };
    }
    // Outside the try on purpose: a throw from the caller's own side-effect callback must not
    // re-mark an already-'ok' run as 'failed', nor call onSettled a second time.
    try {
      onSettled?.(settled, crashError);
    } catch (err) {
      error(`Pipeline run ${runId} onSettled callback threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  return { ok: true, runId };
}

/**
 * Marks every run left 'running' at boot as 'failed' — mirrors `ApkAnalyzer.resetRunningJobs()`
 * (backend/services/apk-analyzer.ts). Without this, a server restart mid-run (routine during
 * development, and a real risk in production) leaves that pipeline version's row 'running'
 * forever, since nothing else ever transitions it out of that state — every later `/run` for that
 * version 409s permanently until someone edits the DB directly.
 */
export function resetRunningPipelineRuns(db: AppDatabase): void {
  db.update(aiPipelineRuns).set({ status: 'failed', finishedAt: new Date() })
    .where(eq(aiPipelineRuns.status, 'running')).run();
  log('Reset all running pipeline runs to failed');
}

/** Reads the `ai_pipelines_enabled` setting row. Shared so `apk-analyzer.ts`'s
 * `setPipelinesEnabled` closure and the REST `/run` endpoint's gate read the exact same thing
 * instead of two copies of the same query. A missing row means disabled. */
export function isPipelinesEnabled(db: AppDatabase): boolean {
  const row = db.select().from(settings).where(eq(settings.key, 'ai_pipelines_enabled')).all()[0];
  return row?.value === 'true';
}
