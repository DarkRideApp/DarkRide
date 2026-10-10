import React, { useState } from 'react';

export function RunControls({ triggers, onRun }: {
  triggers: Array<{ id: string; label: string }>;
  // Deliberately `Promise<unknown>`, not a shaped result type: this component never reads the
  // resolved value, only awaits it to toggle `running` — see AiJobsWorkspace's handleRun for why
  // the real caller can't reliably promise a `nodes` field here (the POST /run response never
  // carries per-node results; see backend/api/ai-pipelines.ts:154).
  onRun: (triggerNodeId: string, reuseUnchanged: boolean) => Promise<unknown>;
}) {
  const [triggerNodeId, setTriggerNodeId] = useState(triggers[0]?.id ?? '');
  const [reuseUnchanged, setReuseUnchanged] = useState(false);
  const [running, setRunning] = useState(false);

  async function handleRun() {
    setRunning(true);
    try {
      await onRun(triggerNodeId, reuseUnchanged);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="run-controls">
      <label>
        Entry point
        <select aria-label="Entry point" value={triggerNodeId} onChange={(e) => setTriggerNodeId(e.target.value)}>
          {triggers.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          aria-label="Reuse unchanged nodes"
          checked={reuseUnchanged}
          onChange={(e) => setReuseUnchanged(e.target.checked)}
        />
        Reuse unchanged nodes
      </label>
      <button onClick={handleRun} disabled={running}>{running ? 'Running…' : 'Run'}</button>
    </div>
  );
}
