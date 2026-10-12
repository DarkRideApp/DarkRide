import { eq, and, desc } from 'drizzle-orm';
import type { PipelineGraph, Envelope } from './types';
import type { NodeExecutors, ExecutionCtx } from './pipeline-runner';
import { TRIGGER_SCHEMAS, runTrigger } from './nodes/trigger';
import { runAgentCall } from './nodes/agent-call';
import { runTransform } from './nodes/transform';
import { runBranch } from './nodes/branch';
import { runReport } from './nodes/report';
import { runForEach } from './nodes/foreach';
import { runSink } from './nodes/sink';
import type { AiAgentFactory } from '../ai-agent-factory';
import type { AppDatabase } from '../../db/index';
import { aiPipelines, aiPipelineVersions, settings } from '../../db/schema';
import { APK_VERSION_DETECTED_SCHEMA } from '../apk-tracker';

const PIPELINE_NAME = 'APK Analysis';

/**
 * Pipelines don't carry a "job kind" identity — a pipeline fires because a Trigger node is bound
 * to an event or run directly by id, not because of a string a human filled in on a form. The one
 * genuinely internal exception is apk-analyzer.ts's own Analyze-button flow: it isn't an event (a
 * human decides when to run it), so it needs SOME way to find "the" APK Analysis pipeline. This
 * settings key is that pointer — written once by seedApkAnalysisPipeline, read by
 * apk-analyzer.ts's runAiPipeline. It is never shown to a user and never duplicated as a pipeline
 * field.
 */
export const APK_ANALYSIS_PIPELINE_ID_SETTING = 'apk_analysis_pipeline_id';

// Both Triggers below pull their inputSchema/outputSchema straight from TRIGGER_SCHEMAS
// (nodes/trigger.ts) — the one place apk-analysis/apk-context's real contract is declared —
// instead of a hand-copied literal that could drift from what the function actually reads
// and returns.
const { inputSchema: APK_TRIGGER_INPUT_SCHEMA, outputSchema: APK_CONTEXT_SCHEMA } = TRIGGER_SCHEMAS['apk-analysis/apk-context'];

/**
 * The AI scopes the `apk-analyzer` core-service identity is registered with (backend/index.ts) —
 * the identity every auto-triggered run of this pipeline's AgentCalls executes as. Exported so
 * index.ts registers exactly this list and the tool-reachability test checks against the same
 * one. Widening it is a security decision (this agent reads attacker-controlled APK content),
 * not a way to make a tool "work".
 */
export const APK_ANALYZER_AI_SCOPES = ['core.apk:read', 'core.apk:manage', 'mcp'];

const GROUP_A_TOOLS = ['get_apk_overview', 'get_apk_strings', 'list_apk_assets', 'get_app_versions', 'search_apk_code', 'find_api_endpoints'];
// get_api_endpoint and get_map_config removed — found during the final review: neither ever
// resolved for this identity (get_api_endpoint needs core.traffic:read and a different context;
// get_map_config isn't a registered AI tool at all, only a Claude-Code-only MCP tool with the
// same name). Declaring a tool that can never run is worse than not declaring it — it tells the
// model (and anyone reading this list) it has a capability it never actually has.
const GROUP_B_TOOLS = ['search_apk_code', 'get_apk_strings', 'find_api_endpoints', 'detect_ssl_pinning'];
// search_credentials, list_api_endpoints, generate_ssl_bypass, inspect_class_methods removed for
// the same reason — each needs a scope (core.credentials:read / core.traffic:read /
// core.frida:manage) the apk-analyzer core identity does not have. Granting those scopes to an
// AUTOMATED, UNATTENDED identity that processes untrusted APK content would be a real security
// decision (letting a prompt-injectable agent autonomously read stored credentials or run Frida
// instrumentation) — deliberately NOT made here.

/**
 * The literal, real pipeline graph for the `apk-analysis` job kind — not a test fixture. Two
 * disjoint Trigger zones: "Full Analysis" (trigger-full) is a manual/on-demand command — a human
 * (or apk-analyzer.ts's own auto-analysis-on-download flow) decides when to run it, so it stays
 * function-sourced — fanning out to seven Group-A/B AgentCalls feeding a Report feeding a Sink.
 * "Quick Rescan" (trigger-rescan) is event-sourced from apk-tracker.ts's real `apk:version-
 * detected` hook — it genuinely IS an event ("a new version showed up"), so it runs through
 * HookTriggerDispatcher like any other event-sourced Trigger, with zero bespoke wiring — a single
 * diff AgentCall feeding its own Sink.
 */
