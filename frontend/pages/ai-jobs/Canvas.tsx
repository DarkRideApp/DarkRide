import React, { useMemo } from 'react';
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
// Type-only import — erased at build, no runtime coupling to backend code.
import type { PipelineGraph, PipelineNode } from '../../../backend/services/ai-jobs/types';

const KIND_COLOR: Record<string, string> = {
  Trigger: '#2dd4bf', AgentCall: '#4d8eff', Transform: '#a78bfa',
  Branch: '#fbbf24', Report: '#818cf8', ForEach: '#f472b6', Sink: '#94a3b8',
};

// Layered on top of KIND_COLOR, not replacing it: KIND_COLOR still drives the left border (what
// kind of node this is); a run's outcome is a second, independent signal shown as the node's
// outline. `cached` covers a memoized node (`wasMemoized: true`) regardless of its underlying
// status; `inactive` covers a node untouched by the run (outside the chosen Trigger's zone);
// `skipped` covers a node whose predecessor failed — without its own colour it rendered with no
// outline at all, indistinguishable from a node the run never touched.
export const STATUS_COLOR: Record<string, string> = {
  ok: '#22c55e', failed: '#ef4444', cached: '#38bdf8', inactive: '#475569', skipped: '#f97316',
};

function statusFor(nodeId: string, nodeStatuses?: Record<string, { status: string; wasMemoized?: boolean }>): string | undefined {
  const entry = nodeStatuses?.[nodeId];
  if (!entry) return undefined;
  return entry.wasMemoized ? 'cached' : entry.status;
}

/**
 * Node label content. Every node shows its kind + id. A Report node additionally lists its
 * section titles as separate lines, so a read-only viewer can see the report's outline without
 * opening an inspector — this is also what lets tests assert against the real section titles
 * (Overview, Wait Times, …) instead of an opaque node id.
 */
function NodeLabel({ node }: { node: PipelineNode }) {
  return (
    <div>
      <div>{node.config.kind}</div>
      <div>{node.id}</div>
      {node.config.kind === 'Report' && node.config.sections.map((s) => (
        <div key={s.title}>{s.title}</div>
      ))}
    </div>
  );
}

export function Canvas({ graph, onSelectNode, nodeStatuses }: {
  graph: PipelineGraph;
  onSelectNode: (nodeId: string) => void;
  nodeStatuses?: Record<string, { status: string; wasMemoized?: boolean }>;
}) {
  const nodes: Node[] = useMemo(() => graph.nodes.map((n, i) => {
    const status = statusFor(n.id, nodeStatuses);
    const statusColor = status ? STATUS_COLOR[status] : undefined;
    return {
      id: n.id,
      position: { x: (i % 4) * 260, y: Math.floor(i / 4) * 160 }, // placeholder layout — a real force/dagre layout is a follow-up, not blocking this task's deliverable
      data: { label: <NodeLabel node={n} /> },
      style: {
        borderLeft: `4px solid ${KIND_COLOR[n.config.kind]}`,
        background: '#161f36', color: '#e4e9fb',
        ...(statusColor ? { outline: `2px solid ${statusColor}`, outlineOffset: '2px' } : {}),
      },
    };
  }), [graph, nodeStatuses]);

  const edges: Edge[] = useMemo(() => graph.edges.map((e, i) => ({
    id: `e${i}`, source: e.from, target: e.to, animated: false,
  })), [graph]);

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <ReactFlow nodes={nodes} edges={edges} onNodeClick={(_, node) => onSelectNode(node.id)} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
