import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { clearEndpoints, getApiRouter } from './api-service';
import { registerAiPipelineEndpoints, type AiPipelineDeps } from './ai-pipelines';
import { applyMigrations } from '../test-utils/create-test-db';
import type { PipelineGraph } from '../services/ai-jobs/types';
import type { NodeExecutors, ExecutionCtx } from '../services/ai-jobs/pipeline-runner';

vi.mock('../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

// ── DB + fixtures ──────────────────────────────────────────────────────────────

type Db = BetterSQLite3Database<typeof schema>;

function makeDb(): Db {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

function graphWithOneTrigger(): PipelineGraph {
  return {
    nodes: [
      { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
    ],
    edges: [{ from: 'trigger', to: 'agent' }, { from: 'agent', to: 'sink' }],
  };
}

function graphWithTwoTriggers(): PipelineGraph {
  // Disjoint zones per Trigger (validateGraph requires each non-Trigger node be reachable from
  // exactly one Trigger) — needed so this fixture can also pass through /publish's validateGraph
  // call, not just stand in for a bare "more than one Trigger" count.
  const outputSchema = [{ field: 'appName', type: 'string', description: 'x' }];
  return {
    nodes: [
      { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'full', outputSchema } },
      { id: 'trigger-quick', config: { kind: 'Trigger', expandFn: 'quick', outputSchema } },
      { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'sink-full', config: { kind: 'Sink', writeFn: 'x' } },
      { id: 'sink-quick', config: { kind: 'Sink', writeFn: 'x' } },
    ],
    edges: [
      { from: 'trigger-full', to: 'agent-overview' },
      { from: 'agent-overview', to: 'sink-full' },
      { from: 'trigger-quick', to: 'sink-quick' },
    ],
  };
}

function seedPipeline(db: Db, name = 'Pipeline A'): number {
  const now = new Date();
  return db.insert(schema.aiPipelines).values({ name, createdAt: now }).run().lastInsertRowid as number;
}

function seedVersion(
  db: Db,
  pipelineId: number,
  version: number,
  graph: PipelineGraph,
  status: 'draft' | 'published',
): number {
  const now = new Date();
  return db.insert(schema.aiPipelineVersions).values({
    pipelineId, version, graph: graph as any, status, createdAt: now,
  }).run().lastInsertRowid as number;
}

function seedRun(
  db: Db,
  pipelineVersionId: number,
  status: 'running' | 'ok' | 'failed' | 'partial',
  triggerNodeId = 'trigger',
): number {
  const now = new Date();
  return db.insert(schema.aiPipelineRuns).values({
    pipelineVersionId, triggerNodeId, triggeredBy: 'manual', input: {},
    reuseUnchanged: false, status, startedAt: now,
    finishedAt: status === 'running' ? null : now,
  }).run().lastInsertRowid as number;
}

function fakeExecutors(overrides: Partial<NodeExecutors> = {}): NodeExecutors {
  return {
    Trigger: vi.fn(async (_c, rawInput) => ({ appName: 'x', ...rawInput })),
    AgentCall: vi.fn(async () => ({ text: 'ok' })),
    Transform: vi.fn(() => ({})),
    Branch: vi.fn(() => 'default'),
    Report: vi.fn(() => ({ markdown: '' })),
    ForEach: vi.fn(async () => []),
    Sink: vi.fn(async () => {}),
    ...overrides,
  };
}

function createApp(
  db: Db,
  executors: NodeExecutors,
  scopes: string[] = ['core.apk:read', 'core.apk:manage'],
  buildCtx: AiPipelineDeps['buildCtx'] = (_identity, _input): ExecutionCtx => ({}),
  extraDeps: Partial<AiPipelineDeps> = {},
) {
  clearEndpoints();
  const deps: AiPipelineDeps = { db, executors, buildCtx, ...extraDeps };
  registerAiPipelineEndpoints(deps);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).authUser = { userId: 1, effectiveScopes: new Set(scopes) };
    next();
  });
  app.use(getApiRouter());
  return app;
}

