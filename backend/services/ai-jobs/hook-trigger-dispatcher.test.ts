import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as schema from '../../db/schema';
import type { AppDatabase } from '../../db/index';
import { HookTriggerDispatcher } from './hook-trigger-dispatcher';
import type { NodeExecutors } from './pipeline-runner';
import * as runExecutorModule from './run-executor';

function makeDb(): AppDatabase {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE ai_pipelines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE ai_pipeline_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, pipeline_id INTEGER NOT NULL, version INTEGER NOT NULL,
      graph TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL
    );
  `);
  return drizzle(sqlite, { schema }) as unknown as AppDatabase;
}

function seedPublished(db: AppDatabase, pipelineId: number, versionId: number, graph: unknown) {
  db.insert(schema.aiPipelines).values({ id: pipelineId, name: 'p', createdAt: new Date() }).run();
  db.insert(schema.aiPipelineVersions).values({
    id: versionId, pipelineId, version: 1, graph: graph as any, status: 'published', createdAt: new Date(),
  }).run();
}

function fakeHookBus() {
  const handlers = new Map<string, Set<(...a: any[]) => void>>();
  return {
    define: vi.fn(), off: vi.fn((name: string, h: any) => handlers.get(name)?.delete(h)),
    on: vi.fn((name: string, h: any) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(h);
    }),
    emit: vi.fn((name: string, payload: any) => {
      for (const h of handlers.get(name) ?? []) h(payload);
    }),
    _handlerCount: (name: string) => handlers.get(name)?.size ?? 0,
  };
}

const eventTriggerGraph = (eventName: string) => ({
  nodes: [{ id: 't', config: { kind: 'Trigger', source: 'event', eventName, outputSchema: [] } }],
  edges: [],
});

describe('HookTriggerDispatcher', () => {
  let startSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    startSpy = vi.spyOn(runExecutorModule, 'startPipelineRun').mockReturnValue({ ok: true, runId: 1 });
  });

  it('subscribes to an event name used by a published event-sourced Trigger', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();
    expect(bus.on).toHaveBeenCalledWith('apk:analyzed', expect.any(Function));
  });

  it('firing the subscribed event starts a run with the payload as input', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: (p) => ({ payload: p }) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();

    bus.emit('apk:analyzed', { apkVersionId: 42 });

    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
      pipelineVersionId: 1, triggerNodeId: 't', input: { apkVersionId: 42 }, triggeredBy: 'event',
    }));
  });

  it('does not double-subscribe when refresh() is called twice with no graph changes', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();
    dispatcher.refresh();
    expect(bus._handlerCount('apk:analyzed')).toBe(1);
  });

  it('drops a subscription once no published version uses that event name anymore', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();
    expect(bus._handlerCount('apk:analyzed')).toBe(1);

    // Demote the published version back to draft — simulates a re-publish that no longer binds this event.
    db.update(schema.aiPipelineVersions).set({ status: 'draft' }).run();
    dispatcher.refresh();

    expect(bus.off).toHaveBeenCalledWith('apk:analyzed', expect.any(Function));
    expect(bus._handlerCount('apk:analyzed')).toBe(0);
  });

  it('ignores function-sourced Triggers entirely — never subscribes to anything for them', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, {
      nodes: [{ id: 't', config: { kind: 'Trigger', source: 'function', expandFn: 'x', outputSchema: [] } }],
      edges: [],
    });
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();
    expect(bus.on).not.toHaveBeenCalled();
  });

  it('fires every published Trigger bound to the same event name, across different pipelines', () => {
    const db = makeDb();
    seedPublished(db, 1, 1, eventTriggerGraph('apk:analyzed'));
    seedPublished(db, 2, 2, eventTriggerGraph('apk:analyzed'));
    const bus = fakeHookBus();
    const dispatcher = new HookTriggerDispatcher({ db, executors: {} as NodeExecutors, buildCtx: () => ({}) });
    dispatcher.attach(bus as any);
    dispatcher.refresh();

    bus.emit('apk:analyzed', { apkVersionId: 1 });

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ pipelineVersionId: 1 }));
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ pipelineVersionId: 2 }));
  });
});
