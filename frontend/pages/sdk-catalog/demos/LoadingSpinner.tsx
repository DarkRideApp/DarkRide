import { LoadingSpinner } from '@darkrideapp/plugin-sdk/react';

export default function LoadingSpinnerDemo() {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      <LoadingSpinner />
      <LoadingSpinner large />
    </div>
  );
}
