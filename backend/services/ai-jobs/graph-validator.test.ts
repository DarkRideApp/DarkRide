import { describe, it, expect } from 'vitest';
import { validateGraph } from './graph-validator';
import type { PipelineGraph } from './types';

const triggerSchema = [{ field: 'appName', type: 'string', description: 'x' }];

function node(id: string, config: PipelineGraph['nodes'][number]['config']) {
  return { id, config };
}

describe('validateGraph', () => {
  it('passes a minimal valid graph: one Trigger, one AgentCall, one Sink', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('trigger', { kind: 'Trigger', expandFn: 'apk-analysis/apk-context', outputSchema: triggerSchema }),
        node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
        node('sink', { kind: 'Sink', writeFn: 'apk-analysis/write-section' }),
      ],
      edges: [{ from: 'trigger', to: 'agent' }, { from: 'agent', to: 'sink' }],
    };
    expect(validateGraph(graph)).toEqual([]);
  });

  it('rejects a graph with zero Trigger nodes', () => {
    const graph: PipelineGraph = { nodes: [node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] })], edges: [] };
    const errors = validateGraph(graph);
    expect(errors.some(e => /at least one Trigger/i.test(e.message))).toBe(true);
  });

  it('rejects two Triggers with different output schemas', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('t2', { kind: 'Trigger', expandFn: 'b', outputSchema: [{ field: 'different', type: 'string', description: 'x' }] }),
      ],
      edges: [],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => /same output schema/i.test(e.message))).toBe(true);
  });

  it('rejects a node reachable from two different Triggers', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('t2', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('shared', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
      ],
      edges: [{ from: 't1', to: 'shared' }, { from: 't2', to: 'shared' }],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => e.nodeId === 'shared' && /more than one Trigger/i.test(e.message))).toBe(true);
  });

  it('rejects an edge into a Trigger node (a Trigger must have zero incoming edges)', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('t2', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
      ],
      edges: [{ from: 't1', to: 'agent' }, { from: 't1', to: 't2' }], // t2 is a Trigger fed by t1
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => e.nodeId === 't2' && /incoming edge/.test(e.message) && /independent root/.test(e.message))).toBe(true);
  });

  it('rejects a node reachable from zero Triggers (orphaned)', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('orphan', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
      ],
      edges: [],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => e.nodeId === 'orphan' && /not reachable from any Trigger/i.test(e.message))).toBe(true);
  });

  it('rejects a Report section whose "from" is not a direct incoming edge', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
        node('report', { kind: 'Report', sections: [{ title: 'X', from: 'not-a-real-edge-source' }] }),
      ],
      edges: [{ from: 't1', to: 'agent' }, { from: 'agent', to: 'report' }],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => e.nodeId === 'report' && /not-a-real-edge-source/.test(e.message))).toBe(true);
  });

  it('rejects a Branch whose declared edges and real outgoing edge labels have drifted apart', () => {
    const graphMissingEdge: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
        node('branch', { kind: 'Branch', predicate: 'x', edges: ['primary', 'fallback'] }), // declares 'fallback'...
        node('sink', { kind: 'Sink', writeFn: 'x' }),
      ],
      edges: [
        { from: 't1', to: 'agent' }, { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'sink', label: 'primary' }, // ...but no graph edge actually carries it
      ],
    };
    expect(validateGraph(graphMissingEdge).some(e => e.nodeId === 'branch' && /"fallback"/.test(e.message))).toBe(true);

    const graphExtraEdge: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
        node('branch', { kind: 'Branch', predicate: 'x', edges: ['primary'] }), // only declares 'primary'...
        node('sink1', { kind: 'Sink', writeFn: 'x' }),
        node('sink2', { kind: 'Sink', writeFn: 'x' }),
      ],
      edges: [
        { from: 't1', to: 'agent' }, { from: 'agent', to: 'branch' },
        { from: 'branch', to: 'sink1', label: 'primary' },
        { from: 'branch', to: 'sink2', label: 'undeclared' }, // ...but a second, undeclared outgoing edge exists
      ],
    };
    expect(validateGraph(graphExtraEdge).some(e => e.nodeId === 'branch' && /"undeclared"/.test(e.message))).toBe(true);
  });

  it('rejects a Sink whose declared "from" is not a direct incoming edge source', () => {
    const graph: PipelineGraph = {
      nodes: [
        node('t1', { kind: 'Trigger', expandFn: 'a', outputSchema: triggerSchema }),
        node('agent', { kind: 'AgentCall', tier: 'High', instructionTemplate: 'x', toolAllowlist: [] }),
        node('sink', { kind: 'Sink', writeFn: 'x', from: 'not-a-real-edge-source' }),
      ],
      edges: [{ from: 't1', to: 'agent' }, { from: 'agent', to: 'sink' }],
    };
    const errors = validateGraph(graph);
    expect(errors.some(e => e.nodeId === 'sink' && /not-a-real-edge-source/.test(e.message))).toBe(true);
  });
});
