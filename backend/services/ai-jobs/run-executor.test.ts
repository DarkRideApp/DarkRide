import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { applyMigrations } from '../../test-utils/create-test-db';
import type { PipelineGraph } from './types';
import type { NodeExecutors, RunResult } from './pipeline-runner';
import { startPipelineRun, resetRunningPipelineRuns, isPipelinesEnabled } from './run-executor';

vi.mock('../../logs', () => ({
  createLoggers: () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

function makeDb(): AppDatabase {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = OFF');
  applyMigrations(sqlite);
  return drizzle(sqlite, { schema }) as unknown as AppDatabase;
}

function graph(): PipelineGraph {
  return {
    nodes: [
      { id: 'trigger', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
      { id: 'agent', config: { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] } },
      { id: 'sink', config: { kind: 'Sink', writeFn: 'x' } },
    ],
    edges: [{ from: 'trigger', to: 'agent' }, { from: 'agent', to: 'sink' }],
  };
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

function seedVersion(db: AppDatabase): number {
  const now = new Date();
  const pipelineId = db.insert(schema.aiPipelines).values({ name: 'P', jobKind: 'apk-analysis', createdAt: now }).run().lastInsertRowid as number;
  return db.insert(schema.aiPipelineVersions).values({ pipelineId, version: 1, graph: graph() as any, status: 'published', createdAt: now }).run().lastInsertRowid as number;
}

function seedRun(db: AppDatabase, pipelineVersionId: number, status: 'running' | 'ok' | 'failed' | 'partial'): number {
  return db.insert(schema.aiPipelineRuns).values({
    pipelineVersionId, triggerNodeId: 'trigger', triggeredBy: 'manual', input: {},
    reuseUnchanged: false, status, startedAt: new Date(),
  }).run().lastInsertRowid as number;
}

function runRow(db: AppDatabase, id: number) {
  return db.select().from(schema.aiPipelineRuns).where(eq(schema.aiPipelineRuns.id, id)).all()[0];
}

/** Resolves with the RunResult passed to onSettled — the deterministic "background work is done" signal. */
function settledPromise(): { onSettled: (r: RunResult) => void; settled: Promise<RunResult> } {
  let onSettled!: (r: RunResult) => void;
  const settled = new Promise<RunResult>((resolve) => { onSettled = resolve; });
  return { onSettled, settled };
}

describe('startPipelineRun', () => {
  let db: AppDatabase;
  let versionId: number;

  beforeEach(() => {
    db = makeDb();
    versionId = seedVersion(db);
  });

  it('returns {ok:true, runId} synchronously, while the pipeline is still in flight', async () => {
    let releaseAgent!: () => void;
    const agentGate = new Promise<void>((resolve) => { releaseAgent = resolve; });
    const executors = fakeExecutors({
      AgentCall: vi.fn(async () => { await agentGate; return { text: 'late' }; }),
    });
    const { onSettled, settled } = settledPromise();

    const started = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: { versionId: 5 },
      triggeredBy: 'manual', executors, buildCtx: () => ({}), onSettled,
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Give the background work plenty of turns — it is parked on agentGate, so the run must
    // still be 'running' with no node rows no matter how many ticks pass.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(runRow(db, started.runId).status).toBe('running');
    expect(db.select().from(schema.aiPipelineNodeRuns).all()).toHaveLength(0);

    releaseAgent();
    const result = await settled;
    expect(result.status).toBe('ok');
    expect(runRow(db, started.runId).status).toBe('ok');
  });

  it('rejects a second call for the same pipelineVersionId while one is running, naming the running run', async () => {
    const agentGate = new Promise<void>(() => {}); // never resolves: first run stays 'running'
    const executors = fakeExecutors({ AgentCall: vi.fn(async () => { await agentGate; return {}; }) });
    const first = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors, buildCtx: () => ({}),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'apk-analysis-complete', executors: fakeExecutors(), buildCtx: () => ({}),
    });
    expect(second).toEqual({
      ok: false,
      error: expect.stringContaining(`run ${first.runId}`),
      alreadyRunningRunId: first.runId,
    });
    expect(db.select().from(schema.aiPipelineRuns).all()).toHaveLength(1);
  });

  it('persists the run row, every node-run row (with inputHash), and passes the RunResult to onSettled', async () => {
    const { onSettled, settled } = settledPromise();
    const started = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: { versionId: 9 },
      triggeredBy: 'apk-analysis-complete', executors: fakeExecutors(), buildCtx: () => ({}), onSettled,
    });
    if (!started.ok) throw new Error('expected ok');
    const result = await settled;

    expect(result.status).toBe('ok');
    expect(result.nodes.map(n => n.nodeId)).toEqual(['trigger', 'agent', 'sink']);
    const run = runRow(db, started.runId);
    expect(run).toMatchObject({ status: 'ok', triggeredBy: 'apk-analysis-complete', triggerNodeId: 'trigger', input: { versionId: 9 } });
    expect(run.finishedAt).toBeInstanceOf(Date);
    const nodeRuns = db.select().from(schema.aiPipelineNodeRuns).where(eq(schema.aiPipelineNodeRuns.runId, started.runId)).all();
    expect(nodeRuns.map(n => n.nodeId).sort()).toEqual(['agent', 'sink', 'trigger']);
    expect(nodeRuns.find(n => n.nodeId === 'agent')!.inputHash).toBeTruthy();
    expect(nodeRuns.find(n => n.nodeId === 'agent')!.output).toEqual({ text: 'ok' });
  });

  it('a synchronous buildCtx throw marks the run failed (a row exists to retry against) and still calls onSettled', async () => {
    const { onSettled, settled } = settledPromise();
    const executors = fakeExecutors();
    const started = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors, buildCtx: () => { throw new Error('ctx boom'); }, onSettled,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(await settled).toEqual({ status: 'failed', nodes: [] });
    expect(runRow(db, started.runId).status).toBe('failed');
    expect(executors.Trigger).not.toHaveBeenCalled();

    // Not permanently 409d.
    const retry = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors, buildCtx: () => ({}),
    });
    expect(retry.ok).toBe(true);
  });

  it('a runPipeline rejection (bad triggerNodeId) marks the run failed and still calls onSettled', async () => {
    const { onSettled, settled } = settledPromise();
    const started = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'not-a-trigger', input: {},
      triggeredBy: 'manual', executors: fakeExecutors(), buildCtx: () => ({}), onSettled,
    });
    if (!started.ok) throw new Error('expected ok');
    expect(await settled).toEqual({ status: 'failed', nodes: [] });
    expect(runRow(db, started.runId).status).toBe('failed');
    expect(runRow(db, started.runId).finishedAt).toBeInstanceOf(Date);
  });

  it('passes the crash message to onSettled as crashError, and none on a clean run', async () => {
    const crashed = vi.fn();
    startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors: fakeExecutors(), buildCtx: () => { throw new Error('ctx boom'); }, onSettled: crashed,
    });
    await vi.waitFor(() => expect(crashed).toHaveBeenCalled());
    expect(crashed).toHaveBeenCalledWith({ status: 'failed', nodes: [] }, 'ctx boom');

    const clean = vi.fn();
    startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors: fakeExecutors(), buildCtx: () => ({}), onSettled: clean,
    });
    await vi.waitFor(() => expect(clean).toHaveBeenCalled());
    expect(clean.mock.calls[0][1]).toBeUndefined();
  });

  it('a throwing onSettled does not flip an ok run to failed, and is called exactly once', async () => {
    const onSettled = vi.fn(() => { throw new Error('callback boom'); });
    const started = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors: fakeExecutors(), buildCtx: () => ({}), onSettled,
    });
    if (!started.ok) throw new Error('expected ok');
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalled());
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(runRow(db, started.runId).status).toBe('ok');
  });

  it('reuseUnchanged feeds prior ok node runs back in, so an unchanged AgentCall is memoized', async () => {
    const executors = fakeExecutors();
    const first = settledPromise();
    startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors, buildCtx: () => ({}), onSettled: first.onSettled,
    });
    await first.settled;
    expect(executors.AgentCall).toHaveBeenCalledTimes(1);

    const second = settledPromise();
    startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {}, reuseUnchanged: true,
      triggeredBy: 'manual', executors, buildCtx: () => ({}), onSettled: second.onSettled,
    });
    const result = await second.settled;
    expect(executors.AgentCall).toHaveBeenCalledTimes(1);
    expect(result.nodes.find(n => n.nodeId === 'agent')!.wasMemoized).toBe(true);
  });
});

