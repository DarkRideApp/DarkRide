import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AiJobsWorkspace, findOwningTriggerSchema } from './AiJobsWorkspace';
import { createMockWs, withProviders, mockPipelineVersion } from './testing';
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
