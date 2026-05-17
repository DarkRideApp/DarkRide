import React, { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { pluginRegistry, usePluginRegistrySnapshot } from '../plugin-registry';
import { useSlotInspectorEnabled } from '../lib/dev-tools';
import { InspectorWrapper } from './InspectorWrapper';

interface ExtensionSlotProps {
  /** Slot id, typically `<pluginName>:<surface>:<position>`. */
  id: string;
  /** Scoped props forwarded to every contribution's component. */
  props?: Record<string, unknown>;
  /** Rendered when no contributions target this slot. */
  emptyFallback?: ReactNode;
}

export function ExtensionSlot({ id, props, emptyFallback }: ExtensionSlotProps): React.JSX.Element {
  const warned = useRef(false);
  useEffect(() => {
    if (warned.current) return;
    const declared = pluginRegistry.getAllSlots().some(s => s.id === id);
    if (!declared) {
      warned.current = true;
      console.warn(
        `[ExtensionSlot] No plugin declared slot "${id}". ` +
        `Declare it via ctx.uiSlots([{ id: '${id}', kind: 'container', description: '...' }]).`,
      );
    }
  }, [id]);

  const inspector = useSlotInspectorEnabled();
  const contribs = usePluginRegistrySnapshot(r => r.getSlotContributions(id));

  const renderedContribs = contribs.length === 0
    ? (inspector
        ? <div style={{
            minHeight: 80,
            background: 'var(--surface-muted, rgba(0,0,0,0.04))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic',
          }}>(no contributions)</div>
        : <>{emptyFallback ?? null}</>)
    : <>{contribs.map(c => { const C = c.component; return <C key={c.id} {...(props ?? {})} />; })}</>;

  return (
    <InspectorWrapper id={id} count={contribs.length}>
      {renderedContribs}
    </InspectorWrapper>
  );
}
