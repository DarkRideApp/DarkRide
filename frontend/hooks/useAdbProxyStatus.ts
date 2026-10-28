import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';
import type { StatusSnapshot } from '../../shared/types/adb-proxy';

/** The ADB proxy status: fetched once, then replaced by every snapshot the server pushes. */
export function useAdbProxyStatus(): { status: StatusSnapshot | null; error: string | null; refresh: () => Promise<void> } {
  // The context object is rebuilt on every host render; only its functions are stable.
  const { sendRestApi, subscribe, connected } = useWebSocket();
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await sendRestApi('GET', '/v1/adb-proxy/status');
      if (res.body?.success) {
        setStatus(res.body.data as StatusSnapshot);
        setError(null);
      } else {
        setError(res.body?.error ?? 'Could not load the ADB proxy status.');
      }
    } catch {
      setError('Could not load the ADB proxy status.');
    }
  }, [sendRestApi]);

  useEffect(() => {
    void refresh();
  }, [refresh, connected]);

  useEffect(
    () =>
      subscribe('adb-proxy', (msg) => {
        const { type: _type, ...snapshot } = msg;
        setStatus(snapshot as StatusSnapshot);
      }),
    [subscribe],
  );

  return { status, error, refresh };
}