export const ASTERIX_PATTERN_GRAPH: PipelineGraph = {
  nodes: [
    { id: 'trigger-full', label: 'Full Analysis', config: { kind: 'Trigger', source: 'function', expandFn: 'apk-analysis/apk-context', inputSchema: APK_TRIGGER_INPUT_SCHEMA, outputSchema: APK_CONTEXT_SCHEMA } },
    { id: 'trigger-rescan', label: 'Quick Rescan', config: { kind: 'Trigger', source: 'event', eventName: 'apk:version-detected', outputSchema: APK_VERSION_DETECTED_SCHEMA } },

    { id: 'agent-overview', label: 'App Overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Analyze {{trigger.appName}} ({{trigger.packageName}}) version {{trigger.versionName}}. Summarize purpose, framework, permissions and notable SDKs.' } },
    { id: 'agent-wait-times', label: 'Wait Times Agent', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Find how {{trigger.appName}} fetches ride wait times. Search for queue, wait and attraction-status endpoints.' } },
    { id: 'agent-opening-hours', label: 'Opening Hours Agent', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Find how {{trigger.appName}} v{{trigger.versionName}} fetches park opening hours and schedule data.' } },
    { id: 'agent-maps', label: 'Maps Agent', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_A_TOOLS, instructionTemplate: 'Describe the map system in {{trigger.packageName}}: offline tiles, bounds, or a live tile provider.' } },
    { id: 'agent-secrets', label: 'Secrets Agent', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: 'Document every hardcoded secret, API key and token in {{trigger.packageName}} v{{trigger.versionName}}, with file location.' } },
    { id: 'agent-curl', label: 'cURL Examples Agent', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: "Write runnable curl examples for {{trigger.appName}}'s discovered API endpoints, using the real extracted keys." } },
    { id: 'agent-bypass', label: 'SSL Bypass Script', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: GROUP_B_TOOLS, instructionTemplate: 'Write a Frida script bypassing SSL pinning in {{trigger.packageName}} v{{trigger.versionName}}.' } },

    { id: 'report', label: 'Full Report', config: { kind: 'Report', sections: [
      { title: 'Overview', from: 'agent-overview' },
      { title: 'Wait Times', from: 'agent-wait-times' },
      { title: 'Opening Hours', from: 'agent-opening-hours' },
      { title: 'Maps', from: 'agent-maps' },
      { title: 'Secrets', from: 'agent-secrets' },
      { title: 'cURL Examples', from: 'agent-curl' },
      { title: 'Bypass Script', from: 'agent-bypass' },
    ] } },
    // Both Sinks declare `from` — the executor wraps even a single predecessor's output by its
    // node id, so a write function needs to be told which key to unwrap.
    { id: 'sink-report', label: 'Save Full Report', config: { kind: 'Sink', writeFn: 'apk-analysis/write-full-document', from: 'report' } },

    { id: 'agent-diff', label: 'Version Diff', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: ['get_app_versions', 'search_apk_findings'], instructionTemplate: 'Compare {{trigger.appName}} v{{trigger.versionName}} against the previously analyzed version. Summarize what changed — new endpoints, new permissions, new SDKs.' } },
    { id: 'sink-diff', label: 'Save Diff Summary', config: { kind: 'Sink', writeFn: 'apk-analysis/write-section', from: 'agent-diff', section: 'Diff Summary' } },
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
    Trigger: (config, rawInput, ctx) => runTrigger(config, rawInput, { db: (ctx as { db: AppDatabase }).db }),
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

/**
 * Maps an arbitrary HookBus event payload to this job kind's required `versionId` — used only by
 * HookTriggerDispatcher's event-sourced buildCtx (backend/index.ts), never by the manual REST
 * /run path (which reads a Trigger's own declared inputSchema and is expected to let an absent
 * versionId flow through to the Trigger's own expand function for a more specific, node-
 * attributed error). `apk:analyzed`'s payload has `apkVersionId`; `apk:version-detected`'s does
 * not (it has `trackedAppId` — see Task 1's declared schema) — picking that event as a Trigger's
 * source must fail loudly here, not silently build a ctx with contextId "undefined".
 */
