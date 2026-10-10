import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AiJobsWorkspace, findOwningTriggerSchema } from './AiJobsWorkspace';
import { createMockWs, withProviders, mockPipelineVersion, calledPaths } from './testing';
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

  it('Run calls POST .../run then GET .../runs/:runId in order, and applies node status styling', async () => {
    // POST .../run (backend/api/ai-pipelines.ts:154) never carries per-node results — only
    // { runId, status } — so the workspace must follow up with a GET on the returned runId
    // (ai-pipelines.ts:166-172, shape { run, nodes }) to actually populate node styling.
    const ws = createMockWs({
      pipelineVersion: mockPipelineVersion(),
      routes: {
        'POST /v1/ai-pipelines/1/run': () => ({ success: true, data: { runId: 7, status: 'ok' } }),
        'GET /v1/ai-pipelines/runs/7': () => ({
          success: true,
          data: {
            run: { id: 7, status: 'ok' },
            nodes: [
              { runId: 7, nodeId: 'agent-overview', status: 'ok', wasMemoized: false },
              { runId: 7, nodeId: 'agent-wait-times', status: 'failed', wasMemoized: false },
            ],
          },
        }),
      },
    });
    render(<AiJobsWorkspace />, { wrapper: withProviders(ws) });

    await waitFor(() => expect(screen.getByText('Overview')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(calledPaths(ws)).toEqual(
      expect.arrayContaining(['GET /v1/ai-pipelines', 'POST /v1/ai-pipelines/1/run', 'GET /v1/ai-pipelines/runs/7']),
    ));
    // Order matters: the run-detail GET must follow the run POST, never precede or replace it.
    const paths = calledPaths(ws);
    expect(paths.indexOf('POST /v1/ai-pipelines/1/run')).toBeLessThan(paths.indexOf('GET /v1/ai-pipelines/runs/7'));

    await waitFor(() => {
      const overviewNode = screen.getByText('agent-overview').closest('.react-flow__node') as HTMLElement;
      expect(overviewNode.style.outline).toContain('#22c55e'); // STATUS_COLOR.ok
      const waitTimesNode = screen.getByText('agent-wait-times').closest('.react-flow__node') as HTMLElement;
      expect(waitTimesNode.style.outline).toContain('#ef4444'); // STATUS_COLOR.failed
    });
  });
});

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
