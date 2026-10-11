import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Canvas, toFlowEdges, toFlowNodes } from './Canvas';
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

  it('shows a node\'s label as its primary text, kind + id as secondary, when a label is set', () => {
    const labeled: PipelineGraph = {
      nodes: [{ id: 'agent-1', label: 'Overview Agent', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: 'x' } }],
      edges: [],
    };
    render(<Canvas graph={labeled} onSelectNode={() => {}} />);
    expect(screen.getByText('Overview Agent')).toBeInTheDocument();
    expect(screen.getByText('agent-1')).toBeInTheDocument();
    expect(screen.getByText('Agent Call')).toBeInTheDocument();
  });

  it('falls back to the kind\'s display label when a node has no label', () => {
    render(<Canvas graph={graph} onSelectNode={() => {}} />);
    expect(screen.getByText('Agent Call')).toBeInTheDocument();
    expect(screen.getByText('Trigger')).toBeInTheDocument();
  });

  it('a Report node with multiple sections renders one target handle per section, each labeled by its title', () => {
    const reportGraph: PipelineGraph = {
      nodes: [
        { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
        { id: 'report', config: { kind: 'Report', sections: [{ title: 'Overview', from: 'agent-overview' }, { title: 'Maps', from: '' }] } },
      ],
      edges: [{ from: 'agent-overview', to: 'report' }],
    };
    render(<Canvas graph={reportGraph} onSelectNode={() => {}} />);
    const reportNode = screen.getByText('report').closest('.react-flow__node') as HTMLElement;
    expect(reportNode.querySelectorAll('[data-handleid="section-0"]')).toHaveLength(1);
    expect(reportNode.querySelectorAll('[data-handleid="section-1"]')).toHaveLength(1);
    expect(reportNode.querySelectorAll('[data-handleid="out"]')).toHaveLength(1);
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Maps')).toBeInTheDocument();
    // Sanity: these are real React Flow handles, not just text — exactly 3 on this one node.
    expect(reportNode.querySelectorAll('.react-flow__handle')).toHaveLength(3);
  });

  it('a Branch node renders one source handle per declared edge label, and none when it has no edges declared', () => {
    const branchGraph: PipelineGraph = {
      nodes: [{ id: 'branch-1', config: { kind: 'Branch', predicate: 'x', edges: ['yes', 'no'] } }],
      edges: [],
    };
    render(<Canvas graph={branchGraph} onSelectNode={() => {}} />);
    const branchNode = screen.getByText('branch-1').closest('.react-flow__node') as HTMLElement;
    expect(branchNode.querySelectorAll('[data-handleid="yes"]')).toHaveLength(1);
    expect(branchNode.querySelectorAll('[data-handleid="no"]')).toHaveLength(1);
    expect(screen.getByText('yes')).toBeInTheDocument();
    expect(screen.getByText('no')).toBeInTheDocument();
  });

  it('a failed node carries its error text as a hover title, so the reason is visible without opening the side panel', () => {
    const nodeStatuses = { 'agent-overview': { status: 'failed', error: 'boom: something broke' } };
    render(<Canvas graph={graph} onSelectNode={() => {}} nodeStatuses={nodeStatuses} />);
    const content = screen.getByText('agent-overview').closest('.ai-jobs-node-content') as HTMLElement;
    expect(content).toHaveAttribute('title', 'boom: something broke');
  });

  it('a skipped node explains itself as an upstream failure, even though it carries no error of its own', () => {
    const nodeStatuses = { 'agent-overview': { status: 'skipped' } };
    render(<Canvas graph={graph} onSelectNode={() => {}} nodeStatuses={nodeStatuses} />);
    const content = screen.getByText('agent-overview').closest('.ai-jobs-node-content') as HTMLElement;
    expect(content).toHaveAttribute('title', 'Skipped — an upstream node failed.');
  });

  it('a node with no run status, or a successful one, has no title tooltip', () => {
    render(<Canvas graph={graph} onSelectNode={() => {}} nodeStatuses={{ 'agent-overview': { status: 'ok' } }} />);
    const content = screen.getByText('agent-overview').closest('.ai-jobs-node-content') as HTMLElement;
    expect(content).not.toHaveAttribute('title');
  });
});

