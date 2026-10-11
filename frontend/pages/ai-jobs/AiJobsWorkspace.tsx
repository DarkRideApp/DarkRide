import React, { useEffect, useState } from 'react';
import { useWebSocket, useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Canvas } from './Canvas';
import { SidePanel } from './SidePanel';
import { RunControls } from './RunControls';
import { addNode, deleteNode, addEdge, deleteEdge, moveNode } from './graphEdit';
import type { NodeKind, PipelineGraph, PipelineNode, TriggerConfig } from '../../../backend/services/ai-jobs/types';

/**
 * Forward-reachability BFS defining a Trigger's zone — duplicated client-side rather than
 * imported, for the same frontend/backend-boundary reason `templatePreview.ts` duplicates
 * `resolveTemplate`. Verbatim copy of Task 16's `reachableFrom` in
 * backend/services/ai-jobs/pipeline-runner.ts.
 */
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

/** The Trigger whose zone actually contains `nodeId` — never just "the first Trigger in the
 * graph." A valid published graph (graph-validator, Task 16) guarantees every non-Trigger node
 * is reachable from some Trigger, so the fallback below is defensive, not a real path. */
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface RecentVersion { id: number; appName: string | null; packageName: string; versionName: string | null }
interface PipelineRow { id: number; name?: string | null; jobKind: string; pipelineVersionId: number | null; graph: PipelineGraph | null }

const NODE_KINDS: NodeKind[] = ['Trigger', 'AgentCall', 'Transform', 'Branch', 'Report', 'ForEach', 'Sink'];
const EMPTY_GRAPH: PipelineGraph = { nodes: [], edges: [] };

