import React, { useEffect, useState } from 'react';
import { useWebSocket, useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Canvas } from './Canvas';
import { SidePanel } from './SidePanel';
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

  useEffect(() => {
    let cancelled = false;
    sendRestApi('GET', '/v1/ai-pipelines').then((res: any) => {
      if (cancelled) return;
      const apkPipeline = res.body?.data?.find((p: any) => p.jobKind === 'apk-analysis');
      if (apkPipeline?.graph) { setGraph(apkPipeline.graph); setPipelineId(apkPipeline.id); }
    });
    return () => { cancelled = true; };
  }, [sendRestApi]);

  if (!graph) return <div className="page-header"><h1>Pipelines</h1></div>; // loading state — replace with a real spinner in Task 23, not this task's concern

  return (
    <div className="ai-jobs-root" style={{ height: '100vh' }}>
      <Canvas graph={graph} onSelectNode={setSelected} />
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
