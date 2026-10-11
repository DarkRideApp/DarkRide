import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useWebSocket, useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Canvas } from './Canvas';
import { SidePanel } from './SidePanel';
import { NodePicker } from './NodePicker';
import {
  addNode, deleteNode, addEdge, deleteEdge, moveNode, renameNode,
  connectReportSection, disconnectReportSection, connectSinkInput, disconnectSinkInput,
} from './graphEdit';
import type { NodeKind, PipelineGraph, PipelineNode, TriggerConfig } from '../../../backend/services/ai-jobs/types';

/** Forward-reachability BFS defining a Trigger's zone — duplicated client-side (not imported) to keep backend code out of the frontend bundle. Verbatim copy of `reachableFrom` in backend/services/ai-jobs/pipeline-runner.ts. */
export function reachableFrom(nodeId: string, graph: PipelineGraph): Set<string> {
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from !== current || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}

function isTriggerNode(n: PipelineNode): n is PipelineNode & { config: TriggerConfig & { kind: 'Trigger' } } {
  return n.config.kind === 'Trigger';
}

/** The Trigger whose zone actually contains `nodeId` — never just the first Trigger in the graph, since a pipeline can have disjoint Trigger zones with different schemas. */
export function findOwningTriggerSchema(graph: PipelineGraph, nodeId: string): Array<{ field: string; type: string; description: string }> {
  const triggers = graph.nodes.filter(isTriggerNode);
  for (const trigger of triggers) {
    if (reachableFrom(trigger.id, graph).has(nodeId)) return trigger.config.outputSchema;
  }
  return triggers[0]?.config.outputSchema ?? [];
}

/** How often handleRun polls GET /v1/ai-pipelines/runs/:runId while a run is in flight. */
export const POLL_INTERVAL_MS = 2000;
/** ~10 minutes at the default interval — bounded, never an infinite loop. */
export const MAX_POLL_ATTEMPTS = 300;
/** How long the editor waits after the last edit settles before autosaving a draft. */
export const AUTOSAVE_DEBOUNCE_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface RecentVersion { id: number; appName: string | null; packageName: string; versionName: string | null }

const EMPTY_GRAPH: PipelineGraph = { nodes: [], edges: [] };

