/**
 * Pure graph-editing operations for the pipeline canvas editor. No React, no ReactFlow, no
 * backend call — every function takes a graph and returns a new one, so the editor's state
 * transitions are plain, fully unit-testable data transforms.
 */
import type { NodeConfig, NodeKind, PipelineGraph, PipelineNode } from '../../../backend/services/ai-jobs/types';
import { NODE_KIND_LABELS } from './nodeKindLabels';

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
  const node: PipelineNode = { id: newNodeId, config: defaultConfigFor(kind), position, label: NODE_KIND_LABELS[kind] };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, newNodeId };
}

/** Blank input clears the label back to the kind's default display. */
export function renameNode(graph: PipelineGraph, nodeId: string, label: string): PipelineGraph {
  const trimmed = label.trim();
  return { ...graph, nodes: graph.nodes.map(n => n.id === nodeId ? { ...n, label: trimmed === '' ? undefined : trimmed } : n) };
}

export function deleteNode(graph: PipelineGraph, nodeId: string): PipelineGraph {
  if (!graph.nodes.some(n => n.id === nodeId)) return graph;
  return {
    nodes: graph.nodes
      .filter(n => n.id !== nodeId)
      .map(n => n.config.kind === 'Report'
        ? { ...n, config: { ...n.config, sections: n.config.sections.filter(s => s.from !== nodeId) } }
        : n.config.kind === 'Sink' && n.config.from === nodeId
          ? { ...n, config: { ...n.config, from: undefined } }
          : n),
    edges: graph.edges.filter(e => e.from !== nodeId && e.to !== nodeId),
  };
}

/** `label` only matters when `from` is a Branch — it's that output's name. An edge that already exists is left untouched (including its label), even if a different label is passed. */
export function addEdge(graph: PipelineGraph, from: string, to: string, label?: string): PipelineGraph {
  if (from === to) return graph;
  if (graph.edges.some(e => e.from === from && e.to === to)) return graph;
  return { ...graph, edges: [...graph.edges, { from, to, ...(label ? { label } : {}) }] };
}

export function deleteEdge(graph: PipelineGraph, from: string, to: string): PipelineGraph {
  return { ...graph, edges: graph.edges.filter(e => !(e.from === from && e.to === to)) };
}

/** Wires a Report section to a predecessor by dragging on the canvas — adds the edge if needed and points that section's `from` at it, replacing the old side-panel dropdown as the way to set it. */
export function connectReportSection(graph: PipelineGraph, reportNodeId: string, sectionIndex: number, sourceId: string): PipelineGraph {
  const withEdge = addEdge(graph, sourceId, reportNodeId);
  return {
    ...withEdge,
    nodes: withEdge.nodes.map(n => n.id === reportNodeId && n.config.kind === 'Report'
      ? { ...n, config: { ...n.config, sections: n.config.sections.map((s, i) => i === sectionIndex ? { ...s, from: sourceId } : s) } }
      : n),
  };
}

/** Clears one Report section's `from`; drops the underlying edge too, but only once no other section of that same Report still uses it. */
export function disconnectReportSection(graph: PipelineGraph, reportNodeId: string, sectionIndex: number): PipelineGraph {
  const report = graph.nodes.find(n => n.id === reportNodeId);
  if (!report || report.config.kind !== 'Report') return graph;
  const removedFrom = report.config.sections[sectionIndex]?.from;
  const nextNodes = graph.nodes.map(n => n.id === reportNodeId && n.config.kind === 'Report'
    ? { ...n, config: { ...n.config, sections: n.config.sections.map((s, i) => i === sectionIndex ? { ...s, from: '' } : s) } }
    : n);
  const updatedReport = nextNodes.find(n => n.id === reportNodeId)!;
  const stillUsed = updatedReport.config.kind === 'Report' && updatedReport.config.sections.some(s => s.from === removedFrom);
  const next = { ...graph, nodes: nextNodes };
  return (removedFrom && !stillUsed) ? deleteEdge(next, removedFrom, reportNodeId) : next;
}

/** Wires a Sink's single input by dragging on the canvas — same idea as connectReportSection, one pin instead of many. */
export function connectSinkInput(graph: PipelineGraph, sinkNodeId: string, sourceId: string): PipelineGraph {
  const withEdge = addEdge(graph, sourceId, sinkNodeId);
  return {
    ...withEdge,
    nodes: withEdge.nodes.map(n => n.id === sinkNodeId && n.config.kind === 'Sink' ? { ...n, config: { ...n.config, from: sourceId } } : n),
  };
}

export function disconnectSinkInput(graph: PipelineGraph, sinkNodeId: string): PipelineGraph {
  const sink = graph.nodes.find(n => n.id === sinkNodeId);
  if (!sink || sink.config.kind !== 'Sink') return graph;
  const from = sink.config.from;
  const nextNodes = graph.nodes.map(n => n.id === sinkNodeId && n.config.kind === 'Sink' ? { ...n, config: { ...n.config, from: undefined } } : n);
  const next = { ...graph, nodes: nextNodes };
  return from ? deleteEdge(next, from, sinkNodeId) : next;
}

export function moveNode(graph: PipelineGraph, nodeId: string, position: { x: number; y: number }): PipelineGraph {
  return { ...graph, nodes: graph.nodes.map(n => n.id === nodeId ? { ...n, position } : n) };
}
