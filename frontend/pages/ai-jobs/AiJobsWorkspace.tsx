import React, { useEffect, useState } from 'react';
import { useWebSocket, useDocumentTitle } from '@darkrideapp/plugin-sdk/react';
import { Canvas } from './Canvas';
import type { PipelineGraph } from '../../../backend/services/ai-jobs/types';

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
      {selected && <div data-testid="selected-node">{selected}</div>}
    </div>
  );
}
