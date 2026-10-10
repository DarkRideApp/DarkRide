import { eq, and } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { aiPipelines, aiPipelineVersions, aiPipelineRuns, aiPipelineNodeRuns } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { validateGraph } from '../services/ai-jobs/graph-validator';
import type { NodeExecutors, ExecutionCtx } from '../services/ai-jobs/pipeline-runner';
import { startPipelineRun, type StartPipelineRunResult } from '../services/ai-jobs/run-executor';
import type { PipelineGraph } from '../services/ai-jobs/types';

export interface AiPipelineDeps {
  db: AppDatabase;
  executors: NodeExecutors;
  /** `identity` comes from the authenticated request (req.authUser), not a fixed core-service identity —
   * a manual run from the editor runs as the clicking user, same as `triggerAiAgentManual` does today. */
  buildCtx: (identity: { type: 'core-service' } | { type: 'user'; userId: number }, input: Record<string, unknown>) => ExecutionCtx;
  /** Reads the `ai_pipelines_enabled` flag (production passes `isPipelinesEnabled` from
   * run-executor.ts). Optional: omitted means enabled, so test harnesses that don't care about
   * the flag keep working. When provided and it returns false, `/run` answers 403. */
  getPipelinesEnabled?: (db: AppDatabase) => boolean;
}

