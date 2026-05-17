import React from 'react';
import { useSlotInspectorEnabled } from '../lib/dev-tools';
import { pluginRegistry } from '../plugin-registry';

export interface InspectorWrapperProps {
  /** Slot id. When undefined, the wrapper is inert (just renders children). */
  id?: string;
  /** Number of items rendered in the slot (shown in the badge). */
  count: number;
  children: React.ReactNode;
}

export function InspectorWrapper({ id, count, children }: InspectorWrapperProps): React.JSX.Element {
  const enabled = useSlotInspectorEnabled();
  if (!enabled || !id) return <>{children}</>;
  const slotMeta = pluginRegistry.getAllSlots().find(s => s.id === id);
  return (
    <div
      data-testid="slot-inspector-wrapper"
      data-slot-inspector=""
      style={{
        position: 'relative',
        outline: '2px dashed var(--color-accent, #6366f1)',
        outlineOffset: 2,
        padding: 4,
        marginBlock: 4,
      }}
    >
      <div
        data-testid="slot-inspector-badge"
        title={slotMeta?.description ?? ''}
        style={{
          position: 'absolute', top: -8, left: 8,
          fontSize: 10, fontFamily: 'monospace', whiteSpace: 'nowrap',
          background: 'var(--color-accent, #6366f1)', color: '#fff',
          padding: '1px 6px', borderRadius: 3, zIndex: 1, cursor: 'help',
        }}
      >
        {id} · {count}
      </div>
      {children}
    </div>
  );
}
