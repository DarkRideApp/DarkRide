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

export function AiJobsWorkspace() {
  useDocumentTitle('AI Job Pipelines');
  const { sendRestApi } = useWebSocket();
  const [graph, setGraph] = useState<PipelineGraph | null>(null);
  const [pipelineId, setPipelineId] = useState<number | null>(null); // threaded into Task 24's Run call instead of a hardcoded id
  const [selected, setSelected] = useState<string | null>(null);
  const [nodeStatuses, setNodeStatuses] = useState<Record<string, { status: string; wasMemoized?: boolean }>>({});

  useEffect(() => {
    let cancelled = false;
    sendRestApi('GET', '/v1/ai-pipelines').then((res: any) => {
      if (cancelled) return;
      const apkPipeline = res.body?.data?.find((p: any) => p.jobKind === 'apk-analysis');
      if (apkPipeline?.graph) { setGraph(apkPipeline.graph); setPipelineId(apkPipeline.id); }
    });
    return () => { cancelled = true; };
  }, [sendRestApi]);

  /**
   * Kicks off a run via `POST /v1/ai-pipelines/:id/run`, then follows up with
   * `GET /v1/ai-pipelines/runs/:runId` to fetch per-node results — the real `/run` endpoint
   * (`backend/api/ai-pipelines.ts:154`) only ever responds `{ runId, status }`, never `nodes`;
   * those are persisted to `aiPipelineNodeRuns` and only readable back via the run-detail
   * endpoint (`ai-pipelines.ts:166-172`, shape `{ run, nodes }`). Without the follow-up GET,
   * `nodeStatuses` would stay `{}` forever, even after a fully successful run.
   */
  async function handleRun(triggerNodeId: string, reuseUnchanged: boolean) {
    // pipelineId comes from the `pipelineId` state set alongside setGraph above (the real id
    // GET /v1/ai-pipelines returned for the apk-analysis entry) — never a hardcoded literal.
    const runRes: any = await sendRestApi('POST', `/v1/ai-pipelines/${pipelineId}/run`, { triggerNodeId, input: {}, reuseUnchanged });
    const runId = runRes.body?.data?.runId;
    // The /run response never includes per-node results (see doc comment above) — fetch them
    // from the run-detail endpoint. A failed POST (409 already-running, 400 bad trigger, 404,
    // 500) has no runId, so this is skipped and nodeStatuses is simply left unchanged;
    // surfacing a run failure to the user is real follow-up work, not added here.
    if (runId != null) {
      const detailRes: any = await sendRestApi('GET', `/v1/ai-pipelines/runs/${runId}`);
      const byId: Record<string, { status: string; wasMemoized?: boolean }> = {};
      for (const n of detailRes.body?.data?.nodes ?? []) byId[n.nodeId] = { status: n.status, wasMemoized: n.wasMemoized };
      setNodeStatuses(byId);
    }
    return runRes.body?.data;
  }

  if (!graph) return <div className="page-header"><h1>Pipelines</h1></div>; // loading state — replace with a real spinner in Task 23, not this task's concern

  // Real label source is a follow-up — Task 20's graph has no human-readable Trigger display
  // name field today, just its id; adding one is a small, separate schema/UI change, not
  // blocking this task.
  const triggerNodes = graph.nodes.filter(n => n.config.kind === 'Trigger').map(n => ({ id: n.id, label: n.id }));

  return (
    <div className="ai-jobs-root" style={{ height: '100vh' }}>
      <RunControls triggers={triggerNodes} onRun={handleRun} />
      <Canvas graph={graph} onSelectNode={setSelected} nodeStatuses={nodeStatuses} />
      {selected && (
        <SidePanel
          node={graph.nodes.find(n => n.id === selected)!}
          triggerSchema={findOwningTriggerSchema(graph, selected)}
          onClose={() => setSelected(null)}
          onSave={(nodeId, patch) => {
            setGraph(g => g && ({ ...g, nodes: g.nodes.map(n => n.id === nodeId ? { ...n, config: { ...n.config, ...patch } } : n) }));
          }}
        />
      )}
    </div>
  );
}