/** /run now answers as soon as the run is recorded; poll the run-detail endpoint until it settles. */
async function waitForRunToSettle(app: express.Express, runId: number): Promise<any> {
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get(`/v1/ai-pipelines/runs/${runId}`);
    if (res.body.data?.run && res.body.data.run.status !== 'running') return res.body.data;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`run ${runId} never settled`);
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('POST /v1/ai-pipelines', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  it('creates a pipeline from just a name and a graph — no job kind required', async () => {
    const app = createApp(db, fakeExecutors());
    const graph = graphWithOneTrigger();
    const res = await request(app).post('/v1/ai-pipelines').send({ name: 'My Pipeline', graph });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const pipelineId = res.body.data.id;
    expect(pipelineId).toEqual(expect.any(Number));

    const row = db.select().from(schema.aiPipelines).where(eq(schema.aiPipelines.id, pipelineId)).all()[0];
    expect(row.name).toBe('My Pipeline');
    expect(row).not.toHaveProperty('jobKind');

    const version = db.select().from(schema.aiPipelineVersions).where(eq(schema.aiPipelineVersions.pipelineId, pipelineId)).all()[0];
    expect(version.status).toBe('draft');
    expect(version.graph).toEqual(graph);
  });
});

describe('GET /v1/ai-pipelines', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  it("includes each pipeline's latest version graph inline, not just the bare pipeline row", async () => {
    const pipelineId = seedPipeline(db);
    const v1Graph = graphWithOneTrigger();
    const v2Graph = graphWithTwoTriggers();
    seedVersion(db, pipelineId, 1, v1Graph, 'draft');
    const v2Id = seedVersion(db, pipelineId, 2, v2Graph, 'published');

    const app = createApp(db, fakeExecutors());
    const res = await request(app).get('/v1/ai-pipelines');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const row = res.body.data.find((r: any) => r.id === pipelineId);
    expect(row).toBeDefined();
    expect(row.pipelineVersionId).toBe(v2Id);
    expect(row.graph).toEqual(v2Graph);
  });

  it('returns the only version when nothing is published yet', async () => {
    const pipelineId = seedPipeline(db, 'Pipeline B');
    const v1Graph = graphWithOneTrigger();
    const v1Id = seedVersion(db, pipelineId, 1, v1Graph, 'draft');

    const app = createApp(db, fakeExecutors());
    const res = await request(app).get('/v1/ai-pipelines');

    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.id === pipelineId);
    expect(row.pipelineVersionId).toBe(v1Id);
    expect(row.graph).toEqual(v1Graph);
  });

  it('returns a newer unpublished draft over an older published version — a reload must never look like it discarded unsaved work', async () => {
    // Regression guard: this endpoint used to prefer "published" over "latest," so editing a
    // pipeline, autosaving a draft, then reloading the editor would show the stale published
    // graph instead of the draft just saved — indistinguishable from the edit having been lost.
    const pipelineId = seedPipeline(db, 'Pipeline D');
    const publishedGraph = graphWithOneTrigger();
    seedVersion(db, pipelineId, 1, publishedGraph, 'published');
    const draftGraph = graphWithTwoTriggers();
    const draftId = seedVersion(db, pipelineId, 2, draftGraph, 'draft');

    const app = createApp(db, fakeExecutors());
    const res = await request(app).get('/v1/ai-pipelines');

    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.id === pipelineId);
    expect(row.pipelineVersionId).toBe(draftId);
    expect(row.graph).toEqual(draftGraph);
  });

  it('after publishing v2, returns v2\'s graph — not v1\'s — because publish demotes the prior published version', async () => {
    // Regression guard: /publish used to leave BOTH v1 and v2 marked 'published', so GET (which
    // picks the oldest published version) and /run (which picks the newest) disagreed about
    // which version was current.
    const pipelineId = seedPipeline(db, 'Pipeline C');
    const v1Graph = graphWithOneTrigger();
    const v2Graph = graphWithTwoTriggers();
    seedVersion(db, pipelineId, 1, v1Graph, 'draft');

    const app = createApp(db, fakeExecutors());
    const publish1 = await request(app).post(`/v1/ai-pipelines/${pipelineId}/publish`);
    expect(publish1.status).toBe(200);

    // Now add a second draft version and publish it — v1 is still 'published' at this point.
    const v2Id = seedVersion(db, pipelineId, 2, v2Graph, 'draft');
    const publish2 = await request(app).post(`/v1/ai-pipelines/${pipelineId}/publish`);
    expect(publish2.status).toBe(200);

    const res = await request(app).get('/v1/ai-pipelines');
    expect(res.status).toBe(200);
    const row = res.body.data.find((r: any) => r.id === pipelineId);
    expect(row.pipelineVersionId).toBe(v2Id);
    expect(row.graph).toEqual(v2Graph);

    // Exactly one version should be 'published' at a time.
    const versions = db.select().from(schema.aiPipelineVersions).where(eq(schema.aiPipelineVersions.pipelineId, pipelineId)).all();
    expect(versions.filter(v => v.status === 'published').length).toBe(1);
  });
});