describe('toFlowNodes', () => {
  it('widens the placeholder grid columns to clear the widest node in the graph — a wide Report must not overlap its row-neighbor', () => {
    const g: PipelineGraph = {
      nodes: [
        { id: 'report', config: { kind: 'Report', sections: Array.from({ length: 7 }, (_, i) => ({ title: `Section ${i}`, from: '' })) } },
        { id: 'agent-1', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
      ],
      edges: [],
    };
    const nodes = toFlowNodes(g);
    const report = nodes.find(n => n.id === 'report')!;
    const agent = nodes.find(n => n.id === 'agent-1')!;
    const reportWidth = Number(report.style!.width);
    // agent-1 lands in the next grid column (index 1) — its x must clear report's full width.
    expect((agent.position.x as number) - (report.position.x as number)).toBeGreaterThanOrEqual(reportWidth);
  });

  it('gives a single-pin node a width unaffected by other nodes in the graph', () => {
    const g: PipelineGraph = {
      nodes: [{ id: 'agent-1', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } }],
      edges: [],
    };
    const [node] = toFlowNodes(g);
    expect(node.style!.width).toBe(200);
  });
});

describe('toFlowEdges', () => {
  it('renders one edge per Report section that has a source, skipping unwired sections', () => {
    const g: PipelineGraph = {
      nodes: [
        { id: 'a', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
        { id: 'report', config: { kind: 'Report', sections: [{ title: 'Overview', from: 'a' }, { title: 'Maps', from: '' }] } },
      ],
      edges: [{ from: 'a', to: 'report' }],
    };
    const edges = toFlowEdges(g);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'a', target: 'report', targetHandle: 'section-0' });
  });

  it('gives two sections of the same Report fed by the same source two distinct edges', () => {
    const g: PipelineGraph = {
      nodes: [
        { id: 'a', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
        { id: 'report', config: { kind: 'Report', sections: [{ title: 'One', from: 'a' }, { title: 'Two', from: 'a' }] } },
      ],
      edges: [{ from: 'a', to: 'report' }],
    };
    const edges = toFlowEdges(g);
    expect(edges).toHaveLength(2);
    expect(edges.map(e => e.targetHandle).sort()).toEqual(['section-0', 'section-1']);
    expect(edges.every(e => e.source === 'a' && e.target === 'report')).toBe(true);
  });

  it('renders a Sink\'s edge from its `from` config, not from a raw graph edge, and nothing when unwired', () => {
    const wired: PipelineGraph = {
      nodes: [
        { id: 'a', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
        { id: 'sink-1', config: { kind: 'Sink', writeFn: 'x', from: 'a' } },
      ],
      edges: [{ from: 'a', to: 'sink-1' }],
    };
    expect(toFlowEdges(wired)).toEqual([{ id: 'sink-1-in', source: 'a', sourceHandle: 'out', target: 'sink-1', targetHandle: 'in', animated: false }]);

    const unwired: PipelineGraph = { nodes: [wired.nodes[0], { id: 'sink-1', config: { kind: 'Sink', writeFn: 'x' } }], edges: [] };
    expect(toFlowEdges(unwired)).toEqual([]);
  });

  it('uses a generic edge\'s own label as the source handle (a Branch\'s named output) for non-Report/Sink targets', () => {
    const g: PipelineGraph = {
      nodes: [
        { id: 'branch-1', config: { kind: 'Branch', predicate: 'x', edges: ['yes', 'no'] } },
        { id: 'agent-a', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
      ],
      edges: [{ from: 'branch-1', to: 'agent-a', label: 'yes' }],
    };
    expect(toFlowEdges(g)).toEqual([{ id: 'e0', source: 'branch-1', sourceHandle: 'yes', target: 'agent-a', targetHandle: 'in', animated: false }]);
  });

  it('defaults to the \'out\' source handle for a generic edge with no label', () => {
    const g: PipelineGraph = {
      nodes: [
        { id: 'trigger-1', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
        { id: 'agent-a', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
      ],
      edges: [{ from: 'trigger-1', to: 'agent-a' }],
    };
    expect(toFlowEdges(g)).toEqual([{ id: 'e0', source: 'trigger-1', sourceHandle: 'out', target: 'agent-a', targetHandle: 'in', animated: false }]);
  });
});
