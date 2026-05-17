import { PageHeader, Button } from '@darkrideapp/plugin-sdk/react';

export default function PageHeaderDemo() {
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 4, padding: '0.5rem' }}>
      <PageHeader
        title="Example Page"
        subtitle="With an optional subtitle"
        actions={<Button size="sm" variant="primary">Action</Button>}
      />
    </div>
  );
}