export function apkVersionIdFromEventPayload(payload: Record<string, unknown>): number {
  const value = payload.apkVersionId;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`This event's payload requires a numeric apkVersionId to drive the apk-analysis job kind, got ${JSON.stringify(payload)}`);
  }
  return value;
}

export function buildApkAnalysisExecutionCtx(
  deps: {
    db: AppDatabase; aiFactory: AiAgentFactory; identity: ApkAnalysisIdentity; versionId: number;
    /** Lets a core/notify Sink (nodes/sink.ts) reach the real NotificationService. Optional —
     *  most callers (e.g. unit tests) have no need for a Sink node to actually send anything. */
    notificationService?: { emit: (event: { type: string; title: string; body: string; sourceType?: string; sourceId?: string; url?: string }) => void };
  },
): ExecutionCtx {
  return {
    db: deps.db,
    aiFactory: deps.aiFactory,
    identity: deps.identity,
    contextId: String(deps.versionId),
    versionId: deps.versionId,
    notificationService: deps.notificationService,
  };
}

/**
 * Idempotent: resolves the existing row via APK_ANALYSIS_PIPELINE_ID_SETTING (self-healing if the
 * pointer is missing or stale — it's rewritten below whenever a fresh row is created) and patches
 * `name` if it drifted, so restarts never duplicate it. Also keeps the published graph itself in
 * sync with ASTERIX_PATTERN_GRAPH — a code change to the constant (e.g. Quick Rescan moving onto
 * apk:version-detected) must reach a pipeline that was already seeded on an earlier boot, or the
 * live system silently keeps running the old wiring until someone re-publishes by hand. Drift is
 * fixed the same way a human would: a new version is inserted and published, the old one demoted
 * to draft — exactly POST /v1/ai-pipelines/:id/publish's own semantics, never an in-place edit of
 * an already-published row.
 */
export function seedApkAnalysisPipeline(db: AppDatabase): void {
  const pointer = db.select().from(settings).where(eq(settings.key, APK_ANALYSIS_PIPELINE_ID_SETTING)).all()[0];
  const existing = pointer
    ? db.select().from(aiPipelines).where(eq(aiPipelines.id, Number(pointer.value))).all()[0]
    : undefined;

  if (!existing) {
    const now = new Date();
    const pipelineId = db.insert(aiPipelines).values({
      name: PIPELINE_NAME, createdAt: now,
    }).run().lastInsertRowid as number;

    db.insert(aiPipelineVersions).values({
      pipelineId, version: 1, graph: ASTERIX_PATTERN_GRAPH as any, status: 'published', createdAt: now,
    }).run();

    db.insert(settings).values({ key: APK_ANALYSIS_PIPELINE_ID_SETTING, value: String(pipelineId) })
      .onConflictDoUpdate({ target: settings.key, set: { value: String(pipelineId) } }).run();
    return;
  }

  if (existing.name !== PIPELINE_NAME) {
    db.update(aiPipelines).set({ name: PIPELINE_NAME }).where(eq(aiPipelines.id, existing.id)).run();
  }

  // No version at all for this row is left alone, same as before this drift check existed — we
  // only know how to correct a graph we already recognize as a prior shape of our own, not
  // conjure one from nothing for an arbitrary pre-existing row.
  const latest = db.select().from(aiPipelineVersions)
    .where(eq(aiPipelineVersions.pipelineId, existing.id))
    .orderBy(desc(aiPipelineVersions.version)).all()[0];
  if (!latest || JSON.stringify(latest.graph) === JSON.stringify(ASTERIX_PATTERN_GRAPH)) return;

  const now = new Date();
  const nextVersion = latest.version + 1;
  const newVersionId = db.insert(aiPipelineVersions).values({
    pipelineId: existing.id, version: nextVersion, graph: ASTERIX_PATTERN_GRAPH as any, status: 'draft', createdAt: now,
  }).run().lastInsertRowid as number;

  db.update(aiPipelineVersions).set({ status: 'draft' })
    .where(and(eq(aiPipelineVersions.pipelineId, existing.id), eq(aiPipelineVersions.status, 'published')))
    .run();
  db.update(aiPipelineVersions).set({ status: 'published' }).where(eq(aiPipelineVersions.id, newVersionId)).run();
}
