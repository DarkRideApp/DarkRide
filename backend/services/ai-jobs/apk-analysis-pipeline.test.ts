import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { describe, it, expect, vi } from 'vitest';
import * as schema from '../../db/schema';
import { getNote } from '../apk-notes';
import { validateGraph } from './graph-validator';
import { runPipeline } from './pipeline-runner';
import { AiToolRegistry } from '../ai-tools';
import { registerAllTools } from '../ai-tool-definitions';
import {
  APK_ANALYZER_AI_SCOPES,
  ASTERIX_PATTERN_GRAPH,
  buildApkAnalysisExecutors,
  buildApkAnalysisExecutionCtx,
  apkVersionIdFromEventPayload,
  seedApkAnalysisPipeline,
  APK_ANALYSIS_PIPELINE_ID_SETTING,
} from './apk-analysis-pipeline';
import { TRIGGER_SCHEMAS } from './nodes/trigger';
import { APK_VERSION_DETECTED_SCHEMA } from '../apk-tracker';
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
    CREATE TABLE ai_pipelines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE ai_pipeline_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pipeline_id INTEGER NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      graph TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      UNIQUE(pipeline_id, version)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return drizzle(sqlite, { schema }) as unknown as AppDatabase;
}

describe('ASTERIX_PATTERN_GRAPH', () => {
  it('passes graph validation — two disjoint Trigger zones, consistent schema, valid Report sections', () => {
    expect(validateGraph(ASTERIX_PATTERN_GRAPH)).toEqual([]);
  });

  // Regression guard for the bug Cube hit live: Full Analysis's schema used to be a hand-copied
  // APK_TRIGGER_INPUT_SCHEMA/APK_CONTEXT_SCHEMA constant, kept in sync with apk-analysis/apk-
  // context's real contract by nothing but a code comment. It now comes straight from
  // TRIGGER_SCHEMAS (nodes/trigger.ts), so this seed can never drift from what the function
  // underneath actually reads and returns.
  it("Full Analysis's schema comes from TRIGGER_SCHEMAS, not a hand-maintained copy", () => {
    const trigger = ASTERIX_PATTERN_GRAPH.nodes.find(n => n.id === 'trigger-full')!;
    const config = trigger.config as { expandFn: string; inputSchema?: unknown; outputSchema: unknown };
    expect(config.inputSchema).toEqual(TRIGGER_SCHEMAS[config.expandFn].inputSchema);
    expect(config.outputSchema).toEqual(TRIGGER_SCHEMAS[config.expandFn].outputSchema);
  });

  // Same drift guard for Quick Rescan: its schema must come straight from apk-tracker.ts's own
  // APK_VERSION_DETECTED_SCHEMA, since it's event-sourced from apk:version-detected — never a
  // hand-copied literal that could drift from what that event actually carries.
  it("Quick Rescan is event-sourced from apk:version-detected, schema from APK_VERSION_DETECTED_SCHEMA", () => {
    const trigger = ASTERIX_PATTERN_GRAPH.nodes.find(n => n.id === 'trigger-rescan')!;
    const config = trigger.config as { source?: string; eventName?: string; expandFn?: string; outputSchema: unknown };
    expect(config.source).toBe('event');
    expect(config.eventName).toBe('apk:version-detected');
    expect(config.expandFn).toBeUndefined();
    expect(config.outputSchema).toEqual(APK_VERSION_DETECTED_SCHEMA);
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

describe('apkVersionIdFromEventPayload', () => {
  // Regression guard from the final review's I2: HookTriggerDispatcher's buildCtx (backend/
  // index.ts) builds this job kind's ctx from an arbitrary event's payload, cast `as number`.
  // Without this guard, an event whose payload lacks a real numeric apkVersionId silently builds
  // a ctx with contextId "undefined" and every Sink write targets a bogus version row.
  it('returns apkVersionId when the payload actually has one (apk:analyzed, or apk:version-detected when a download happened)', () => {
    expect(apkVersionIdFromEventPayload({ apkVersionId: 42, packageName: 'x' })).toBe(42);
  });

  it('throws when the payload has no apkVersionId key at all', () => {
    expect(() => apkVersionIdFromEventPayload({ trackedAppId: 1, packageName: 'x' }))
      .toThrow(/requires a numeric apkVersionId/);
  });

  // apk:version-detected emits apkVersionId: null when auto-analyse is off and nothing was
  // downloaded — Quick Rescan has nothing to re-scan in that case, and must fail loud here
  // (HookTriggerDispatcher logs and moves on) rather than running against a bogus version.
  it('throws when apkVersionId is explicitly null (apk:version-detected, auto-analyse off)', () => {
    expect(() => apkVersionIdFromEventPayload({ apkVersionId: null, trackedAppId: 1 }))
      .toThrow(/requires a numeric apkVersionId/);
  });

  it('throws when apkVersionId is present but not a number', () => {
    expect(() => apkVersionIdFromEventPayload({ apkVersionId: 'not-a-number' }))
      .toThrow(/requires a numeric apkVersionId/);
  });
});

describe('ASTERIX_PATTERN_GRAPH tool allowlists', () => {
  // Regression guard for the final review's I3: about half the declared tool names could never
  // reach the model — one wasn't a registered AI tool at all, the rest needed a context or scope
  // the apk-analyzer identity doesn't have. Resolves through the SAME registry call the agent loop
  // uses (pageContext 'apk-analysis', unattended because AgentCall runs in 'silent' mode), as the
  // auto-trigger identity, so a dead name fails here instead of silently shrinking the agent.
  const agentCalls = ASTERIX_PATTERN_GRAPH.nodes.filter(n => n.config.kind === 'AgentCall');

  function reachableToolNames(): Set<string> {
    const registry = new AiToolRegistry();
    registerAllTools(registry, makeDb() as any);
    const defs = registry.getToolDefinitionsForUser('apk-analysis', new Set(APK_ANALYZER_AI_SCOPES), true);
    return new Set(defs.map(d => d.name));
  }

  it('every allowlisted tool on every AgentCall resolves for the apk-analyzer identity under apk-analysis', () => {
    const reachable = reachableToolNames();
    const dead = agentCalls.flatMap(n =>
      (n.config as { toolAllowlist: string[] }).toolAllowlist
        .filter(name => !reachable.has(name))
        .map(name => `${n.id}: ${name}`),
    );
    expect(dead).toEqual([]);
  });

  it('every allowlisted tool is a registered apk-analysis tool needing only core.apk:read or core.apk:manage', () => {
    const registry = new AiToolRegistry();
    registerAllTools(registry, makeDb() as any);
    const names = new Set(agentCalls.flatMap(n => (n.config as { toolAllowlist: string[] }).toolAllowlist));
    for (const name of names) {
      const tool = registry.getToolsForContext('apk-analysis').find(t => t.name === name);
      expect(tool, `${name} is not a registered apk-analysis tool`).toBeDefined();
      expect(['core.apk:read', 'core.apk:manage']).toContain(tool!.requiredScope);
    }
  });

  it('does not widen the apk-analyzer identity beyond apk scopes', () => {
    expect(APK_ANALYZER_AI_SCOPES).toEqual(['core.apk:read', 'core.apk:manage', 'mcp']);
  });
});

describe('seedApkAnalysisPipeline', () => {
  it('is idempotent — calling it twice leaves exactly one pipeline row and one published version', () => {
    const db = makeDb();
    seedApkAnalysisPipeline(db);
    seedApkAnalysisPipeline(db);

    const pipelines = db.select().from(aiPipelines).all();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].name).toBe('APK Analysis');

    // Resolved by a settings pointer, not a pipeline-level field — the pipeline itself carries
    // no job-kind identity.
    const pointer = db.select().from(schema.settings).where(eq(schema.settings.key, APK_ANALYSIS_PIPELINE_ID_SETTING)).all()[0];
    expect(pointer?.value).toBe(String(pipelines[0].id));

    const versions = db.select().from(aiPipelineVersions).all();
    const published = versions.filter(v => v.status === 'published');
    expect(published).toHaveLength(1);
    expect(published[0].graph).toEqual(ASTERIX_PATTERN_GRAPH);
  });

  it('self-heals a stale display name on an existing row instead of inserting a duplicate', () => {
    const db = makeDb();
    const pipelineId = db.insert(aiPipelines).values({ name: 'Astérix pattern', createdAt: new Date() }).run().lastInsertRowid as number;
    db.insert(schema.settings).values({ key: APK_ANALYSIS_PIPELINE_ID_SETTING, value: String(pipelineId) }).run();

    seedApkAnalysisPipeline(db);

    const pipelines = db.select().from(aiPipelines).all();
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].name).toBe('APK Analysis');
    // No version was inserted for the pre-existing row — seeding only patches the name.
    expect(db.select().from(aiPipelineVersions).all()).toHaveLength(0);
  });

  // Covers the real migration this seed now has to perform: a pipeline that was seeded before
  // Quick Rescan became event-sourced has a published version whose graph no longer matches
  // ASTERIX_PATTERN_GRAPH. A boot-time constant change must actually reach a pipeline that was
  // seeded before this code shipped, or the live system never picks up the new wiring until
  // someone manually re-publishes through the UI.
  it('republishes a new version when the published graph has drifted from ASTERIX_PATTERN_GRAPH, exactly like a manual /publish', () => {
    const db = makeDb();
    const now = new Date();
    const pipelineId = db.insert(aiPipelines).values({ name: 'APK Analysis', createdAt: now }).run().lastInsertRowid as number;
    db.insert(schema.settings).values({ key: APK_ANALYSIS_PIPELINE_ID_SETTING, value: String(pipelineId) }).run();
    const staleGraph = { ...ASTERIX_PATTERN_GRAPH, nodes: [] }; // stand-in for "an older shape"
    const staleVersionId = db.insert(aiPipelineVersions).values({
      pipelineId, version: 1, graph: staleGraph as any, status: 'published', createdAt: now,
    }).run().lastInsertRowid as number;

    seedApkAnalysisPipeline(db);

    const versions = db.select().from(aiPipelineVersions).all().filter(v => v.pipelineId === pipelineId);
    expect(versions).toHaveLength(2);

    const stale = versions.find(v => v.id === staleVersionId)!;
    expect(stale.status).toBe('draft'); // demoted, not deleted — matches /publish's own demotion

    const published = versions.find(v => v.status === 'published')!;
    expect(published.version).toBe(2);
    expect(published.graph).toEqual(ASTERIX_PATTERN_GRAPH);
  });

  it('does not republish when the published graph already matches ASTERIX_PATTERN_GRAPH', () => {
    const db = makeDb();
    seedApkAnalysisPipeline(db);
    seedApkAnalysisPipeline(db); // second call: graph already matches, must be a no-op

    expect(db.select().from(aiPipelineVersions).all()).toHaveLength(1);
  });
});
