import { useEffect, useState } from 'react';
import { useAuthOptional, useWebSocket } from '@darkrideapp/plugin-sdk/react';

/**
 * Number of installed plugins with an update available. Drives the badge
 * on the Marketplace nav item. Polls /v1/plugins/installed every 5 minutes
 * — the backend's plugin-update-check job refreshes the source cache every
 * 6 hours, so polling more often is wasted RTT.
 *
 * Returns 0 without calling the API when the caller lacks `core.plugins:manage`:
 * the SDK toasts every failed call, so asking would show them a scope error
 * on every page.
 */
export function usePluginUpdateCount(): number {
  const ws = useWebSocket();
  const auth = useAuthOptional();
  const allowed = auth?.hasScope('core.plugins:manage') ?? true;
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!allowed) {
      setCount(0);
      return;
    }
    let cancelled = false;

    const refresh = async () => {
      try {
        const res = await ws.sendRestApi('GET', '/v1/plugins/installed');
        if (cancelled) return;
        const plugins = res?.body?.success ? (res.body.data?.plugins ?? []) : [];
        const next = Array.isArray(plugins)
          ? plugins.filter((p: { updateAvailable?: boolean }) => p.updateAvailable === true).length
          : 0;
        setCount(next);
      } catch {
        if (!cancelled) setCount(0);
      }
    };

    refresh();
    const interval = setInterval(refresh, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [ws, allowed]);

  return count;
}
