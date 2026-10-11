import { describe, it, expect } from 'vitest';
import { addNode, deleteNode, addEdge, deleteEdge, moveNode, defaultConfigFor, nextNodeId } from './graphEdit';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

const baseGraph: PipelineGraph = {
  nodes: [
    { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: [] } },
    { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: 'x' } },
    { id: 'report', config: { kind: 'Report', sections: [{ title: 'Overview', from: 'agent-overview' }] } },
  ],
  edges: [
    { from: 'trigger-full', to: 'agent-overview' },
    { from: 'agent-overview', to: 'report' },
  ],
};

describe('nextNodeId', () => {
  it('generates a collision-free id using the kind-specific prefix', () => {
    expect(nextNodeId(baseGraph, 'AgentCall')).toBe('agent-1');
    expect(nextNodeId(baseGraph, 'Sink')).toBe('sink-1');
  });

  it('skips ids that already exist', () => {
    const graph: PipelineGraph = { ...baseGraph, nodes: [...baseGraph.nodes, { id: 'agent-1', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } }] };
    expect(nextNodeId(graph, 'AgentCall')).toBe('agent-2');
  });
});

describe('defaultConfigFor', () => {
  it('returns a blank, valid-shaped config per kind', () => {
    expect(defaultConfigFor('Trigger')).toEqual({ kind: 'Trigger', expandFn: '', outputSchema: [] });
    expect(defaultConfigFor('AgentCall')).toEqual({ kind: 'AgentCall', tier: 'High', instructionTemplate: '', toolAllowlist: [] });
    expect(defaultConfigFor('Transform')).toEqual({ kind: 'Transform', fn: '' });
    expect(defaultConfigFor('Branch')).toEqual({ kind: 'Branch', predicate: '', edges: [] });
    expect(defaultConfigFor('Report')).toEqual({ kind: 'Report', sections: [] });
    expect(defaultConfigFor('ForEach')).toEqual({ kind: 'ForEach', itemFn: '' });
    expect(defaultConfigFor('Sink')).toEqual({ kind: 'Sink', writeFn: '' });
  });
});

describe('addNode', () => {
  it('appends a new node with a generated id, default config, and the given position', () => {
    const { graph, newNodeId } = addNode(baseGraph, 'AgentCall', { x: 10, y: 20 });
    expect(newNodeId).toBe('agent-1');
    expect(graph.nodes).toHaveLength(4);
    const added = graph.nodes.find(n => n.id === 'agent-1')!;
    expect(added.config).toEqual({ kind: 'AgentCall', tier: 'High', instructionTemplate: '', toolAllowlist: [] });
    expect(added.position).toEqual({ x: 10, y: 20 });
    // Original untouched (pure function).
    expect(baseGraph.nodes).toHaveLength(3);
  });
});

describe('deleteNode', () => {
  it('removes the node and every edge touching it', () => {
    const graph = deleteNode(baseGraph, 'agent-overview');
    expect(graph.nodes.map(n => n.id)).toEqual(['trigger-full', 'report']);
    expect(graph.edges).toEqual([]);
  });

  it('also strips the node id out of any Report section that referenced it', () => {
    const graph = deleteNode(baseGraph, 'agent-overview');
    const report = graph.nodes.find(n => n.id === 'report')!;
    expect((report.config as any).sections).toEqual([]);
  });

  it('leaves the graph untouched when the id does not exist', () => {
    const graph = deleteNode(baseGraph, 'does-not-exist');
    expect(graph).toEqual(baseGraph);
  });
});

describe('addEdge', () => {
  it('adds a new edge', () => {
    const graph = addEdge(baseGraph, 'trigger-full', 'report');
    expect(graph.edges).toContainEqual({ from: 'trigger-full', to: 'report' });
    expect(graph.edges).toHaveLength(3);
  });

  it('is a no-op if the exact edge already exists', () => {
    const graph = addEdge(baseGraph, 'trigger-full', 'agent-overview');
    expect(graph.edges).toHaveLength(2);
  });

  it('refuses a self-loop', () => {
    const graph = addEdge(baseGraph, 'agent-overview', 'agent-overview');
    expect(graph.edges).toHaveLength(2);
  });
});

describe('deleteEdge', () => {
  it('removes a matching edge', () => {
    const graph = deleteEdge(baseGraph, 'trigger-full', 'agent-overview');
    expect(graph.edges).toEqual([{ from: 'agent-overview', to: 'report' }]);
  });
});

describe('moveNode', () => {
  it('sets the node position, leaving everything else untouched', () => {
    const graph = moveNode(baseGraph, 'agent-overview', { x: 99, y: 100 });
    const moved = graph.nodes.find(n => n.id === 'agent-overview')!;
    expect(moved.position).toEqual({ x: 99, y: 100 });
    expect(graph.nodes.find(n => n.id === 'trigger-full')!.position).toBeUndefined();
  });
});
