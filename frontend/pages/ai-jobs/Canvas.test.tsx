import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Canvas } from './Canvas';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

// @xyflow/react's <ReactFlow> observes its pane with a ResizeObserver, which jsdom does not
// implement — same shim as AiJobsWorkspace.test.tsx.
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

const graph: PipelineGraph = {
  nodes: [
    { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: [] } },
    { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: 'x' }, position: { x: 500, y: 500 } },
  ],
  edges: [{ from: 'trigger-full', to: 'agent-overview' }],
};

describe('Canvas', () => {
  it('clicking a node calls onSelectNode with its id', () => {
    const onSelectNode = vi.fn();
    render(<Canvas graph={graph} onSelectNode={onSelectNode} />);
    fireEvent.click(screen.getByText('agent-overview'));
    expect(onSelectNode).toHaveBeenCalledWith('agent-overview');
  });

  it('renders a node at its saved position instead of the placeholder grid slot', () => {
    render(<Canvas graph={graph} onSelectNode={() => {}} />);
    const node = screen.getByText('agent-overview').closest('.react-flow__node') as HTMLElement;
    // @xyflow/react positions nodes via a CSS transform carrying the x/y coordinates.
    expect(node.style.transform).toContain('500px');
  });

  it('falls back to the placeholder grid slot for a node with no saved position', () => {
    render(<Canvas graph={graph} onSelectNode={() => {}} />);
    const node = screen.getByText('trigger-full').closest('.react-flow__node') as HTMLElement;
    expect(node.style.transform).toContain('0px');
  });
});
