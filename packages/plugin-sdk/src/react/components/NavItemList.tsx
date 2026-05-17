import React from 'react';
import { NavLink } from 'react-router-dom';
import { usePluginRegistrySnapshot } from '../plugin-registry';
import type { NavItemListItem } from '../plugin-registry/types';
import { resolveIcon } from '../lib/icon-map';
import { useAuthOptional } from '../hooks/useAuth';
import { InspectorWrapper } from './InspectorWrapper';

export interface NavItemListItemProps {
  item: NavItemListItem & { plugin?: string };
}

export interface NavItemListProps {
  items: NavItemListItem[];
  id?: string;
  className?: string;
  ItemComponent?: React.ComponentType<NavItemListItemProps>;
}

function useHasScope(): (scope: string) => boolean {
  const auth = useAuthOptional();
  return auth?.hasScope ?? (() => true);
}

export function DefaultNavItemListItem({ item }: NavItemListItemProps): React.JSX.Element {
  const Icon = item.icon ? resolveIcon(item.icon) : null;
  return (
    <NavLink
      to={`/ui${item.to}`}
      end={item.end ?? false}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
    >
      {Icon ? <Icon size={14} /> : null}
      <span>{item.label}</span>
      {item.badge != null ? <span className="nav-item-badge">{item.badge}</span> : null}
    </NavLink>
  );
}

export function NavItemList({
  items,
  id,
  className,
  ItemComponent = DefaultNavItemListItem,
}: NavItemListProps): React.JSX.Element {
  const hasScope = useHasScope();
  const injected = usePluginRegistrySnapshot(r => id ? r.getNavItemContributions(id) : []);
  const merged = [...items, ...injected]
    .filter(i => !i.requiredScope || hasScope(i.requiredScope))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  return (
    <InspectorWrapper id={id} count={merged.length}>
      <div className={`nav-item-list ${className ?? ''}`} data-slot-id={id}>
        {merged.map(i => <ItemComponent key={i.id} item={i} />)}
      </div>
    </InspectorWrapper>
  );
}
