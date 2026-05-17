import React, { useState } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';

interface Props {
  packageName: string;
  versionId: number;
  label?: string;
  onComplete?: () => void;
}

/**
 * Triggers POST /v1/apks/:package/:versionId/restore, shows a spinner while
 * the request is in flight, surfaces the error and offers a Retry button.
 */
export function RestoreButton({ packageName, versionId, label = 'Restore', onComplete }: Props): JSX.Element {
  const ws = useWebSocket();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setErr(null);
    try {
      const res = await ws.sendRestApi('POST', `/v1/apks/${encodeURIComponent(packageName)}/${versionId}/restore`);
      if (res.status !== 200 || !res.body) {
        throw new Error(res.body?.error ?? `HTTP ${res.status}`);
      }
      if (onComplete) onComplete();
    } catch (e: any) {
      setErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={onClick} disabled={busy}>
        {busy ? 'Restoring…' : err ? 'Retry restore' : label}
      </button>
      {err && <span className="text-error" title={err} role="alert">⚠</span>}
    </>
  );
}
