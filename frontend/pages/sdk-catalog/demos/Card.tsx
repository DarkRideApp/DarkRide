import { Card, StatCard } from '@darkrideapp/plugin-sdk/react';

export default function CardDemo() {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      <Card><p style={{ margin: 0, fontSize: 14 }}>Basic card with body content</p></Card>
      <StatCard label="Active Sessions" value={42} />
      <StatCard label="Errors" value={3} />
    </div>
  );
}
