import React from 'react';
import { usePluginRegistrySnapshot } from '../plugin-registry';
import type { ButtonListItem } from '../plugin-registry/types';
import { resolveIcon } from '../lib/icon-map';
import { useAuthOptional } from '../hooks/useAuth';
import { InspectorWrapper } from './InspectorWrapper';

export interface ButtonListItemProps {
  item: ButtonListItem & { plugin?: string };
}

export interface ButtonListProps {
  buttons: ButtonListItem[];
  id?: string;
  className?: string;
  ItemComponent?: React.ComponentType<ButtonListItemProps>;
}

function useHasScope(): (scope: string) => boolean {
  const auth = useAuthOptional();
  return auth?.hasScope ?? (() => true);
}

export function DefaultButtonListItem({ item }: ButtonListItemProps): React.JSX.Element {
  const Icon = item.icon ? resolveIcon(item.icon) : null;
  return (
    <button
      className="btn btn-sm"
      disabled={item.disabled ?? false}
      onClick={item.onClick}
      title={item.label}
    >
      {Icon ? <Icon size={14} /> : null}
      <span>{item.label}</span>
    </button>
  );
}

export function ButtonList({
  buttons,
  id,
  className,
  ItemComponent = DefaultButtonListItem,
}: ButtonListProps): React.JSX.Element {
  const hasScope = useHasScope();
  const injected = usePluginRegistrySnapshot(r => id ? r.getButtonContributions(id) : []);
  const merged = [...buttons, ...injected]
    .filter(b => !b.requiredScope || hasScope(b.requiredScope))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  return (
    <InspectorWrapper id={id} count={merged.length}>
      <div className={`button-list ${className ?? ''}`} data-slot-id={id}>
        {merged.map(b => <ItemComponent key={b.id} item={b} />)}
      </div>
    </InspectorWrapper>
  );
}
