import { describe, it, expect } from 'vitest';
import {
  addNode, deleteNode, addEdge, deleteEdge, moveNode, renameNode, defaultConfigFor, nextNodeId,
  connectReportSection, disconnectReportSection, connectSinkInput, disconnectSinkInput,
} from './graphEdit';
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

  it('defaults the new node label to its kind\'s display name, not its id', () => {
    const { graph, newNodeId } = addNode(baseGraph, 'AgentCall', { x: 0, y: 0 });
    expect(graph.nodes.find(n => n.id === newNodeId)!.label).toBe('Agent Call');
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

  it('also clears a Sink\'s `from` when it pointed at the deleted node', () => {
    const graph: PipelineGraph = {
      nodes: [...baseGraph.nodes, { id: 'sink-1', config: { kind: 'Sink', writeFn: 'x', from: 'report' } }],
      edges: [...baseGraph.edges, { from: 'report', to: 'sink-1' }],
    };
    const next = deleteNode(graph, 'report');
    expect((next.nodes.find(n => n.id === 'sink-1')!.config as any).from).toBeUndefined();
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

  it('sets a label on a brand new edge (a Branch output\'s name)', () => {
    const graph = addEdge(baseGraph, 'trigger-full', 'report', 'yes');
    expect(graph.edges).toContainEqual({ from: 'trigger-full', to: 'report', label: 'yes' });
  });

  it('leaves an already-existing edge untouched, including its label, even if a different label is passed', () => {
    const graph = addEdge(baseGraph, 'trigger-full', 'agent-overview', 'yes');
    expect(graph.edges).toContainEqual({ from: 'trigger-full', to: 'agent-overview' });
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

describe('renameNode', () => {
  it('sets the node label, leaving everything else untouched', () => {
    const graph = renameNode(baseGraph, 'agent-overview', 'App Overview');
    const renamed = graph.nodes.find(n => n.id === 'agent-overview')!;
    expect(renamed.label).toBe('App Overview');
    expect(renamed.id).toBe('agent-overview');
    expect(graph.nodes.find(n => n.id === 'trigger-full')!.label).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    const graph = renameNode(baseGraph, 'agent-overview', '  App Overview  ');
    expect(graph.nodes.find(n => n.id === 'agent-overview')!.label).toBe('App Overview');
  });

  it('clears the label back to undefined when set to blank', () => {
    const withLabel = renameNode(baseGraph, 'agent-overview', 'App Overview');
    const cleared = renameNode(withLabel, 'agent-overview', '   ');
    expect(cleared.nodes.find(n => n.id === 'agent-overview')!.label).toBeUndefined();
  });

  it('is a no-op on an id that does not exist', () => {
    const graph = renameNode(baseGraph, 'does-not-exist', 'Whatever');
    expect(graph.nodes).toEqual(baseGraph.nodes);
  });
});

const reportGraph: PipelineGraph = {
  nodes: [
    { id: 'trigger-full', config: { kind: 'Trigger', expandFn: 'x', outputSchema: [] } },
    { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
    { id: 'agent-maps', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
    { id: 'report', config: { kind: 'Report', sections: [{ title: 'Overview', from: 'agent-overview' }, { title: 'Maps', from: '' }] } },
  ],
  edges: [
    { from: 'trigger-full', to: 'agent-overview' },
    { from: 'trigger-full', to: 'agent-maps' },
    { from: 'agent-overview', to: 'report' },
  ],
};

describe('connectReportSection', () => {
  it('points the section at the source and adds the edge when none existed', () => {
    const graph = connectReportSection(reportGraph, 'report', 1, 'agent-maps');
    expect((graph.nodes.find(n => n.id === 'report')!.config as any).sections[1].from).toBe('agent-maps');
    expect(graph.edges).toContainEqual({ from: 'agent-maps', to: 'report' });
  });

  it('reuses the existing edge when the source already feeds this Report (another section)', () => {
    const graph = connectReportSection(reportGraph, 'report', 1, 'agent-overview');
    expect((graph.nodes.find(n => n.id === 'report')!.config as any).sections[1].from).toBe('agent-overview');
    expect(graph.edges.filter(e => e.from === 'agent-overview' && e.to === 'report')).toHaveLength(1);
  });
});

describe('disconnectReportSection', () => {
  it('clears the section\'s from and drops the edge when no other section still uses that source', () => {
    const graph = disconnectReportSection(reportGraph, 'report', 0);
    expect((graph.nodes.find(n => n.id === 'report')!.config as any).sections[0].from).toBe('');
    expect(graph.edges).not.toContainEqual({ from: 'agent-overview', to: 'report' });
  });

  it('keeps the edge when another section of the same Report still points at that source', () => {
    const bothFromOverview: PipelineGraph = {
      ...reportGraph,
      nodes: reportGraph.nodes.map(n => n.id === 'report'
        ? { ...n, config: { kind: 'Report' as const, sections: [{ title: 'Overview', from: 'agent-overview' }, { title: 'Also overview', from: 'agent-overview' }] } }
        : n),
    };
    const graph = disconnectReportSection(bothFromOverview, 'report', 0);
    expect((graph.nodes.find(n => n.id === 'report')!.config as any).sections[0].from).toBe('');
    expect(graph.edges).toContainEqual({ from: 'agent-overview', to: 'report' });
  });

  it('is a no-op on a node that is not a Report', () => {
    const graph = disconnectReportSection(reportGraph, 'agent-overview', 0);
    expect(graph).toEqual(reportGraph);
  });
});

const sinkGraph: PipelineGraph = {
  nodes: [
    { id: 'report', config: { kind: 'Report', sections: [] } },
    { id: 'agent-overview', config: { kind: 'AgentCall', tier: 'High', toolAllowlist: [], instructionTemplate: '' } },
    { id: 'sink-1', config: { kind: 'Sink', writeFn: 'x', from: 'report' } },
  ],
  edges: [{ from: 'report', to: 'sink-1' }],
};

describe('connectSinkInput', () => {
  it('points `from` at the source and adds the edge', () => {
    const graph = connectSinkInput(sinkGraph, 'sink-1', 'agent-overview');
    expect((graph.nodes.find(n => n.id === 'sink-1')!.config as any).from).toBe('agent-overview');
    expect(graph.edges).toContainEqual({ from: 'agent-overview', to: 'sink-1' });
  });
});

describe('disconnectSinkInput', () => {
  it('clears `from` and removes the edge', () => {
    const graph = disconnectSinkInput(sinkGraph, 'sink-1');
    expect((graph.nodes.find(n => n.id === 'sink-1')!.config as any).from).toBeUndefined();
    expect(graph.edges).toEqual([]);
  });

  it('is a no-op on a node that is not a Sink', () => {
    const graph = disconnectSinkInput(sinkGraph, 'report');
    expect(graph).toEqual(sinkGraph);
  });
});
