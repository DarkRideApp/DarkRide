import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WebSocketContextValue } from '@darkrideapp/plugin-sdk/react';
import { AiJobsWorkspace, findOwningTriggerSchema } from './AiJobsWorkspace';
import { createMockWs, withProviders, mockPipelineVersion, calledPaths, RECENT_VERSIONS_FIXTURE } from './testing';
import { STATUS_COLOR } from './Canvas';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

// @xyflow/react's <ReactFlow> observes its pane with a ResizeObserver, which jsdom does not
// implement. Polyfilled locally (not in the shared frontend/test-setup.ts) since this is the
// only test file that renders a React Flow canvas — same pattern as
// frontend/components/traffic/TrafficTable.test.tsx's virtualizer ResizeObserver shim.
let realRO: typeof ResizeObserver | undefined;
beforeEach(() => {
  realRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  globalThis.ResizeObserver = realRO as typeof ResizeObserver;
});

describe('AiJobsWorkspace', () => {
  it('renders the Trigger, AgentCall, Report and Sink nodes from the fetched pipeline', async () => {
    const ws = createMockWs({ pipelineVersion: mockPipelineVersion() });
    render(<AiJobsWorkspace />, { wrapper: withProviders(ws) });

    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    // The Report node's rendered section titles — from the real ASTERIX_PATTERN_GRAPH
    // (Task 20), not an invented "Assemble notes" label (that string appears nowhere in the
    // real pipeline; the Report node's id is `report` and its sections are titled
    // Overview/Wait Times/Opening Hours/Maps/Secrets/cURL Examples/Bypass Script).
    expect(screen.getByText('Wait Times')).toBeInTheDocument();
    expect(screen.getAllByText(/AGENTCALL/i).length).toBeGreaterThanOrEqual(7);
  });

  it('Run POSTs .../run with the selected APK versionId, polls GET .../runs/:runId until it settles, and applies node status styling', async () => {
    // POST .../run answers { runId, status: 'running' } as soon as the run is recorded — it never
    // carries per-node results — so the workspace polls GET .../runs/:runId (shape { run, nodes })
    // until run.status leaves 'running'. The first poll here still says 'running', to prove the
    // loop keeps going rather than stopping at one GET.
    let polls = 0;
    const ws = createMockWs({
      pipelineVersion: mockPipelineVersion(),
      routes: {
        'POST /v1/ai-pipelines/1/run': () => ({ success: true, data: { runId: 7, status: 'running' } }),
        'GET /v1/ai-pipelines/runs/7': () => {
          polls++;
          if (polls === 1) return { success: true, data: { run: { id: 7, status: 'running' }, nodes: [] } };
          return {
            success: true,
            data: {
              run: { id: 7, status: 'partial' },
              nodes: [
                { runId: 7, nodeId: 'agent-overview', status: 'ok', wasMemoized: false },
                { runId: 7, nodeId: 'agent-wait-times', status: 'failed', wasMemoized: false },
                { runId: 7, nodeId: 'agent-maps', status: 'skipped', wasMemoized: false },
              ],
            },
          };
        },
      },
    });
    render(<AiJobsWorkspace pollIntervalMs={0} />, { wrapper: withProviders(ws) });

    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    await waitFor(() => expect((screen.getByLabelText('APK version') as HTMLSelectElement).value).toBe(String(RECENT_VERSIONS_FIXTURE[0].id)));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(polls).toBe(2));
    const paths = calledPaths(ws);
    // Order matters: the run-detail GET must follow the run POST, never precede or replace it.
    expect(paths.indexOf('POST /v1/ai-pipelines/1/run')).toBeLessThan(paths.indexOf('GET /v1/ai-pipelines/runs/7'));
    expect(paths.filter(p => p === 'GET /v1/ai-pipelines/runs/7')).toHaveLength(2);

    // C1a regression guard: the run must carry the selected APK version, never `input: {}` —
    // the pipeline's Trigger throws without a versionId.
    expect(postBody(ws, 'POST /v1/ai-pipelines/1/run')).toEqual({
      triggerNodeId: 'trigger-full', input: { versionId: RECENT_VERSIONS_FIXTURE[0].id }, reuseUnchanged: false,
    });

    await waitFor(() => {
      const overviewNode = screen.getByText('agent-overview').closest('.react-flow__node') as HTMLElement;
      expect(overviewNode.style.outline).toContain(STATUS_COLOR.ok);
      const waitTimesNode = screen.getByText('agent-wait-times').closest('.react-flow__node') as HTMLElement;
      expect(waitTimesNode.style.outline).toContain(STATUS_COLOR.failed);
      // M2: a skipped node gets its own outline instead of looking untouched.
      const mapsNode = screen.getByText('agent-maps').closest('.react-flow__node') as HTMLElement;
      expect(mapsNode.style.outline).toContain(STATUS_COLOR.skipped);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Run 7 finished: partial');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).not.toBeDisabled());
  });

  it('runs against whichever APK version the picker has selected', async () => {
    const ws = createMockWs({
      routes: {
        'POST /v1/ai-pipelines/1/run': () => ({ success: true, data: { runId: 8, status: 'running' } }),
        'GET /v1/ai-pipelines/runs/8': () => ({ success: true, data: { run: { id: 8, status: 'ok' }, nodes: [] } }),
      },
    });
    render(<AiJobsWorkspace pollIntervalMs={0} />, { wrapper: withProviders(ws) });

    await waitFor(() => expect(screen.getByRole('option', { name: /v11\.0 \(#41\)/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('APK version'), { target: { value: '41' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(calledPaths(ws)).toContain('POST /v1/ai-pipelines/1/run'));
    expect(postBody(ws, 'POST /v1/ai-pipelines/1/run').input).toEqual({ versionId: 41 });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Run 8 finished: ok'));
  });

  it('shows the server error and does not poll when the POST is refused (e.g. 409 already running)', async () => {
    const ws = createMockWs({
      routes: {
        'POST /v1/ai-pipelines/1/run': () => ({ success: false, error: 'A run is already running for this pipeline version (run 3)' }),
      },
    });
    render(<AiJobsWorkspace pollIntervalMs={0} />, { wrapper: withProviders(ws) });

    await waitFor(() => expect((screen.getByLabelText('APK version') as HTMLSelectElement).value).toBe('42'));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/already running/));
    expect(calledPaths(ws).some(p => p.startsWith('GET /v1/ai-pipelines/runs/'))).toBe(false);
  });

  it('does not POST a run when there is no APK version to run against', async () => {
    const ws = createMockWs({ routes: { 'GET /v1/apps/recent': () => ({ success: true, data: [] }) } });
    render(<AiJobsWorkspace pollIntervalMs={0} />, { wrapper: withProviders(ws) });

    await waitFor(() => expect(screen.getByRole('option', { name: 'No analyzed APK versions yet' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/select an apk version/i));
    expect(calledPaths(ws)).not.toContain('POST /v1/ai-pipelines/1/run');
  });

  it('switching to a different node shows that node\'s own prompt, not the previous one (I7)', async () => {
    const ws = createMockWs();
    render(<AiJobsWorkspace />, { wrapper: withProviders(ws) });
    await waitFor(() => expect(screen.getByText('agent-overview')).toBeInTheDocument());

    fireEvent.click(screen.getByText('agent-overview'));
    const overviewPanel = await screen.findByRole('dialog', { name: 'agent-overview details' });
    expect((overviewPanel.querySelector('textarea') as HTMLTextAreaElement).value).toMatch(/^Analyze \{\{trigger\.appName\}\}/);

    fireEvent.click(screen.getByText('agent-maps'));
    const mapsPanel = await screen.findByRole('dialog', { name: 'agent-maps details' });
    const textarea = mapsPanel.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Describe the map system in {{trigger.packageName}}: offline tiles, bounds, or a live tile provider.');

    // Editing now must save under agent-maps, and leave agent-overview's prompt untouched.
    fireEvent.change(textarea, { target: { value: 'maps prompt edited' } });
    fireEvent.click(screen.getByText('agent-overview'));
    const backToOverview = await screen.findByRole('dialog', { name: 'agent-overview details' });
    expect((backToOverview.querySelector('textarea') as HTMLTextAreaElement).value).toMatch(/^Analyze /);
    fireEvent.click(screen.getByText('agent-maps'));
    const mapsAgain = await screen.findByRole('dialog', { name: 'agent-maps details' });
    expect((mapsAgain.querySelector('textarea') as HTMLTextAreaElement).value).toBe('maps prompt edited');
  });
});

function postBody(ws: WebSocketContextValue, key: string): any {
  const call = (ws.sendRestApi as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(c => `${c[0]} ${c[1]}` === key);
  return call?.[2];
}

describe('findOwningTriggerSchema', () => {
  // Two disjoint Trigger zones with genuinely DIFFERENT outputSchemas. The real
  // ASTERIX_PATTERN_GRAPH fixture (testing.tsx) has two Triggers that happen to share one
  // schema, which would pass even a "always return the first Trigger" implementation — this
  // fixture is built specifically to catch that bug (see task-23-brief.md's correction).
  const SCHEMA_A = [{ field: 'appName', type: 'string', description: 'Display name' }];
  const SCHEMA_B = [{ field: 'rescanReason', type: 'string', description: 'Why the rescan fired' }];

  const twoZoneGraph: PipelineGraph = {
    nodes: [
      { id: 'trigger-a', config: { kind: 'Trigger', expandFn: 'zone-a', outputSchema: SCHEMA_A } },
      { id: 'trigger-b', config: { kind: 'Trigger', expandFn: 'zone-b', outputSchema: SCHEMA_B } },
      { id: 'agent-in-a', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: 'a' } },
      { id: 'agent-in-b', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: 'b' } },
    ],
    edges: [
      { from: 'trigger-a', to: 'agent-in-a' },
      { from: 'trigger-b', to: 'agent-in-b' },
    ],
  };

  it('gives a node in the second Trigger zone that zone\'s schema, not the first\'s', () => {
    expect(findOwningTriggerSchema(twoZoneGraph, 'agent-in-b')).toBe(SCHEMA_B);
    expect(findOwningTriggerSchema(twoZoneGraph, 'agent-in-a')).toBe(SCHEMA_A);
  });
});
