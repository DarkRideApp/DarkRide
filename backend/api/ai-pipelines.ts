import { eq, and } from 'drizzle-orm';
import { registerEndpoint } from './api-service';
import { aiPipelines, aiPipelineVersions, aiPipelineRuns, aiPipelineNodeRuns } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { validateGraph } from '../services/ai-jobs/graph-validator';
import { runPipeline, type NodeExecutors, type ExecutionCtx } from '../services/ai-jobs/pipeline-runner';
import type { PipelineGraph } from '../services/ai-jobs/types';

export interface AiPipelineDeps {
  db: AppDatabase;
  executors: NodeExecutors;
  /** `identity` comes from the authenticated request (req.authUser), not a fixed core-service identity —
   * a manual run from the editor runs as the clicking user, same as `triggerAiAgentManual` does today. */
  buildCtx: (identity: { type: 'core-service' } | { type: 'user'; userId: number }, input: Record<string, unknown>) => ExecutionCtx;
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

  registerEndpoint('POST', '/v1/ai-pipelines/:id/run', async (req, res) => {
    const pipelineId = Number(req.params.id);
    const { input, reuseUnchanged } = req.body as { triggerNodeId?: string; input: Record<string, unknown>; reuseUnchanged?: boolean };
    let { triggerNodeId } = req.body as { triggerNodeId?: string };

    const version = db.select().from(aiPipelineVersions)
      .where(and(eq(aiPipelineVersions.pipelineId, pipelineId), eq(aiPipelineVersions.status, 'published')))
      .orderBy(aiPipelineVersions.version).all().pop();
    if (!version) { res.status(404).json({ success: false, error: 'No published version for this pipeline' }); return; }

    // Spec: triggerNodeId is required once a version has more than one Trigger, optional and
    // inferred when it has exactly one.
    const graphForTriggerCheck = version.graph as PipelineGraph;
    const triggerNodes = graphForTriggerCheck.nodes.filter(n => n.config.kind === 'Trigger');
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

    const alreadyRunning = db.select().from(aiPipelineRuns)
      .where(and(eq(aiPipelineRuns.pipelineVersionId, version.id), eq(aiPipelineRuns.status, 'running')))
      .all()[0];
    if (alreadyRunning) {
      res.status(409).json({ success: false, error: `A run is already running for this pipeline version (run ${alreadyRunning.id})` });
      return;
    }

    const now = new Date();
    const runId = db.insert(aiPipelineRuns).values({
      pipelineVersionId: version.id, triggerNodeId, triggeredBy: 'manual',
      input, reuseUnchanged: !!reuseUnchanged, status: 'running', startedAt: now,
    }).run().lastInsertRowid as number;

    const graph = version.graph as PipelineGraph;
    let priorNodeRuns: Record<string, { inputHash: string; output: Record<string, unknown> }> | undefined;
    if (reuseUnchanged) {
      priorNodeRuns = {};
      // Ascending by id, so a later (more recent) run's node output always overwrites an earlier
      // one's in the loop below — relying on unordered default row-scan order isn't a guaranteed
      // contract, so order explicitly.
      const priorRuns = db.select().from(aiPipelineRuns).where(eq(aiPipelineRuns.pipelineVersionId, version.id)).orderBy(aiPipelineRuns.id).all();
      for (const priorRun of priorRuns) {
        const priorNodes = db.select().from(aiPipelineNodeRuns)
          .where(and(eq(aiPipelineNodeRuns.runId, priorRun.id), eq(aiPipelineNodeRuns.status, 'ok')))
          .all();
        for (const nr of priorNodes) {
          if (nr.inputHash && nr.output) priorNodeRuns[nr.nodeId] = { inputHash: nr.inputHash, output: nr.output };
        }
      }
    }

    // AuthUser (backend/auth/middleware.ts) has `userId`, not `actorUserId` — that field belongs
    // to the unrelated AgentIdentity type. The defensive core-service fallback below should be
    // unreachable in practice: registerEndpoint's scope check already requires an authUser for a
    // core.apk:manage route.
    const identity = req.authUser
      ? { type: 'user' as const, userId: req.authUser.userId }
      : { type: 'core-service' as const };

    try {
      const result = await runPipeline(graph, triggerNodeId, input, deps.executors, deps.buildCtx(identity, input), { reuseUnchanged, priorNodeRuns });

      for (const nodeResult of result.nodes) {
        db.insert(aiPipelineNodeRuns).values({
          runId, nodeId: nodeResult.nodeId, status: nodeResult.status,
          output: nodeResult.output, error: nodeResult.error,
          // inputHash must be persisted here, not just wasMemoized: the loader just above filters
          // on `nr.inputHash && nr.output`, so without writing it here, priorNodeRuns is always
          // empty on every later run and memoization can never fire in production.
          inputHash: nodeResult.inputHash,
          wasMemoized: !!nodeResult.wasMemoized, startedAt: now, finishedAt: new Date(),
        }).run();
      }
      db.update(aiPipelineRuns).set({ status: result.status, finishedAt: new Date() }).where(eq(aiPipelineRuns.id, runId)).run();

      res.json({ success: true, data: { runId, status: result.status } });
    } catch (err) {
      // Found during review: without this, any throw between inserting the 'running' row and
      // finalizing it (buildCtx, runPipeline itself, or a node-run insert) leaves the row stuck
      // in 'running' forever, and every future /run for this version 409s permanently with no
      // way to clear it short of a direct DB edit. Mark it failed so the 409 guard only ever
      // blocks a genuine concurrent run, never a crashed one.
      db.update(aiPipelineRuns).set({ status: 'failed', finishedAt: new Date() }).where(eq(aiPipelineRuns.id, runId)).run();
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, { requires: ['core.apk:manage'] });

  registerEndpoint('GET', '/v1/ai-pipelines/runs/:runId', (req, res) => {
    const runId = Number(req.params.runId);
    const run = db.select().from(aiPipelineRuns).where(eq(aiPipelineRuns.id, runId)).all()[0];
    if (!run) { res.status(404).json({ success: false, error: 'Run not found' }); return; }
    const nodes = db.select().from(aiPipelineNodeRuns).where(eq(aiPipelineNodeRuns.runId, runId)).all();
    res.json({ success: true, data: { run, nodes } });
  }, { requires: ['core.apk:read'] });
}
