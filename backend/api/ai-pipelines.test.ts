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
  const outputSchema = [{ field: 'appName', type: 'string', description: 'x' }];
  return {
    nodes: [
      { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'full', outputSchema } },
      { id: 'trigger-quick', config: { kind: 'Trigger', expandFn: 'quick', outputSchema } },
      { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
    ],
    edges: [
      { from: 'trigger-full', to: 'agent-overview' },
      { from: 'trigger-quick', to: 'agent-overview' },
      { from: 'agent-overview', to: 'sink' },
    ],
  };
}

function seedPipeline(db: Db, name = 'Pipeline A', jobKind = 'apk-analysis'): number {
  const now = new Date();
  return db.insert(schema.aiPipelines).values({ name, jobKind, createdAt: now }).run().lastInsertRowid as number;
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

function createApp(db: Db, executors: NodeExecutors, scopes: string[] = ['core.apk:read', 'core.apk:manage']) {
  clearEndpoints();
  const deps: AiPipelineDeps = {
    db,
    executors,
    buildCtx: (_identity, _input): ExecutionCtx => ({}),
  };
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

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('GET /v1/ai-pipelines', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
  });

  it("includes each pipeline's published version graph inline, not just the bare pipeline row", async () => {
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

  it('falls back to the latest draft version when no version is published', async () => {
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
    const nodeRuns = db.select().from(schema.aiPipelineNodeRuns).where(eq(schema.aiPipelineNodeRuns.runId, runId)).all();
    const agentNodeRun = nodeRuns.find(n => n.nodeId === 'agent');
    expect(agentNodeRun).toBeDefined();
    expect(agentNodeRun!.inputHash).toBeTruthy();
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