describe('GET /v1/ai-pipelines/:id', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns the one pipeline's row with its latest version graph inlined", async () => {
    const pipelineId = seedPipeline(db, 'Solo Pipeline');
    const graph = graphWithOneTrigger();
    const versionId = seedVersion(db, pipelineId, 1, graph, 'published');

    const app = createApp(db, fakeExecutors());
    const res = await request(app).get(`/v1/ai-pipelines/${pipelineId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(pipelineId);
    expect(res.body.data.name).toBe('Solo Pipeline');
    expect(res.body.data.pipelineVersionId).toBe(versionId);
    expect(res.body.data.graph).toEqual(graph);
  });

  it('returns a newer unpublished draft over an older published version, same as the list endpoint', async () => {
    const pipelineId = seedPipeline(db, 'Solo Pipeline');
    seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'published');
    const draftGraph = graphWithTwoTriggers();
    const draftId = seedVersion(db, pipelineId, 2, draftGraph, 'draft');

    const app = createApp(db, fakeExecutors());
    const res = await request(app).get(`/v1/ai-pipelines/${pipelineId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.pipelineVersionId).toBe(draftId);
    expect(res.body.data.graph).toEqual(draftGraph);
  });

  it('404s on an id with no pipeline', async () => {
    const app = createApp(db, fakeExecutors());
    const res = await request(app).get('/v1/ai-pipelines/999999');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /v1/ai-pipelines/:id/versions', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  it('creates version 1 when the pipeline has no versions yet', async () => {
    const pipelineId = seedPipeline(db);
    const app = createApp(db, fakeExecutors());

    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/versions`).send({ graph: graphWithOneTrigger() });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
    const versions = db.select().from(schema.aiPipelineVersions).where(eq(schema.aiPipelineVersions.pipelineId, pipelineId)).all();
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe('draft');
  });

  it('overwrites the latest version in place while it is still a draft, instead of inserting a new row', async () => {
    const pipelineId = seedPipeline(db);
    seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'draft');
    const app = createApp(db, fakeExecutors());

    const secondGraph = graphWithTwoTriggers();
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/versions`).send({ graph: secondGraph });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
    const versions = db.select().from(schema.aiPipelineVersions).where(eq(schema.aiPipelineVersions.pipelineId, pipelineId)).all();
    expect(versions).toHaveLength(1);
    expect(versions[0].graph).toEqual(secondGraph);
  });

  it('inserts a new version when the latest version is already published', async () => {
    const pipelineId = seedPipeline(db);
    seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'published');
    const app = createApp(db, fakeExecutors());

    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/versions`).send({ graph: graphWithTwoTriggers() });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    const versions = db.select().from(schema.aiPipelineVersions).where(eq(schema.aiPipelineVersions.pipelineId, pipelineId)).all();
    expect(versions).toHaveLength(2);
    expect(versions.find(v => v.version === 1)!.status).toBe('published');
    expect(versions.find(v => v.version === 2)!.status).toBe('draft');
  });
});

describe('POST /v1/ai-pipelines/:id/run — concurrency guard', () => {
  let db: Db;
  let pipelineId: number;
  let versionId: number;

  beforeEach(() => {
    db = makeDb();
    pipelineId = seedPipeline(db);
    versionId = seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'published');
  });

  it('rejects a second run with 409 while one is already running for the same pipeline', async () => {
    seedRun(db, versionId, 'running');

    const executors = fakeExecutors();
    const app = createApp(db, executors);
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {} });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already running/i);
    expect(executors.Trigger).not.toHaveBeenCalled();
  });

  it('accepts a run once the prior one has finished (status is ok/partial/failed, not running)', async () => {
    seedRun(db, versionId, 'ok');

    const executors = fakeExecutors();
    const app = createApp(db, executors);
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {} });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const runs = db.select().from(schema.aiPipelineRuns).all();
    expect(runs.length).toBe(2);
  });

  it('infers triggerNodeId when the published version has exactly one Trigger and the request omits it', async () => {
    const executors = fakeExecutors();
    const app = createApp(db, executors);
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {} });

    expect(res.status).toBe(200);
    const run = db.select().from(schema.aiPipelineRuns).all()[0];
    expect(run.triggerNodeId).toBe('trigger');
  });

  it('rejects with 400 when triggerNodeId is omitted and the version has more than one Trigger', async () => {
    const multiPipelineId = seedPipeline(db, 'Pipeline Multi');
    const multiVersionId = seedVersion(db, multiPipelineId, 1, graphWithTwoTriggers(), 'published');

    const executors = fakeExecutors();
    const app = createApp(db, executors);
    const res = await request(app).post(`/v1/ai-pipelines/${multiPipelineId}/run`).send({ input: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 Trigger/);
    expect(executors.Trigger).not.toHaveBeenCalled();
  });

  it('rejects with 400 when triggerNodeId is supplied but does not name a real Trigger node', async () => {
    const executors = fakeExecutors();
    const app = createApp(db, executors);
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {}, triggerNodeId: 'agent' });

    expect(res.status).toBe(400);
    expect(executors.Trigger).not.toHaveBeenCalled();
  });

  it('persists inputHash on each node-run row so memoization has something to match against later', async () => {
    const executors = fakeExecutors();
    const app = createApp(db, executors);
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {} });

    expect(res.status).toBe(200);
    const runId = res.body.data.runId;
    // The POST resolves as soon as the run is recorded — node-run rows land when it settles.
    await waitForRunToSettle(app, runId);
    const nodeRuns = db.select().from(schema.aiPipelineNodeRuns).where(eq(schema.aiPipelineNodeRuns.runId, runId)).all();
    const agentNodeRun = nodeRuns.find(n => n.nodeId === 'agent');
    expect(agentNodeRun).toBeDefined();
    expect(agentNodeRun!.inputHash).toBeTruthy();
  });

  it('marks a crashed run "failed" instead of leaving it stuck "running" forever, so the next run is not permanently 409d', async () => {
    // Regression guard: a throw from buildCtx (or runPipeline, or a node-run insert) used to leave
    // the row 'running' forever — every later /run for this version 409d permanently. Since the
    // final-review fix, /run responds 200 with a runId as soon as the row exists (it no longer
    // waits for the run), so the crash shows up on the run row, not the HTTP status.
    let shouldThrow = true;
    const buildCtx: AiPipelineDeps['buildCtx'] = (_identity, _input) => {
      if (shouldThrow) { shouldThrow = false; throw new Error('buildCtx boom'); }
      return {};
    };
    const executors = fakeExecutors();
    const app = createApp(db, executors, ['core.apk:read', 'core.apk:manage'], buildCtx);

    const crashRes = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {} });
    expect(crashRes.status).toBe(200);
    expect(crashRes.body.data).toEqual({ runId: expect.any(Number), status: 'running' });

    const settled = await waitForRunToSettle(app, crashRes.body.data.runId);
    expect(settled.run.status).toBe('failed');
    expect(executors.Trigger).not.toHaveBeenCalled();
    expect(db.select().from(schema.aiPipelineRuns).all()).toHaveLength(1);

    const retryRes = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {} });
    expect(retryRes.status).toBe(200);
    const retried = await waitForRunToSettle(app, retryRes.body.data.runId);
    expect(retried.run.status).toBe('ok');
  });

  it('responds before the pipeline finishes — a slow run does not hold the HTTP response open', async () => {
    // C1 regression guard: /run used to await the whole pipeline before responding, so any real
    // multi-AgentCall run outlived the client's 30s REST timeout.
    let releaseAgent!: () => void;
    const gate = new Promise<void>((resolve) => { releaseAgent = resolve; });
    const executors = fakeExecutors({ AgentCall: vi.fn(async () => { await gate; return { text: 'slow' }; }) });
    const app = createApp(db, executors);

    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: { versionId: 3 } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('running');
    const runId = res.body.data.runId;

    const midRun = await request(app).get(`/v1/ai-pipelines/runs/${runId}`);
    expect(midRun.body.data.run.status).toBe('running');
    expect(midRun.body.data.run.input).toEqual({ versionId: 3 });

    // A second run against the same version while this one is in flight is still refused.
    const concurrent = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {} });
    expect(concurrent.status).toBe(409);

    releaseAgent();
    const settled = await waitForRunToSettle(app, runId);
    expect(settled.run.status).toBe('ok');
    expect(settled.nodes.find((n: any) => n.nodeId === 'agent').output).toEqual({ text: 'slow' });
  });
});

describe('POST /v1/ai-pipelines/:id/run — not gated by ai_pipelines_enabled', () => {
  // Deliberate: that flag controls only whether apk-analyzer.ts's automatic production trigger
  // uses the pipeline engine. A manual run through this REST endpoint is always a deliberate,
  // authenticated action and must work regardless of the flag — including while it's off, which
  // is also the default. Regression guard for re-coupling the two.
  it('runs a pipeline even when ai_pipelines_enabled is explicitly false', async () => {
    const db = makeDb();
    db.insert(schema.settings).values({ key: 'ai_pipelines_enabled', value: 'false' }).run();
    const pipelineId = seedPipeline(db);
    seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'published');
    const executors = fakeExecutors();
    const app = createApp(db, executors);

    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: {} });

    expect(res.status).toBe(200);
    await waitForRunToSettle(app, res.body.data.runId);
    expect(executors.Trigger).toHaveBeenCalled();
  });
});

describe('POST /v1/ai-pipelines/:id/run — identity', () => {
  it('runs as the authenticated user (buildCtx receives a user identity)', async () => {
    const db = makeDb();
    const pipelineId = seedPipeline(db);
    seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'published');
    const buildCtx = vi.fn((): ExecutionCtx => ({}));
    const app = createApp(db, fakeExecutors(), undefined, buildCtx);
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/run`).send({ input: { versionId: 4 } });
    await waitForRunToSettle(app, res.body.data.runId);
    expect(buildCtx).toHaveBeenCalledWith({ type: 'user', userId: 1 }, { versionId: 4 });
  });
});

