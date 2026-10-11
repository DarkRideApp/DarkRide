/**
 * Pure graph-editing operations for the pipeline canvas editor. No React, no ReactFlow, no
 * backend call — every function takes a graph and returns a new one, so the editor's state
 * transitions are plain, fully unit-testable data transforms.
 */
import type { NodeConfig, NodeKind, PipelineGraph, PipelineNode } from '../../../backend/services/ai-jobs/types';

const ID_PREFIX: Record<NodeKind, string> = {
  Trigger: 'trigger', AgentCall: 'agent', Transform: 'transform',
  Branch: 'branch', Report: 'report', ForEach: 'foreach', Sink: 'sink',
};

export function nextNodeId(graph: PipelineGraph, kind: NodeKind): string {
  const prefix = ID_PREFIX[kind];
  const existing = new Set(graph.nodes.map(n => n.id));
  let n = 1;
  while (existing.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

export function defaultConfigFor(kind: NodeKind): NodeConfig {
  switch (kind) {
    case 'Trigger': return { kind, expandFn: '', outputSchema: [] };
    case 'AgentCall': return { kind, tier: 'High', instructionTemplate: '', toolAllowlist: [] };
    case 'Transform': return { kind, fn: '' };
    case 'Branch': return { kind, predicate: '', edges: [] };
    case 'Report': return { kind, sections: [] };
    case 'ForEach': return { kind, itemFn: '' };
    case 'Sink': return { kind, writeFn: '' };
  }
}

export function addNode(
  graph: PipelineGraph,
  kind: NodeKind,
  position: { x: number; y: number },
): { graph: PipelineGraph; newNodeId: string } {
  const newNodeId = nextNodeId(graph, kind);
  const node: PipelineNode = { id: newNodeId, config: defaultConfigFor(kind), position };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, newNodeId };
}

export function deleteNode(graph: PipelineGraph, nodeId: string): PipelineGraph {
  if (!graph.nodes.some(n => n.id === nodeId)) return graph;
  return {
    nodes: graph.nodes
      .filter(n => n.id !== nodeId)
      .map(n => n.config.kind === 'Report'
        ? { ...n, config: { ...n.config, sections: n.config.sections.filter(s => s.from !== nodeId) } }
        : n),
    edges: graph.edges.filter(e => e.from !== nodeId && e.to !== nodeId),
  };
}

export function addEdge(graph: PipelineGraph, from: string, to: string): PipelineGraph {
  if (from === to) return graph;
  if (graph.edges.some(e => e.from === from && e.to === to)) return graph;
  return { ...graph, edges: [...graph.edges, { from, to }] };
}

export function deleteEdge(graph: PipelineGraph, from: string, to: string): PipelineGraph {
  return { ...graph, edges: graph.edges.filter(e => !(e.from === from && e.to === to)) };
}

export function moveNode(graph: PipelineGraph, nodeId: string, position: { x: number; y: number }): PipelineGraph {
  return { ...graph, nodes: graph.nodes.map(n => n.id === nodeId ? { ...n, position } : n) };
}