describe('resetRunningPipelineRuns', () => {
  it("flips every 'running' row to 'failed' and leaves other statuses untouched", () => {
    const db = makeDb();
    const versionId = seedVersion(db);
    const running1 = seedRun(db, versionId, 'running');
    const running2 = seedRun(db, versionId, 'running');
    const ok = seedRun(db, versionId, 'ok');
    const partial = seedRun(db, versionId, 'partial');
    const failed = seedRun(db, versionId, 'failed');

    resetRunningPipelineRuns(db);

    expect(runRow(db, running1).status).toBe('failed');
    expect(runRow(db, running1).finishedAt).toBeInstanceOf(Date);
    expect(runRow(db, running2).status).toBe('failed');
    expect(runRow(db, ok).status).toBe('ok');
    expect(runRow(db, partial).status).toBe('partial');
    expect(runRow(db, failed).status).toBe('failed');
  });

  it('unblocks the concurrency guard for a version left running by a restart', () => {
    const db = makeDb();
    const versionId = seedVersion(db);
    seedRun(db, versionId, 'running');
    const blocked = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors: fakeExecutors(), buildCtx: () => ({}),
    });
    expect(blocked.ok).toBe(false);

    resetRunningPipelineRuns(db);
    const unblocked = startPipelineRun({
      db, pipelineVersionId: versionId, graph: graph(), triggerNodeId: 'trigger', input: {},
      triggeredBy: 'manual', executors: fakeExecutors(), buildCtx: () => ({}),
    });
    expect(unblocked.ok).toBe(true);
  });
});

describe('isPipelinesEnabled', () => {
  it("is true only when the ai_pipelines_enabled row is exactly 'true'", () => {
    const db = makeDb();
    db.insert(schema.settings).values({ key: 'ai_pipelines_enabled', value: 'true' }).run();
    expect(isPipelinesEnabled(db)).toBe(true);
  });

  it("is false when the row is 'false'", () => {
    const db = makeDb();
    db.insert(schema.settings).values({ key: 'ai_pipelines_enabled', value: 'false' }).run();
    expect(isPipelinesEnabled(db)).toBe(false);
  });

  it('defaults to false when the row is missing', () => {
    const db = makeDb();
    db.delete(schema.settings).where(eq(schema.settings.key, 'ai_pipelines_enabled')).run();
    expect(isPipelinesEnabled(db)).toBe(false);
  });
});
