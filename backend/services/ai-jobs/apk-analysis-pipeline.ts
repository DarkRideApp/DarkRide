import { eq, and } from 'drizzle-orm';
import type { PipelineGraph, Envelope } from './types';
import type { NodeExecutors, ExecutionCtx } from './pipeline-runner';
import { TRIGGER_REGISTRY } from './nodes/trigger';
import { runAgentCall } from './nodes/agent-call';
import { runTransform } from './nodes/transform';
import { runBranch } from './nodes/branch';
import { runReport } from './nodes/report';
import { runForEach } from './nodes/foreach';
import { runSink } from './nodes/sink';
import type { AiAgentFactory } from '../ai-agent-factory';
import type { AppDatabase } from '../../db/index';
import { aiPipelines, aiPipelineVersions } from '../../db/schema';

const PIPELINE_NAME = 'Astérix pattern';
const PIPELINE_JOB_KIND = 'apk-analysis';

const APK_CONTEXT_SCHEMA = [
  { field: 'appName', type: 'string', description: 'Display name' },
  { field: 'packageName', type: 'string', description: 'Reverse-DNS package name' },
  { field: 'versionName', type: 'string', description: 'Human version string' },
  { field: 'versionCode', type: 'number', description: 'Numeric version code' },
  { field: 'fileSizeBytes', type: 'number', description: 'APK file size in bytes' },
  { field: 'downloadedAt', type: 'string', description: 'ISO timestamp' },
  { field: 'source', type: 'string', description: "'device' | 'playstore' | 'qq' | 'upload'" },
];

const GROUP_A_TOOLS = ['get_apk_overview', 'get_apk_strings', 'list_apk_assets', 'get_app_versions', 'search_apk_code', 'find_api_endpoints', 'get_api_endpoint', 'get_map_config'];
const GROUP_B_TOOLS = ['search_credentials', 'search_apk_code', 'get_apk_strings', 'find_api_endpoints', 'get_api_endpoint', 'list_api_endpoints', 'detect_ssl_pinning', 'generate_ssl_bypass', 'inspect_class_methods'];

/**
 * The literal, real pipeline graph for the `apk-analysis` job kind — not a test fixture. Two
 * disjoint Trigger zones: "Full Analysis" (trigger-full) fans out to seven Group-A/B AgentCalls
 * feeding a Report feeding a Sink, and "Quick Rescan" (trigger-rescan) runs a single diff
 * AgentCall feeding its own Sink.
 */
export const ASTERIX_PATTERN_GRAPH: PipelineGraph = {
  nodes: [
    { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: APK_CONTEXT_SCHEMA } },
    { id: 'trigger-rescan', config: { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: APK_CONTEXT_SCHEMA } },

    { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Analyze {{trigger.appName}} ({{trigger.packageName}}) version {{trigger.versionName}}. Summarize purpose, framework, permissions and notable SDKs.' } },
    { id: 'agent-wait-times', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Find how {{trigger.appName}} fetches ride wait times. Search for queue, wait and attraction-status endpoints.' } },
    { id: 'agent-opening-hours', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Find how {{trigger.appName}} v{{trigger.versionName}} fetches park opening hours and schedule data.' } },
    { id: 'agent-maps', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Describe the map system in {{trigger.packageName}}: offline tiles, bounds, or a live tile provider.' } },
    { id: 'agent-secrets', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: 'Document every hardcoded secret, API key and token in {{trigger.packageName}} v{{trigger.versionName}}, with file location.' } },
    { id: 'agent-curl', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: "Write runnable curl examples for {{trigger.appName}}'s discovered API endpoints, using the real extracted keys." } },
    { id: 'agent-bypass', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: 'Write a Frida script bypassing SSL pinning in {{trigger.packageName}} v{{trigger.versionName}}.' } },

    { id: 'report', config: { kind: 'Report', sections: [
      { title: 'Overview', from: 'agent-overview' },
      { title: 'Wait Times', from: 'agent-wait-times' },
      { title: 'Opening Hours', from: 'agent-opening-hours' },
      { title: 'Maps', from: 'agent-maps' },
      { title: 'Secrets', from: 'agent-secrets' },
      { title: 'cURL Examples', from: 'agent-curl' },
      { title: 'Bypass Script', from: 'agent-bypass' },
    ] } },
    // Both Sinks declare `from` — the executor wraps even a single predecessor's output by its
    // node id (Tasks 13-17), so a write function needs to be told which key to unwrap. See the
    // SDD pre-flight fix to SinkConfig (Task 2) and sink.ts (Task 11).
    { id: 'sink-report', config: { kind: 'Sink', writeFn: 'apk-analysis/write-full-document', from: 'report' } },

    { id: 'agent-diff', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: ['get_app_versions', 'search_apk_findings'], instructionTemplate: 'Compare {{trigger.appName}} v{{trigger.versionName}} against the previously analyzed version. Summarize what changed — new endpoints, new permissions, new SDKs.' } },
    { id: 'sink-diff', config: { kind: 'Sink', writeFn: 'apk-analysis/write-section', from: 'agent-diff', section: 'Diff Summary' } },
  ],
  edges: [
    ...['agent-overview', 'agent-wait-times', 'agent-opening-hours', 'agent-maps', 'agent-secrets', 'agent-curl', 'agent-bypass']
      .map(agentId => ({ from: 'trigger-full', to: agentId })),
    ...['agent-overview', 'agent-wait-times', 'agent-opening-hours', 'agent-maps', 'agent-secrets', 'agent-curl', 'agent-bypass']
      .map(agentId => ({ from: agentId, to: 'report' })),
    { from: 'report', to: 'sink-report' },
    { from: 'trigger-rescan', to: 'agent-diff' },
    { from: 'agent-diff', to: 'sink-diff' },
  ],
};

