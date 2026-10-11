import React from 'react';
import { useAdbProxyStatus } from '../../hooks/useAdbProxyStatus';

/** Number of machines waiting for approval; renders nothing when there are none. */
export function AdbProxyPendingBadge() {
  const { status } = useAdbProxyStatus();
  const count = status?.pending.length ?? 0;
  if (count === 0) return null;
  return (
    <span className="badge badge-warning badge-sm" data-testid="adb-proxy-pending-badge" style={{ marginLeft: 6 }}>
      {count}
    </span>
  );
}
