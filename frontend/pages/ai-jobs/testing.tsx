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

// ── Fixture: the real Astérix pattern graph ─────────────────────────────────
//
// Copied verbatim from backend/services/ai-jobs/apk-analysis-pipeline.ts's
// ASTERIX_PATTERN_GRAPH (Task 20) rather than inventing a smaller graph, so this
// fixture — and every test built on it — exercises the real shape the backend
// actually serves: 2 Trigger nodes, 8 AgentCall nodes, 1 Report node (7 sections),
// 2 Sink nodes. Duplicated here (not imported) because this is frontend test
// support and must not pull backend runtime code into the frontend test bundle.

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

const ASTERIX_PATTERN_GRAPH_FIXTURE: PipelineGraph = {
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

export interface MockApiState {
  pipelineVersion: { graph: PipelineGraph };
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

    if (key === 'GET /v1/ai-pipelines') {
      // Matches backend/api/ai-pipelines.ts's real GET handler: an array under `data`, each
      // row carrying jobKind, pipelineVersionId and the published version's graph inlined.
      return envelope({
        success: true,
        data: [{ id: 1, jobKind: 'apk-analysis', pipelineVersionId: 1, graph: state.pipelineVersion.graph }],
      });
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
