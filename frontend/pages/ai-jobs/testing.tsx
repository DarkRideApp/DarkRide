/**
 * Shared test support for the AI Job Pipelines workspace: fixture builders and a mock
 * websocket whose responses follow the real REST envelope and payload shape (see
 * backend/api/ai-pipelines.ts and backend/services/ai-jobs/apk-analysis-pipeline.ts).
 */
import React from 'react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { WebSocketContext, ToastProvider } from '@darkrideapp/plugin-sdk/react';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

// ── Fixture: the real apk-analysis graph ────────────────────────────────────
//
// Copied verbatim from backend/services/ai-jobs/apk-analysis-pipeline.ts's
// ASTERIX_PATTERN_GRAPH rather than inventing a smaller graph, so this fixture —
// and every test built on it — exercises the real shape the backend actually
// serves: 2 Trigger nodes, 8 AgentCall nodes, 1 Report node (7 sections), 2 Sink
// nodes. Duplicated here (not imported) because this is frontend test support
// and must not pull backend runtime code into the frontend test bundle.

const APK_CONTEXT_SCHEMA = [
  { field: 'appName', type: 'string', description: 'Display name' },
  { field: 'packageName', type: 'string', description: 'Reverse-DNS package name' },
  { field: 'versionName', type: 'string', description: 'Human version string' },
  { field: 'versionCode', type: 'number', description: 'Numeric version code' },
  { field: 'fileSizeBytes', type: 'number', description: 'APK file size in bytes' },
  { field: 'downloadedAt', type: 'string', description: 'ISO timestamp' },
  { field: 'source', type: 'string', description: "'device' | 'playstore' | 'qq' | 'upload'" },
];

const GROUP_A_TOOLS = ['get_apk_overview', 'get_apk_strings', 'list_apk_assets', 'get_app_versions', 'search_apk_code', 'find_api_endpoints'];
const GROUP_B_TOOLS = ['search_apk_code', 'get_apk_strings', 'find_api_endpoints', 'detect_ssl_pinning'];

const ASTERIX_PATTERN_GRAPH_FIXTURE: PipelineGraph = {
  nodes: [
    { id: 'trigger-full', label: 'Full Analysis', config: { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: APK_CONTEXT_SCHEMA } },
    { id: 'trigger-rescan', label: 'Quick Rescan', config: { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: APK_CONTEXT_SCHEMA } },

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

/**
 * Rows in the shape GET /v1/apps/recent really returns (backend/api/apps.ts: apkVersions rows
 * spread, plus packageName/appName from the tracked app). The first is what the workspace's
 * APK-version picker selects by default.
 */
export const RECENT_VERSIONS_FIXTURE = [
  { id: 42, trackedAppId: 1, versionCode: 1200, versionName: '12.0', appName: 'Parc Astérix', packageName: 'com.parcasterix.app' },
  { id: 41, trackedAppId: 1, versionCode: 1100, versionName: '11.0', appName: 'Parc Astérix', packageName: 'com.parcasterix.app' },
];

/** A pipeline version fixture carrying the real Astérix pattern graph. */
export function mockPipelineVersion(): { graph: PipelineGraph } {
  return { graph: ASTERIX_PATTERN_GRAPH_FIXTURE };
}

/** A row as GET /v1/ai-pipelines really returns it (backend/api/ai-pipelines.ts). */
export interface PipelineRowFixture { id: number; name?: string; jobKind: string; pipelineVersionId: number | null; graph: PipelineGraph | null }

export interface MockApiState {
  pipelineVersion: { graph: PipelineGraph };
  /** The full GET /v1/ai-pipelines list. Defaults to one apk-analysis row (id 1) carrying
   *  `pipelineVersion.graph` — every pre-existing test keeps working unchanged. */
  pipelines?: PipelineRowFixture[];
  /** Make a path answer with a failure. Keyed `${method} ${path}`. */
  failing: Set<string>;
  /** Override a response. Keyed `${method} ${path}`; may be async. */
  routes: Record<string, (body?: any) => unknown | Promise<unknown>>;
}

export function mockApiState(over: Partial<MockApiState> = {}): MockApiState {
  return {
    pipelineVersion: mockPipelineVersion(),
    failing: new Set(),
    routes: {},
    ...over,
  };
}

const envelope = (body: unknown, status = 200) => ({ type: 'restapi', id: 'x', status, body });

export function createMockWs(over: Partial<MockApiState> = {}): WebSocketContextValue {
  const state = mockApiState(over);
  const sendRestApi = vi.fn(async (method: string, path: string, body?: any) => {
    const key = `${method} ${path}`;
    if (state.failing.has(key)) return envelope({ success: false, error: `${key} failed` }, 502);
    const custom = state.routes[key];
    if (custom) return envelope(await custom(body));

    const pipelines = state.pipelines ?? [{ id: 1, jobKind: 'apk-analysis', pipelineVersionId: 1, graph: state.pipelineVersion.graph }];
    if (key === 'GET /v1/ai-pipelines') {
      // Matches backend/api/ai-pipelines.ts's real GET handler: an array under `data`, each
      // row carrying jobKind, pipelineVersionId and the published version's graph inlined.
      return envelope({ success: true, data: pipelines });
    }
    const singlePipelineMatch = key.match(/^GET \/v1\/ai-pipelines\/(\d+)$/);
    if (singlePipelineMatch) {
      const row = pipelines.find(p => p.id === Number(singlePipelineMatch[1]));
      if (!row) return envelope({ success: false, error: `No pipeline with id ${singlePipelineMatch[1]}.` }, 404);
      return envelope({ success: true, data: row });
    }
    if (key === 'GET /v1/apps/recent') {
      return envelope({ success: true, data: RECENT_VERSIONS_FIXTURE });
    }
    return envelope({ success: true });
  });

  return {
    connected: true,
    serverReady: true,
    startupMessage: '',
    sendMessage: vi.fn(),
    sendRestApi,
    subscribe: vi.fn().mockReturnValue(() => {}),
  } as unknown as WebSocketContextValue;
}

/** Providers every AI Job Pipelines workspace component expects. */
export function withProviders(ws: WebSocketContextValue, initialEntry = '/ui/pipelines') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <WebSocketContext.Provider value={ws}>
        <ToastProvider>
          <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
        </ToastProvider>
      </WebSocketContext.Provider>
    );
  };
}

/** Paths a mock ws was called with, as `METHOD path`. */
export function calledPaths(ws: WebSocketContextValue): string[] {
  return (ws.sendRestApi as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
    (c: unknown[]) => `${c[0]} ${c[1]}`,
  );
}
