import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AiJobsWorkspace } from './AiJobsWorkspace';
import { createMockWs, withProviders, mockPipelineVersion } from './testing';

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
