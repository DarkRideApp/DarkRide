import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it, expect, vi } from 'vitest';
import * as schema from '../../db/schema';
import { getNote } from '../apk-notes';
import { validateGraph } from './graph-validator';
import { runPipeline } from './pipeline-runner';
import {
  ASTERIX_PATTERN_GRAPH,
  buildApkAnalysisExecutors,
  buildApkAnalysisExecutionCtx,
  seedApkAnalysisPipeline,
} from './apk-analysis-pipeline';
import type { AiAgentFactory } from '../ai-agent-factory';
import type { AppDatabase } from '../../db/index';
import { aiPipelines, aiPipelineVersions } from '../../db/schema';

function makeDb(): AppDatabase {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE tracked_apps (id INTEGER PRIMARY KEY, package_name TEXT NOT NULL, app_name TEXT, auto_analyse INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE apk_versions (id INTEGER PRIMARY KEY, tracked_app_id INTEGER NOT NULL, version_code INTEGER NOT NULL, version_name TEXT, filename TEXT NOT NULL, file_size INTEGER, device_id TEXT, source TEXT DEFAULT 'device', downloaded_at INTEGER NOT NULL);
    CREATE TABLE apk_notes (version_id INTEGER PRIMARY KEY REFERENCES apk_versions(id) ON DELETE CASCADE, content TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
    CREATE TABLE ai_pipelines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, job_kind TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE ai_pipeline_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      graph TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      UNIQUE(pipeline_id, version)
    );
  `);
  return drizzle(sqlite, { schema }) as unknown as AppDatabase;
}

describe('ASTERIX_PATTERN_GRAPH', () => {
  it('passes graph validation — two disjoint Trigger zones, consistent schema, valid Report sections', () => {
    expect(validateGraph(ASTERIX_PATTERN_GRAPH)).toEqual([]);
  });

  it('has exactly two Triggers, eight AgentCalls (seven Group-A/B feeding the Report, plus the separate diff AgentCall), one Report, two Sinks', () => {
    const kinds = ASTERIX_PATTERN_GRAPH.nodes.map(n => n.config.kind);
    expect(kinds.filter(k => k === 'Trigger')).toHaveLength(2);
    // The spec's "7 AgentCalls feeding a Report ... plus a separate diff AgentCall feeding its
    // own Sink" (task description) means 8 total AgentCall-kind nodes in the whole graph — the 7
    // Group-A/B agents under 'report', plus 'agent-diff' under 'sink-diff'.
    expect(kinds.filter(k => k === 'AgentCall')).toHaveLength(8);
    expect(kinds.filter(k => k === 'Report')).toHaveLength(1);
    expect(kinds.filter(k => k === 'Sink')).toHaveLength(2);
  });

  it("the Report node declares its 7 sections in the spec's stated order", () => {
    const report = ASTERIX_PATTERN_GRAPH.nodes.find(n => n.config.kind === 'Report')!;
    const titles = (report.config as { sections: Array<{ title: string }> }).sections.map(s => s.title);
    expect(titles).toEqual(['Overview', 'Wait Times', 'Opening Hours', 'Maps', 'Secrets', 'cURL Examples', 'Bypass Script']);
  });

  it('runs end to end against mocked executors with the Full Analysis trigger, Bypass Script failing', async () => {
    const db = makeDb();
    db.insert(schema.trackedApps).values({
      id: 17, packageName: 'fr.parcasterix.appli.android', appName: 'Parc Astérix', createdAt: new Date(),
    }).run();
    db.insert(schema.apkVersions).values({
      id: 431, trackedAppId: 17, versionCode: 1791383868, versionName: '6.10.1',
      filename: 'x.apk', fileSize: 150088871, source: 'device', downloadedAt: new Date('2026-10-09T22:16:21Z'),
    }).run();

    const executors = buildApkAnalysisExecutors();
    // Only AgentCall is overridden — Trigger, Report and Sink run for real against the in-memory
    // DB above, so this is the one test that exercises the real Report assembly + real Sink
    // writes, not mocks throughout.
    executors.AgentCall = vi.fn(async (config) => {
      if (config.instructionTemplate.includes('SSL pinning')) {
        throw new Error('Bypass Script agent unavailable this run');
      }
      return { text: `output for: ${config.instructionTemplate}` };
    });

    const ctx = buildApkAnalysisExecutionCtx({
      db,
      aiFactory: {} as unknown as AiAgentFactory,
      identity: { type: 'core-service' },
      versionId: 431,
    });

    const result = await runPipeline(ASTERIX_PATTERN_GRAPH, 'trigger-full', { versionId: 431 }, executors, ctx);

    expect(result.status).toBe('partial');

    const note = getNote(db, 431);
    expect(note).toContain('## Bypass Script');
    expect(note).toMatch(/Bypass Script[\s\S]*unavailable this run/);
    for (const title of ['Overview', 'Wait Times', 'Opening Hours', 'Maps', 'Secrets', 'cURL Examples']) {
      expect(note).toContain(`## ${title}`);
      expect(note).toContain(`output for:`);
    }
  });

  it("binds a fresh BoundAgent per AgentCall node, each with that node's own config.tier", async () => {
    const forCoreService = vi.fn(() => ({
      identity: {} as any,
      handleMessage: vi.fn(async (p: any) => { p.onToken('ok'); return { run: { requests: [] } }; }),
    }));
    const aiFactory = { forCoreService } as unknown as AiAgentFactory;
    const executors = buildApkAnalysisExecutors();
    const ctx = buildApkAnalysisExecutionCtx({ db: {} as any, aiFactory, identity: { type: 'core-service' }, versionId: 431 });

    // A full enough `trigger` scope that both nodes' real instructionTemplate placeholders
    // ({{trigger.appName}}/{{trigger.packageName}}/{{trigger.versionName}}) resolve — this test
    // is about per-node BoundAgent binding, not template resolution, so the input just needs to
    // not throw in resolveTemplate before handleMessage is ever reached.
    const triggerScope = { trigger: { appName: 'x', packageName: 'y', versionName: '1.0' } };
    await executors.AgentCall(
      ASTERIX_PATTERN_GRAPH.nodes.find(n => n.id === 'agent-overview')!.config as any,
      triggerScope,
      ctx,
    );
    await executors.AgentCall(
      ASTERIX_PATTERN_GRAPH.nodes.find(n => n.id === 'agent-bypass')!.config as any,
      triggerScope,
      ctx,
    );

    expect(forCoreService).toHaveBeenCalledTimes(2); // not once, reused — once per node
    expect(forCoreService).toHaveBeenCalledWith('apk-analyzer', { tier: 'High' });
  });
});

describe('seedApkAnalysisPipeline', () => {
  it('is idempotent — calling it twice leaves exactly one pipeline row and one published version', () => {
    const db = makeDb();
    seedApkAnalysisPipeline(db);
    seedApkAnalysisPipeline(db);

    const pipelines = db.select().from(aiPipelines).all();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].jobKind).toBe('apk-analysis');
    expect(pipelines[0].name).toBe('Astérix pattern');

    const versions = db.select().from(aiPipelineVersions).all();
    const published = versions.filter(v => v.status === 'published');
    expect(published).toHaveLength(1);
    expect(published[0].graph).toEqual(ASTERIX_PATTERN_GRAPH);
  });
});