export type ApkAnalysisIdentity = { type: 'core-service' } | { type: 'user'; userId: number };

export function buildApkAnalysisExecutors(): NodeExecutors {
  return {
    Trigger: async (config, rawInput, ctx) => {
      const expand = TRIGGER_REGISTRY[config.expandFn];
      if (!expand) throw new Error(`Unknown trigger expander "${config.expandFn}"`);
      return expand(rawInput, { db: (ctx as { db: AppDatabase }).db });
    },
    // Binds its OWN BoundAgent, per node, using this node's own config.tier — the whole point of
    // "one tier per AgentCall, no shared research/write pair" (spec, Architecture). A single
    // agent bound once for the entire run and reused by every node would silently defeat that:
    // every node would run on whatever tier the FIRST bind happened to use, regardless of its own
    // declared config.tier. Astérix's seven nodes all happen to declare "High" today, which is
    // exactly the kind of coincidence that hides this bug until a second pipeline uses two tiers.
    AgentCall: async (config, input, ctx) => {
      const c = ctx as { aiFactory: AiAgentFactory; identity: ApkAnalysisIdentity; contextId: string };
      const agent = c.identity.type === 'core-service'
        ? c.aiFactory.forCoreService('apk-analyzer', { tier: config.tier })
        : c.aiFactory.forUser(c.identity.userId, { tier: config.tier });
      return runAgentCall(config, input, { agent, contextId: c.contextId });
    },
    Transform: (config, input) => runTransform(config, input),
    Branch: (config, envelope) => runBranch(config, envelope),
    // Every AgentCall in this job kind returns { text: string } (Task 6) by construction, but the
    // generic NodeExecutors interface types a Report's envelopes as bare Envelope<unknown> — it
    // has no way to know a given job's AgentCall output shape. Narrowing the cast (not `as any`,
    // which hides any future shape mismatch) documents that assumption instead of erasing it.
    Report: (config, envelopes) => runReport(config, envelopes as Record<string, Envelope<{ text: string }>>),
    ForEach: async (config, items) => runForEach(config, items),
    Sink: async (config, input, ctx) => {
      const c = ctx as { db: AppDatabase; versionId: number };
      await runSink(config, input, c);
    },
  };
}

export function buildApkAnalysisExecutionCtx(
  deps: { db: AppDatabase; aiFactory: AiAgentFactory; identity: ApkAnalysisIdentity; versionId: number },
): ExecutionCtx {
  return {
    db: deps.db,
    aiFactory: deps.aiFactory,
    identity: deps.identity,
    contextId: String(deps.versionId),
    versionId: deps.versionId,
  };
}

/**
 * Seeds the Astérix pattern pipeline + its published version at server boot. Idempotent: checks
 * for an existing `aiPipelines` row with `jobKind: 'apk-analysis'` and name `'Astérix pattern'`
 * before inserting, so restarting the server never creates duplicate pipelines or versions.
 */
export function seedApkAnalysisPipeline(db: AppDatabase): void {
  const existing = db.select().from(aiPipelines)
    .where(and(eq(aiPipelines.jobKind, PIPELINE_JOB_KIND), eq(aiPipelines.name, PIPELINE_NAME)))
    .all()[0];
  if (existing) return;

  const now = new Date();
  const pipelineId = db.insert(aiPipelines).values({
    name: PIPELINE_NAME, jobKind: PIPELINE_JOB_KIND, createdAt: now,
  }).run().lastInsertRowid as number;

  db.insert(aiPipelineVersions).values({
    pipelineId, version: 1, graph: ASTERIX_PATTERN_GRAPH as any, status: 'published', createdAt: now,
  }).run();
}
