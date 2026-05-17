import { SkeletonLine, SkeletonCard, SkeletonTable } from '@darkrideapp/plugin-sdk/react';

export default function SkeletonDemo() {
  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: '0.5rem' }}>
        <SkeletonLine width="60%" />
        <SkeletonLine width="80%" />
        <SkeletonLine width="40%" />
      </div>
      <div style={{ marginBottom: '0.5rem' }}>
        <SkeletonCard />
      </div>
      <SkeletonTable rows={3} columns={3} />
    </div>
  );
}
