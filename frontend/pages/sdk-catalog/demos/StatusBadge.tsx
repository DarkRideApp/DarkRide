import { StatusBadge } from '@darkrideapp/plugin-sdk/react';

export default function StatusBadgeDemo() {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      {['online', 'offline', 'running', 'success', 'failed', 'error', 'warning', 'cancelled', 'rooted'].map(s => (
        <StatusBadge key={s} status={s} />
      ))}
    </div>
  );
}
