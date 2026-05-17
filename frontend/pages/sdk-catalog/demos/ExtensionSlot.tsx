import { ExtensionSlot } from '@darkrideapp/plugin-sdk/react';

export default function ExtensionSlotDemo() {
  return (
    <ExtensionSlot
      id="core:catalog:demo"
      emptyFallback={
        <div style={{ padding: '1rem', background: 'var(--bg-secondary)', borderRadius: 4, fontSize: 14, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          No plugin contributions yet — install a plugin that targets core:catalog:demo
        </div>
      }
    />
  );
}
