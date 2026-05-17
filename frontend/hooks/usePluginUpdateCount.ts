import { useEffect, useState } from 'react';
import { useWebSocket } from '@darkrideapp/plugin-sdk/react';

/**
 * Number of installed plugins with an update available. Drives the badge
 * on the Marketplace nav item. Polls /v1/plugins/installed every 5 minutes
 * — the backend's plugin-update-check job refreshes the source cache every
 * 6 hours, so polling more often is wasted RTT.
 *
 * Returns 0 on failure (e.g. caller lacks `core.plugins:manage`) so the
 * badge silently disappears for users who couldn't act on it anyway.
 */
export function usePluginUpdateCount(): number {
  const ws = useWebSocket();
  const [count, setCount] = useState(0);

  useEffect(() => {
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
  }, [ws]);

  return count;
}
