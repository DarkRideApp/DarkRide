import React, { useEffect, useState } from 'react';
import {
  ReactFlow, Background, Controls, applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type Connection, type NodeChange, type EdgeChange,
} from '@xyflow/react';
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

function toFlowNodes(
  graph: PipelineGraph,
  nodeStatuses?: Record<string, { status: string; wasMemoized?: boolean }>,
): Node[] {
  return graph.nodes.map((n, i) => {
    const status = statusFor(n.id, nodeStatuses);
    const statusColor = status ? STATUS_COLOR[status] : undefined;
    return {
      id: n.id,
      // A node never dragged has no saved position — placeholder grid layout, same as before
      // a real auto-layout pass exists. Once dragged, its real position round-trips through
      // the pipeline's graph (position is presentation-only, never read by the executor).
      position: n.position ?? { x: (i % 4) * 260, y: Math.floor(i / 4) * 160 },
      data: { label: <NodeLabel node={n} /> },
      style: {
        borderLeft: `4px solid ${KIND_COLOR[n.config.kind]}`,
        background: '#161f36', color: '#e4e9fb',
        ...(statusColor ? { outline: `2px solid ${statusColor}`, outlineOffset: '2px' } : {}),
      },
    };
  });
}

function toFlowEdges(graph: PipelineGraph): Edge[] {
  return graph.edges.map((e, i) => ({ id: `e${i}`, source: e.from, target: e.to, animated: false }));
}

export function Canvas({ graph, onSelectNode, nodeStatuses, onNodeMove, onConnectNodes, onDeleteNode, onDeleteEdge }: {
  graph: PipelineGraph;
  onSelectNode: (nodeId: string) => void;
  nodeStatuses?: Record<string, { status: string; wasMemoized?: boolean }>;
  /** Fired once a drag ends with the node's final position — never during the drag itself. */
  onNodeMove?: (nodeId: string, position: { x: number; y: number }) => void;
  onConnectNodes?: (from: string, to: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onDeleteEdge?: (from: string, to: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>(() => toFlowNodes(graph, nodeStatuses));
  const [edges, setEdges] = useState<Edge[]>(() => toFlowEdges(graph));

  // The graph prop is the single source of truth (owned by AiJobsWorkspace). Resync whenever it
  // changes — after an add/delete/move round-trips through the parent, after a pipeline switch,
  // after a run's node statuses land — rather than keeping divergent local state.
  useEffect(() => {
    setNodes(toFlowNodes(graph, nodeStatuses));
    setEdges(toFlowEdges(graph));
  }, [graph, nodeStatuses]);

  function handleNodesChange(changes: NodeChange[]) {
    setNodes((current) => applyNodeChanges(changes, current));
    for (const change of changes) {
      if (change.type === 'position' && change.dragging === false && change.position) {
        onNodeMove?.(change.id, change.position);
      } else if (change.type === 'remove') {
        onDeleteNode?.(change.id);
      }
    }
  }

  function handleEdgesChange(changes: EdgeChange[]) {
    setEdges((current) => applyEdgeChanges(changes, current));
    for (const change of changes) {
      if (change.type === 'remove') {
        const removed = edges.find(e => e.id === change.id);
        if (removed) onDeleteEdge?.(removed.source, removed.target);
      }
    }
  }

  function handleConnect(connection: Connection) {
    if (connection.source && connection.target) onConnectNodes?.(connection.source, connection.target);
  }

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
