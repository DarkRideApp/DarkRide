import React, { useEffect, useState } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, applyEdgeChanges,
  type Node, type Edge, type Connection, type NodeChange, type EdgeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
// Type-only import — erased at build, no runtime coupling to backend code.
import type { PipelineGraph, PipelineNode } from '../../../backend/services/ai-jobs/types';
import { nodeKindLabel } from './nodeKindLabels';
import { nodePins, type Pin } from './nodePins';
import { runStatusMessage, displayRunStatus } from './runStatus';

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

function statusFor(nodeId: string, nodeStatuses?: Record<string, { status: string; wasMemoized?: boolean; error?: string }>): string | undefined {
  const entry = nodeStatuses?.[nodeId];
  if (!entry) return undefined;
  return displayRunStatus(entry);
}

/** Hover text for a failed/skipped node, so the reason is visible without opening the side panel. Silent for every other status — a tooltip on a healthy node would just be noise. */
function statusTitle(status: string | undefined, error: string | undefined): string | undefined {
  if (status !== 'failed' && status !== 'skipped') return undefined;
  return runStatusMessage(status, error);
}

/** One side's pins, each handle and its label positioned by the same percentage so they stay aligned regardless of pin count. */
function PinRow({ pins, type, position }: { pins: Pin[]; type: 'source' | 'target'; position: Position }) {
  return (
    <>
      {pins.map((pin, i) => {
        const leftPct = ((i + 1) / (pins.length + 1)) * 100;
        return (
          <React.Fragment key={pin.id}>
            <Handle type={type} id={pin.id} position={position} style={{ left: `${leftPct}%` }} />
            {pin.label && (
              <div
                className="ai-jobs-pin-label"
                style={position === Position.Top ? { left: `${leftPct}%`, top: 2 } : { left: `${leftPct}%`, bottom: 2 }}
              >
                {pin.label}
              </div>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

/**
 * Node content: the user-facing name first, then kind + id as muted metadata. A Report or Branch
 * node's per-field breakdown now shows as its own pin labels (PinRow above, rendered as a
 * sibling of this, not a child) instead of being repeated here.
 */
function NodeLabel({ node }: { node: PipelineNode }) {
  const kind = nodeKindLabel(node.config.kind);
  return (
    <div>
      <div className="ai-jobs-node-label">{node.label ?? kind}</div>
      {node.label && <div className="ai-jobs-node-meta">{kind}</div>}
      <div className="ai-jobs-node-meta">{node.id}</div>
    </div>
  );
}

interface PipelineNodeData {
  pipelineNode: PipelineNode;
  statusTitle?: string;
  [key: string]: unknown;
}

function PipelineNodeView({ data }: NodeProps) {
  const { pipelineNode, statusTitle: title } = data as unknown as PipelineNodeData;
  const { inputs, outputs } = nodePins(pipelineNode.config);
  // No `position: relative` here — Handles and pin labels are positioned absolutely against the
  // nearest positioned ancestor, and that must stay `.react-flow__node` itself (already
  // `position: absolute` from React Flow's own stylesheet, and the element carrying the
  // padding/size set in toFlowNodes's `style`), not this inner wrapper — otherwise handles land
  // inset by this wrapper's own padding instead of on the node's real edge.
  return (
    <div className="ai-jobs-node-content" title={title}>
      <PinRow pins={inputs} type="target" position={Position.Top} />
      <NodeLabel node={pipelineNode} />
      <PinRow pins={outputs} type="source" position={Position.Bottom} />
    </div>
  );
}

const NODE_TYPES = { pipelineNode: PipelineNodeView };

// Wide enough that pin labels on the busiest edge (a Report's sections, a Branch's outputs)
// don't overlap their neighbors — ~90px is enough room for a label like "Opening Hours" at the
// 9px pin-label size, with margin either side.
function nodeWidth(config: PipelineNode['config']): number {
  const { inputs, outputs } = nodePins(config);
  return Math.max(200, Math.max(inputs.length, outputs.length) * 90);
}

export function toFlowNodes(
  graph: PipelineGraph,
  nodeStatuses?: Record<string, { status: string; wasMemoized?: boolean; error?: string }>,
): Node[] {
  // The placeholder grid's column spacing must clear the widest node in the graph — a fixed
  // 260px column was fine when every node had one generic handle, but a 630px-wide Report node
  // (7 sections) would otherwise overlap whatever landed next to it in the same row.
  const columnWidth = Math.max(260, ...graph.nodes.map(n => nodeWidth(n.config))) + 40;
  return graph.nodes.map((n, i) => {
    const status = statusFor(n.id, nodeStatuses);
    const statusColor = status ? STATUS_COLOR[status] : undefined;
    const width = nodeWidth(n.config);
    return {
      id: n.id,
      type: 'pipelineNode',
      // A node never dragged has no saved position — placeholder grid layout, same as before
      // a real auto-layout pass exists. Once dragged, its real position round-trips through
      // the pipeline's graph (position is presentation-only, never read by the executor).
      position: n.position ?? { x: (i % 4) * columnWidth, y: Math.floor(i / 4) * 160 },
      data: { pipelineNode: n, statusTitle: statusTitle(status, nodeStatuses?.[n.id]?.error) },
      // A custom node type (below) opts out of React Flow's default node class, which used to
      // supply padding/border-radius for free — now set explicitly here.
      style: {
        borderLeft: `4px solid ${KIND_COLOR[n.config.kind]}`,
        background: '#161f36', color: '#e4e9fb',
        padding: '10px 14px', borderRadius: '6px', width,
        ...(statusColor ? { outline: `2px solid ${statusColor}`, outlineOffset: '2px' } : {}),
      },
    };
  });
}

/**
 * Report and Sink don't take their wiring from `graph.edges` directly — their inputs are
 * declared in config (Report's `sections[].from`, Sink's `from`) and rendered as one edge per
 * declared pin, so a section with no source yet draws no edge, and two sections fed by the same
 * node each still get their own distinct, individually-selectable wire. Every other edge in
 * `graph.edges` renders generically, using the edge's own `label` as its source handle when set
 * (a Branch's named output) and the single default 'out'/'in' pins otherwise.
 */
export function toFlowEdges(graph: PipelineGraph): Edge[] {
  const result: Edge[] = [];
  for (const node of graph.nodes) {
    if (node.config.kind === 'Report') {
      node.config.sections.forEach((s, i) => {
        if (!s.from) return;
        result.push({ id: `${node.id}-section-${i}`, source: s.from, sourceHandle: 'out', target: node.id, targetHandle: `section-${i}`, animated: false });
      });
    } else if (node.config.kind === 'Sink' && node.config.from) {
      result.push({ id: `${node.id}-in`, source: node.config.from, sourceHandle: 'out', target: node.id, targetHandle: 'in', animated: false });
    }
  }
  const handled = new Set(graph.nodes.filter(n => n.config.kind === 'Report' || n.config.kind === 'Sink').map(n => n.id));
  graph.edges.forEach((e, i) => {
    if (handled.has(e.to)) return;
    result.push({ id: `e${i}`, source: e.from, sourceHandle: e.label ?? 'out', target: e.to, targetHandle: 'in', animated: false });
  });
  return result;
}

export function Canvas({ graph, onSelectNode, nodeStatuses, onNodeMove, onConnectNodes, onDeleteNode, onDeleteEdge }: {
  graph: PipelineGraph;
  onSelectNode: (nodeId: string) => void;
  nodeStatuses?: Record<string, { status: string; wasMemoized?: boolean; error?: string }>;
  /** Fired once a drag ends with the node's final position — never during the drag itself. */
  onNodeMove?: (nodeId: string, position: { x: number; y: number }) => void;
  onConnectNodes?: (from: string, to: string, sourceHandle: string | null, targetHandle: string | null) => void;
  onDeleteNode?: (nodeId: string) => void;
  onDeleteEdge?: (from: string, to: string, targetHandle: string | null) => void;
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
        if (removed) onDeleteEdge?.(removed.source, removed.target, removed.targetHandle ?? null);
      }
    }
  }

  function handleConnect(connection: Connection) {
    if (connection.source && connection.target) {
      onConnectNodes?.(connection.source, connection.target, connection.sourceHandle ?? null, connection.targetHandle ?? null);
    }
  }

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
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