/** `pollIntervalMs` exists so tests can poll without a real 2s wall-clock wait per attempt. */
export function AiJobsWorkspace({ pollIntervalMs = POLL_INTERVAL_MS }: { pollIntervalMs?: number } = {}) {
  useDocumentTitle('AI Job Pipelines');
  const { sendRestApi } = useWebSocket();
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<number | null>(null);
  const [graph, setGraph] = useState<PipelineGraph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, { status: string; wasMemoized?: boolean }>>({});
  const [recentVersions, setRecentVersions] = useState<RecentVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [nodeKindToAdd, setNodeKindToAdd] = useState<NodeKind>('AgentCall');
  const [showNewPipelineForm, setShowNewPipelineForm] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [newPipelineJobKind, setNewPipelineJobKind] = useState('');

  useEffect(() => {
    let cancelled = false;
    sendRestApi('GET', '/v1/ai-pipelines').then((res: any) => {
      if (cancelled) return;
      const rows: PipelineRow[] = res.body?.data ?? [];
      setPipelines(rows);
      // Default to the real apk-analysis pipeline when it exists, else whatever's first.
      const initial = rows.find(r => r.jobKind === 'apk-analysis') ?? rows[0];
      if (initial) {
        setSelectedPipelineId(initial.id);
        setGraph(initial.graph ?? EMPTY_GRAPH);
      }
    });
    // The pipeline's Trigger expands `input.versionId` into the APK context — a run with no
    // versionId throws at the Trigger (found in the final review: the Run button sent
    // `input: {}`, so every UI run failed immediately). GET /v1/apps/recent is the existing
    // "recent APK versions" list (backend/api/apps.ts).
    sendRestApi('GET', '/v1/apps/recent').then((res: any) => {
      if (cancelled) return;
      const list: RecentVersion[] = res.body?.data ?? [];
      setRecentVersions(list);
      if (list.length > 0) setSelectedVersionId(list[0].id);
    });
    return () => { cancelled = true; };
  }, [sendRestApi]);

  // Imperative, not a useEffect keyed on `pipelines` — switching only happens from direct user
  // action, so loading a different pipeline's graph can never be retriggered by an unrelated
  // `pipelines` state change (e.g. appending a freshly created pipeline), which would otherwise
  // clobber in-progress, unsaved edits on the pipeline currently open.
  function handleSelectPipeline(id: number) {
    setSelectedPipelineId(id);
    const row = pipelines.find(p => p.id === id);
    setGraph(row?.graph ?? EMPTY_GRAPH);
    setSelected(null);
    setNodeStatuses({});
  }

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    const jobKind = newPipelineJobKind.trim();
    if (!name || !jobKind) {
      setStatusMessage('Give the new pipeline a name and a job kind first.');
      return;
    }
    const res: any = await sendRestApi('POST', '/v1/ai-pipelines', { name, jobKind, graph: EMPTY_GRAPH });
    const id = res.body?.data?.id;
    if (id == null) {
      setStatusMessage(res.body?.error ?? 'Could not create the pipeline.');
      return;
    }
    const row: PipelineRow = { id, name, jobKind, pipelineVersionId: null, graph: EMPTY_GRAPH };
    setPipelines(prev => [...prev, row]);
    setSelectedPipelineId(id);
    setGraph(EMPTY_GRAPH);
    setSelected(null);
    setShowNewPipelineForm(false);
    setNewPipelineName('');
    setNewPipelineJobKind('');
  }

  function handleAddNode() {
    if (!graph) return;
    // Same placeholder-grid math Canvas falls back to for an unmoved node, offset below the
    // existing rows so a newly added node doesn't render stacked on top of another placeholder.
    const i = graph.nodes.length;
    const position = { x: (i % 4) * 260, y: Math.floor(i / 4) * 160 + 200 };
    const { graph: next, newNodeId } = addNode(graph, nodeKindToAdd, position);
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

  function handleConnectNodes(from: string, to: string) {
    setGraph(g => g && addEdge(g, from, to));
  }

  function handleDeleteEdge(from: string, to: string) {
    setGraph(g => g && deleteEdge(g, from, to));
  }

  async function handleSaveDraft() {
    if (!graph || selectedPipelineId == null) return;
    const res: any = await sendRestApi('POST', `/v1/ai-pipelines/${selectedPipelineId}/versions`, { graph });
    if (res.body?.success) setStatusMessage(`Draft saved as version ${res.body?.data?.version}.`);
    else setStatusMessage(res.body?.error ?? 'Could not save the draft.');
  }

  async function handlePublish() {
    if (selectedPipelineId == null) return;
    const res: any = await sendRestApi('POST', `/v1/ai-pipelines/${selectedPipelineId}/publish`, {});
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
   * Kicks off a run via `POST /v1/ai-pipelines/:id/run` against the selected APK version, then
   * polls `GET /v1/ai-pipelines/runs/:runId` every `pollIntervalMs` until the run leaves
   * 'running', and applies its per-node results. `/run` answers as soon as the run is recorded
   * (backend/services/ai-jobs/run-executor.ts) — a real multi-AgentCall run takes minutes, far
   * past the client's 30s REST timeout, so the client cannot wait on the POST itself. Per-node
   * results are only ever readable from the run-detail endpoint (shape `{ run, nodes }`), and
   * only once the whole run settles. Polling gives up after `MAX_POLL_ATTEMPTS`; the run may
   * still be going server-side, and the message says so.
   */
  async function handleRun(triggerNodeId: string, reuseUnchanged: boolean) {
    if (selectedVersionId == null) {
      setStatusMessage('Select an APK version to run against first.');
      return;
    }
    setStatusMessage(null);
    const runRes: any = await sendRestApi('POST', `/v1/ai-pipelines/${selectedPipelineId}/run`, {
      triggerNodeId, input: { versionId: selectedVersionId }, reuseUnchanged,
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
        const byId: Record<string, { status: string; wasMemoized?: boolean }> = {};
        for (const n of detailRes.body?.data?.nodes ?? []) byId[n.nodeId] = { status: n.status, wasMemoized: n.wasMemoized };
        setNodeStatuses(byId);
        setStatusMessage(`Run ${runId} finished: ${run.status}`);
        return detailRes.body?.data;
      }
    }
    setStatusMessage(`Run ${runId} is still running on the server. Check back later.`);
  }

  const triggerNodes = graph ? graph.nodes.filter(n => n.config.kind === 'Trigger').map(n => ({ id: n.id, label: n.id })) : [];

  return (
    <div className="ai-jobs-root">
      <div className="ai-jobs-toolbar">
        <div className="ai-jobs-toolbar-group">
          <label className="ai-jobs-toolbar-field">
            Pipeline
            <select
              className="form-select"
              aria-label="Pipeline"
              value={selectedPipelineId ?? ''}
              onChange={(e) => handleSelectPipeline(Number(e.target.value))}
            >
              {pipelines.length === 0 && <option value="">No pipelines yet</option>}
              {pipelines.map(p => <option key={p.id} value={p.id}>{p.name ?? p.jobKind} (#{p.id})</option>)}
            </select>
          </label>
          {!showNewPipelineForm ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowNewPipelineForm(true)}>+ New pipeline</button>
          ) : (
            <span className="ai-jobs-toolbar-group">
              <input className="form-input" aria-label="New pipeline name" placeholder="Name" value={newPipelineName} onChange={(e) => setNewPipelineName(e.target.value)} />
              <input className="form-input" aria-label="New pipeline job kind" placeholder="Job kind" value={newPipelineJobKind} onChange={(e) => setNewPipelineJobKind(e.target.value)} />
              <button type="button" className="btn btn-primary btn-sm" onClick={handleCreatePipeline}>Create</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowNewPipelineForm(false)}>Cancel</button>
            </span>
          )}
        </div>

        {graph && (
          <>
            <div className="ai-jobs-toolbar-group">
              <label className="ai-jobs-toolbar-field">
                APK version to run against
                <select
                  className="form-select"
                  aria-label="APK version"
                  value={selectedVersionId ?? ''}
                  onChange={(e) => setSelectedVersionId(Number(e.target.value))}
                >
                  {recentVersions.length === 0 && <option value="">No analyzed APK versions yet</option>}
                  {recentVersions.map(v => (
                    <option key={v.id} value={v.id}>{v.appName ?? v.packageName} v{v.versionName ?? '?'} (#{v.id})</option>
                  ))}
                </select>
              </label>
              <RunControls triggers={triggerNodes} onRun={handleRun} />
            </div>

            <div className="ai-jobs-toolbar-group">
              <label className="ai-jobs-toolbar-field">
                Add node
                <select
                  className="form-select"
                  aria-label="Node kind to add"
                  value={nodeKindToAdd}
                  onChange={(e) => setNodeKindToAdd(e.target.value as NodeKind)}
                >
                  {NODE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleAddNode}>+ Add node</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={handleSaveDraft}>Save Draft</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={handlePublish}>Publish</button>
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
              />
            )}
          </>
        ) : (
          <div className="page-header">
            <h1>Pipelines</h1>
            <p>{pipelines.length === 0 ? 'No pipelines yet — create one above.' : 'Loading…'}</p>
          </div>
        )}
      </div>
    </div>
  );
}