export function AiJobsWorkspace({ pipelineId, pollIntervalMs = POLL_INTERVAL_MS, autosaveDebounceMs = AUTOSAVE_DEBOUNCE_MS }: {
  pipelineId: number;
  pollIntervalMs?: number;
  autosaveDebounceMs?: number;
}) {
  const { sendRestApi } = useWebSocket();
  const [pipelineName, setPipelineName] = useState<string | null>(null);
  const [graph, setGraph] = useState<PipelineGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, { status: string; wasMemoized?: boolean; error?: string }>>({});
  const [recentVersions, setRecentVersions] = useState<RecentVersion[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  useDocumentTitle(pipelineName ? `Pipeline: ${pipelineName}` : 'Pipeline');

  // Guards the dirty-tracking effect below against firing when the initial fetch lands —
  // only a change AFTER that counts as a user edit.
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setGraph(null);
    setDirty(false);
    sendRestApi('GET', `/v1/ai-pipelines/${pipelineId}`).then((res: any) => {
      if (cancelled) return;
      const row = res.body?.data;
      setPipelineName(row?.name ?? row?.jobKind ?? null);
      setGraph(row?.graph ?? EMPTY_GRAPH);
    });
    // Feeds the Run form's 'apk-version' field renderer (SidePanel.tsx) for any Trigger whose
    // declared inputSchema asks for one — not every pipeline's Trigger does.
    sendRestApi('GET', '/v1/apps/recent').then((res: any) => {
      if (cancelled) return;
      setRecentVersions(res.body?.data ?? []);
    });
    return () => { cancelled = true; };
  }, [sendRestApi, pipelineId]);

  useEffect(() => {
    if (graph === null) return;
    if (!loadedRef.current) { loadedRef.current = true; return; }
    setDirty(true);
  }, [graph]);

  async function saveDraft(g: PipelineGraph): Promise<boolean> {
    const res: any = await sendRestApi('POST', `/v1/ai-pipelines/${pipelineId}/versions`, { graph: g });
    if (res.body?.success) { setDirty(false); return true; }
    setStatusMessage(res.body?.error ?? 'Could not save the draft.');
    return false;
  }

  // Debounced autosave: this is what actually protects against losing edits on navigating away
  // by any in-app route — the browser never fires `beforeunload` for a client-side route change,
  // so a "warn before leaving" approach alone would miss exactly that case.
  useEffect(() => {
    if (!dirty || !graph) return;
    const timer = setTimeout(async () => {
      if (await saveDraft(graph)) setStatusMessage('Autosaved.');
    }, autosaveDebounceMs);
    return () => clearTimeout(timer);
  }, [graph, dirty, autosaveDebounceMs, pipelineId]);

  // Safety net for the autosave debounce window itself — closing the tab or refreshing before
  // the timer above fires.
  useEffect(() => {
    if (!dirty) return;
    function handler(e: BeforeUnloadEvent) { e.preventDefault(); e.returnValue = ''; }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  function handleAddNode(kind: NodeKind) {
    if (!graph) return;
    // Same placeholder-grid math Canvas falls back to for an unmoved node, offset below the
    // existing rows so a newly added node doesn't render stacked on top of another placeholder.
    const i = graph.nodes.length;
    const position = { x: (i % 4) * 260, y: Math.floor(i / 4) * 160 + 200 };
    const { graph: next, newNodeId } = addNode(graph, kind, position);
    setGraph(next);
    setSelected(newNodeId);
  }

  function handleDeleteNode(nodeId: string) {
    setGraph(g => g && deleteNode(g, nodeId));
    setSelected(s => s === nodeId ? null : s);
  }

  function handleNodeMove(nodeId: string, position: { x: number; y: number }) {
    setGraph(g => g && moveNode(g, nodeId, position));
  }

  /** Section pins are ids `section-${i}` — see nodePins.ts and Canvas.tsx's toFlowEdges/PinRow. */
  function sectionIndexFromHandle(handle: string | null): number | null {
    if (!handle?.startsWith('section-')) return null;
    const i = Number(handle.slice('section-'.length));
    return Number.isNaN(i) ? null : i;
  }

  function handleConnectNodes(from: string, to: string, sourceHandle: string | null, targetHandle: string | null) {
    setGraph(g => {
      if (!g) return g;
      const target = g.nodes.find(n => n.id === to);
      const sectionIndex = sectionIndexFromHandle(targetHandle);
      if (target?.config.kind === 'Report' && sectionIndex !== null) return connectReportSection(g, to, sectionIndex, from);
      if (target?.config.kind === 'Sink') return connectSinkInput(g, to, from);
      return addEdge(g, from, to, sourceHandle && sourceHandle !== 'out' ? sourceHandle : undefined);
    });
  }

  function handleDeleteEdge(from: string, to: string, targetHandle: string | null) {
    setGraph(g => {
      if (!g) return g;
      const target = g.nodes.find(n => n.id === to);
      const sectionIndex = sectionIndexFromHandle(targetHandle);
      if (target?.config.kind === 'Report' && sectionIndex !== null) return disconnectReportSection(g, to, sectionIndex);
      if (target?.config.kind === 'Sink') return disconnectSinkInput(g, to);
      return deleteEdge(g, from, to);
    });
  }

  function handleRenameNode(nodeId: string, label: string) {
    setGraph(g => g && renameNode(g, nodeId, label));
  }

  async function handleSaveDraft() {
    if (!graph) return;
    if (await saveDraft(graph)) setStatusMessage('Draft saved.');
  }

  // Publish always acts on what's in the editor: if there are unsaved edits, it saves them as
  // the draft first, then publishes that draft — "publish" means "make what I'm looking at
  // live," not "make whatever I last explicitly saved live."
  async function handlePublish() {
    if (dirty && graph && !(await saveDraft(graph))) return;
    const res: any = await sendRestApi('POST', `/v1/ai-pipelines/${pipelineId}/publish`, {});
    if (res.body?.success) {
      setStatusMessage('Published.');
      return;
    }
    const errors = res.body?.errors as Array<{ message: string }> | undefined;
    setStatusMessage(errors?.length
      ? `Could not publish: ${errors.map(e => e.message).join('; ')}`
      : (res.body?.error ?? 'Could not publish.'));
  }

  /**
   * Kicks off a run via `POST /v1/ai-pipelines/:id/run` with the given Trigger's input, then
   * polls `GET /v1/ai-pipelines/runs/:runId` every `pollIntervalMs` until the run leaves
   * 'running', and applies its per-node results. `/run` answers as soon as the run is recorded
   * (backend/services/ai-jobs/run-executor.ts) — a real multi-AgentCall run takes minutes, far
   * past the client's 30s REST timeout, so the client cannot wait on the POST itself. Per-node
   * results are only ever readable from the run-detail endpoint (shape `{ run, nodes }`), and
   * only once the whole run settles. Polling gives up after `MAX_POLL_ATTEMPTS`; the run may
   * still be going server-side, and the message says so.
   */
  async function handleRun(triggerNodeId: string, input: Record<string, unknown>, reuseUnchanged: boolean) {
    setStatusMessage(null);
    const runRes: any = await sendRestApi('POST', `/v1/ai-pipelines/${pipelineId}/run`, {
      triggerNodeId, input, reuseUnchanged,
    });
    const runId = runRes.body?.data?.runId;
    if (runId == null) {
      // The POST itself failed (403 disabled, 409 already running, 400 bad trigger, 404) —
      // nothing to poll.
      setStatusMessage(runRes.body?.error ?? 'The run could not be started.');
      return runRes.body?.data;
    }

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      await sleep(pollIntervalMs);
      const detailRes: any = await sendRestApi('GET', `/v1/ai-pipelines/runs/${runId}`);
      const run = detailRes.body?.data?.run;
      if (run && run.status !== 'running') {
        const byId: Record<string, { status: string; wasMemoized?: boolean; error?: string }> = {};
        for (const n of detailRes.body?.data?.nodes ?? []) byId[n.nodeId] = { status: n.status, wasMemoized: n.wasMemoized, error: n.error };
        setNodeStatuses(byId);
        setStatusMessage(`Run ${runId} finished: ${run.status}`);
        return detailRes.body?.data;
      }
    }
    setStatusMessage(`Run ${runId} is still running on the server. Check back later.`);
  }

  return (
    <div className="ai-jobs-root page-full-bleed">
      <div className="ai-jobs-toolbar">
        <div className="ai-jobs-toolbar-group">
          <Link to="/ui/pipelines" className="btn btn-ghost btn-sm">← Pipelines</Link>
          <span className="ai-jobs-pipeline-name">{pipelineName ?? '…'}</span>
        </div>

        {graph && (
          <>
            <div className="ai-jobs-toolbar-group">
              <NodePicker onPick={handleAddNode} />
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleSaveDraft} title="Keeps your edits without making them live.">Save Draft</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={handlePublish} title="Makes this version the one real runs use — saves first if you have unsaved changes.">Publish</button>
              <span className="ai-jobs-dirty-indicator">{dirty ? 'Unsaved changes…' : 'All changes saved'}</span>
            </div>
          </>
        )}

        {statusMessage && <div role="status" className="ai-jobs-status">{statusMessage}</div>}
      </div>
      <div className="ai-jobs-canvas-wrap">
        {graph ? (
          <>
            <Canvas
              graph={graph}
              onSelectNode={setSelected}
              nodeStatuses={nodeStatuses}
              onNodeMove={handleNodeMove}
              onConnectNodes={handleConnectNodes}
              onDeleteNode={handleDeleteNode}
              onDeleteEdge={handleDeleteEdge}
            />
            {selected && (
              // key: a different node must get a fresh panel. Without it React reuses the instance and
              // AgentCallBody's `template` state (seeded once from props) keeps showing the PREVIOUS
              // node's prompt — and typing then saves it under the new node's id.
              <SidePanel
                key={selected}
                node={graph.nodes.find(n => n.id === selected)!}
                graph={graph}
                triggerSchema={findOwningTriggerSchema(graph, selected)}
                onClose={() => setSelected(null)}
                onSave={(nodeId, patch) => {
                  setGraph(g => g && ({ ...g, nodes: g.nodes.map(n => n.id === nodeId ? { ...n, config: { ...n.config, ...patch } } : n) }));
                }}
                onDeleteNode={handleDeleteNode}
                onRename={handleRenameNode}
                recentVersions={recentVersions}
                onRun={(input, reuseUnchanged) => handleRun(selected, input, reuseUnchanged)}
                runStatus={nodeStatuses[selected]}
              />
            )}
          </>
        ) : (
          <div className="loading-center">Loading…</div>
        )}
      </div>
    </div>
  );
}
