import { InspectorWrapper } from '@darkrideapp/plugin-sdk/react';

export default function InspectorWrapperDemo() {
  return (
    <InspectorWrapper id="core:settings:tabs" count={3}>
      <div style={{ padding: '0.5rem', background: 'var(--bg-secondary)', borderRadius: 4, fontSize: 14 }}>
        Wrapped slot content (3 items)
      </div>
    </InspectorWrapper>
  );
}
