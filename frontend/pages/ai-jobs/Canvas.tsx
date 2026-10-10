import React, { useMemo } from 'react';
import { ReactFlow, Background, Controls, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
// Type-only import — erased at build, no runtime coupling to backend code.
import type { PipelineGraph, PipelineNode } from '../../../backend/services/ai-jobs/types';

const KIND_COLOR: Record<string, string> = {
  Trigger: '#2dd4bf', AgentCall: '#4d8eff', Transform: '#a78bfa',
  Branch: '#fbbf24', Report: '#818cf8', ForEach: '#f472b6', Sink: '#94a3b8',
};

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

export function Canvas({ graph, onSelectNode }: { graph: PipelineGraph; onSelectNode: (nodeId: string) => void }) {
  const nodes: Node[] = useMemo(() => graph.nodes.map((n, i) => ({
    id: n.id,
    position: { x: (i % 4) * 260, y: Math.floor(i / 4) * 160 }, // placeholder layout — a real force/dagre layout is a follow-up, not blocking this task's deliverable
    data: { label: <NodeLabel node={n} /> },
    style: { borderLeft: `4px solid ${KIND_COLOR[n.config.kind]}`, background: '#161f36', color: '#e4e9fb' },
  })), [graph]);

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