describe('GET /v1/ai-pipelines/runs/:runId', () => {
  it('returns the run and every node-run row', async () => {
    const db = makeDb();
    const pipelineId = seedPipeline(db);
    const versionId = seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'published');
    const runId = seedRun(db, versionId, 'ok');

    const app = createApp(db, fakeExecutors());
    const res = await request(app).get(`/v1/ai-pipelines/runs/${runId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.run.id).toBe(runId);
    expect(Array.isArray(res.body.data.nodes)).toBe(true);
  });

  it('returns 404 for an unknown run id', async () => {
    const db = makeDb();
    const app = createApp(db, fakeExecutors());
    const res = await request(app).get('/v1/ai-pipelines/runs/99999');
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/ai-pipelines/hook-catalog', () => {
  it('returns whatever the injected getHookCatalog provides', async () => {
    const db = makeDb();
    const catalog = [{ name: 'apk:analyzed', schema: [], description: 'x' }];
    const app = createApp(db, fakeExecutors(), undefined, undefined, { getHookCatalog: () => catalog });
    const res = await request(app).get('/v1/ai-pipelines/hook-catalog');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(catalog);
  });

  it('returns an empty array when no getHookCatalog was injected', async () => {
    const db = makeDb();
    const app = createApp(db, fakeExecutors());
    const res = await request(app).get('/v1/ai-pipelines/hook-catalog');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // Regression guard: GET /v1/ai-pipelines/:id is also registered and would greedily match
  // "hook-catalog" as :id if this route were registered after it — must hit the literal route,
  // never fall through to a 404 "No pipeline with id hook-catalog." from the :id handler.
  it('is reachable even though GET /v1/ai-pipelines/:id is also registered and could shadow it', async () => {
    const db = makeDb();
    const app = createApp(db, fakeExecutors(), undefined, undefined, { getHookCatalog: () => [] });
    const res = await request(app).get('/v1/ai-pipelines/hook-catalog');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
  });
});

describe('POST /v1/ai-pipelines/:id/publish — onPublish callback', () => {
  it('calls onPublish after a successful publish', async () => {
    const db = makeDb();
    const pipelineId = seedPipeline(db);
    seedVersion(db, pipelineId, 1, graphWithOneTrigger(), 'draft');
    const onPublish = vi.fn();
    const app = createApp(db, fakeExecutors(), undefined, undefined, { onPublish });
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/publish`);
    expect(res.status).toBe(200);
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it('does not call onPublish when publish fails validation', async () => {
    const db = makeDb();
    const pipelineId = seedPipeline(db);
    seedVersion(db, pipelineId, 1, { nodes: [], edges: [] }, 'draft'); // no Trigger — invalid
    const onPublish = vi.fn();
    const app = createApp(db, fakeExecutors(), undefined, undefined, { onPublish });
    const res = await request(app).post(`/v1/ai-pipelines/${pipelineId}/publish`);
    expect(res.status).toBe(400);
    expect(onPublish).not.toHaveBeenCalled();
  });
});
