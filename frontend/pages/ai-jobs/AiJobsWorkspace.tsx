import React, { useEffect, useState } from 'react';
import { useWebSocket, useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Canvas } from './Canvas';
import { SidePanel } from './SidePanel';
import { RunControls } from './RunControls';
import type { PipelineGraph, PipelineNode, TriggerConfig } from '../../../backend/services/ai-jobs/types';

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

/** `pollIntervalMs` exists so tests can poll without a real 2s wall-clock wait per attempt. */
export function AiJobsWorkspace({ pollIntervalMs = POLL_INTERVAL_MS }: { pollIntervalMs?: number } = {}) {
  useDocumentTitle('AI Job Pipelines');
  const { sendRestApi } = useWebSocket();
  const [graph, setGraph] = useState<PipelineGraph | null>(null);
  const [pipelineId, setPipelineId] = useState<number | null>(null); // threaded into Task 24's Run call instead of a hardcoded id
  const [selected, setSelected] = useState<string | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, { status: string; wasMemoized?: boolean }>>({});
  const [recentVersions, setRecentVersions] = useState<RecentVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sendRestApi('GET', '/v1/ai-pipelines').then((res: any) => {
      if (cancelled) return;
      const apkPipeline = res.body?.data?.find((p: any) => p.jobKind === 'apk-analysis');
      if (apkPipeline?.graph) { setGraph(apkPipeline.graph); setPipelineId(apkPipeline.id); }
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
      setRunMessage('Select an APK version to run against first.');
      return;
    }
    setRunMessage(null);
    // pipelineId comes from the `pipelineId` state set alongside setGraph above (the real id
    // GET /v1/ai-pipelines returned for the apk-analysis entry) — never a hardcoded literal.
    const runRes: any = await sendRestApi('POST', `/v1/ai-pipelines/${pipelineId}/run`, {
      triggerNodeId, input: { versionId: selectedVersionId }, reuseUnchanged,
    });
    const runId = runRes.body?.data?.runId;
    if (runId == null) {
      // The POST itself failed (403 disabled, 409 already running, 400 bad trigger, 404) —
      // nothing to poll.
      setRunMessage(runRes.body?.error ?? 'The run could not be started.');
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
        setRunMessage(`Run ${runId} finished: ${run.status}`);
        return detailRes.body?.data;
      }
    }
    setRunMessage(`Run ${runId} is still running on the server. Check back later.`);
  }

  if (!graph) return <div className="page-header"><h1>Pipelines</h1></div>; // loading state — replace with a real spinner in Task 23, not this task's concern

  // Real label source is a follow-up — Task 20's graph has no human-readable Trigger display
  // name field today, just its id; adding one is a small, separate schema/UI change, not
  // blocking this task.
  const triggerNodes = graph.nodes.filter(n => n.config.kind === 'Trigger').map(n => ({ id: n.id, label: n.id }));

  return (
    <div className="ai-jobs-root">
      <div className="ai-jobs-toolbar">
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
        {runMessage && <div role="status" className="ai-jobs-status">{runMessage}</div>}
      </div>
      <div className="ai-jobs-canvas-wrap">
        <Canvas graph={graph} onSelectNode={setSelected} nodeStatuses={nodeStatuses} />
        {selected && (
          // key: a different node must get a fresh panel. Without it React reuses the instance and
          // AgentCallBody's `template` state (seeded once from props) keeps showing the PREVIOUS
          // node's prompt — and typing then saves it under the new node's id.
          <SidePanel
            key={selected}
            node={graph.nodes.find(n => n.id === selected)!}
            triggerSchema={findOwningTriggerSchema(graph, selected)}
            onClose={() => setSelected(null)}
            onSave={(nodeId, patch) => {
              setGraph(g => g && ({ ...g, nodes: g.nodes.map(n => n.id === nodeId ? { ...n, config: { ...n.config, ...patch } } : n) }));
            }}
          />
        )}
      </div>
    </div>
  );
}