export function registerAiPipelineEndpoints(deps: AiPipelineDeps): void {
  const { db } = deps;

  registerEndpoint('GET', '/v1/ai-pipelines', (req, res) => {
    // Task 22's frontend reads `apkPipeline.graph` straight off a row from this endpoint — there
    // is no sibling "get one pipeline" endpoint in this plan, so the canvas needs the graph
    // inlined here. Fold each pipeline's published version (falling back to its latest draft if
    // none is published yet) in here instead of adding a second round-trip.
    const rows = db.select().from(aiPipelines).all();
    const data = rows.map((row) => {
      const versions = db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.pipelineId, row.id))
        .orderBy(aiPipelineVersions.version).all();
      const version = versions.find(v => v.status === 'published') ?? versions.at(-1);
      return { ...row, pipelineVersionId: version?.id ?? null, graph: version?.graph ?? null };
    });
    res.json({ success: true, data });
  }, { requires: ['core.apk:read'] });

  registerEndpoint('POST', '/v1/ai-pipelines', (req, res) => {
    const { name, jobKind, graph } = req.body as { name: string; jobKind: string; graph: PipelineGraph };
    const now = new Date();
    const pipelineId = db.insert(aiPipelines).values({ name, jobKind, createdAt: now }).run().lastInsertRowid as number;
    db.insert(aiPipelineVersions).values({ pipelineId, version: 1, graph: graph as any, status: 'draft', createdAt: now }).run();
    res.json({ success: true, data: { id: pipelineId } });
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('POST', '/v1/ai-pipelines/:id/versions', (req, res) => {
    const pipelineId = Number(req.params.id);
    const { graph } = req.body as { graph: PipelineGraph };
    const latest = db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.pipelineId, pipelineId))
      .orderBy(aiPipelineVersions.version).all().pop();
    const nextVersion = (latest?.version ?? 0) + 1;
    db.insert(aiPipelineVersions).values({ pipelineId, version: nextVersion, graph: graph as any, status: 'draft', createdAt: new Date() }).run();
    res.json({ success: true, data: { version: nextVersion } });
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('POST', '/v1/ai-pipelines/:id/publish', (req, res) => {
    const pipelineId = Number(req.params.id);
    const latest = db.select().from(aiPipelineVersions).where(eq(aiPipelineVersions.pipelineId, pipelineId))
      .orderBy(aiPipelineVersions.version).all().pop();
    if (!latest) { res.status(404).json({ success: false, error: 'No version to publish' }); return; }

    const errors = validateGraph(latest.graph as PipelineGraph);
    if (errors.length > 0) { res.status(400).json({ success: false, error: 'Invalid graph', errors }); return; }

    // Demote every other version back to draft first, so "published" is a true singleton per
    // pipeline — found during review: without this, GET (picks the oldest published version)
    // and /run (picks the newest) disagreed about which version was current the moment a second
    // version was ever published.
    db.update(aiPipelineVersions).set({ status: 'draft' })
      .where(and(eq(aiPipelineVersions.pipelineId, pipelineId), eq(aiPipelineVersions.status, 'published')))
      .run();
    db.update(aiPipelineVersions).set({ status: 'published' }).where(eq(aiPipelineVersions.id, latest.id)).run();
    res.json({ success: true });
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('POST', '/v1/ai-pipelines/:id/run', (req, res) => {
    const pipelineId = Number(req.params.id);
    const { input, reuseUnchanged } = req.body as { triggerNodeId?: string; input: Record<string, unknown>; reuseUnchanged?: boolean };
    let { triggerNodeId } = req.body as { triggerNodeId?: string };

    // Same flag that gates the production auto-trigger path (apk-analyzer.ts). Found in the final
    // review: without this, the REST endpoint ran pipelines (real AgentCalls, real note writes)
    // even with the feature switched off.
    if (deps.getPipelinesEnabled && !deps.getPipelinesEnabled(db)) {
      res.status(403).json({ success: false, error: 'AI job pipelines are disabled (the ai_pipelines_enabled setting is off)' });
      return;
    }

    // Fail closed. registerEndpoint's scope check should already have rejected an unauthenticated
    // request to this core.apk:manage route, but if that ever changes, the answer must be 401 —
    // never a silent fallback to a more privileged core-service identity. AuthUser
    // (backend/auth/middleware.ts) has `userId`, not `actorUserId`.
    if (!req.authUser) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    const identity = { type: 'user' as const, userId: req.authUser.userId };

    const version = db.select().from(aiPipelineVersions)
      .where(and(eq(aiPipelineVersions.pipelineId, pipelineId), eq(aiPipelineVersions.status, 'published')))
      .orderBy(aiPipelineVersions.version).all().pop();
    if (!version) { res.status(404).json({ success: false, error: 'No published version for this pipeline' }); return; }

    // Spec: triggerNodeId is required once a version has more than one Trigger, optional and
    // inferred when it has exactly one.
    const graph = version.graph as PipelineGraph;
    const triggerNodes = graph.nodes.filter(n => n.config.kind === 'Trigger');
    if (!triggerNodeId) {
      if (triggerNodes.length !== 1) {
        res.status(400).json({ success: false, error: `triggerNodeId is required — this pipeline version has ${triggerNodes.length} Trigger nodes, not exactly one` });
        return;
      }
      triggerNodeId = triggerNodes[0].id;
    } else if (!triggerNodes.some(n => n.id === triggerNodeId)) {
      res.status(400).json({ success: false, error: `"${triggerNodeId}" is not a Trigger node in this pipeline version` });
      return;
    }

    // The 409 guard, run-row insert, priorNodeRuns loader and crash handling all live in
    // startPipelineRun, shared with apk-analyzer.ts's production trigger path. It returns as soon
    // as the run is recorded; the client polls GET /v1/ai-pipelines/runs/:runId for the outcome
    // (a real multi-AgentCall run takes minutes, far past the client's 30s REST timeout).
    let started: StartPipelineRunResult;
    try {
      started = startPipelineRun({
        db,
        pipelineVersionId: version.id,
        graph,
        triggerNodeId,
        input: input ?? {},
        reuseUnchanged,
        triggeredBy: 'manual',
        executors: deps.executors,
        buildCtx: () => deps.buildCtx(identity, input ?? {}),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (!started.ok) {
      res.status(409).json({ success: false, error: started.error });
      return;
    }

    res.json({ success: true, data: { runId: started.runId, status: 'running' } });
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('GET', '/v1/ai-pipelines/runs/:runId', (req, res) => {
    const runId = Number(req.params.runId);
    const run = db.select().from(aiPipelineRuns).where(eq(aiPipelineRuns.id, runId)).all()[0];
    if (!run) { res.status(404).json({ success: false, error: 'Run not found' }); return; }
    const nodes = db.select().from(aiPipelineNodeRuns).where(eq(aiPipelineNodeRuns.runId, runId)).all();
    res.json({ success: true, data: { run, nodes } });
  }, { requires: ['core.apk:read'] });
}
