import { NavItemList } from '@darkrideapp/plugin-sdk/react';
import type { NavItemListItem } from '@darkrideapp/plugin-sdk/react';

// Demo items point back at the catalog so clicking doesn't navigate away.
const MOCK_NAV_ITEMS: NavItemListItem[] = [
  { id: 'nav1', label: 'Overview', to: '/settings/sdk-catalog' },
  { id: 'nav2', label: 'Plugins',  to: '/settings/sdk-catalog' },
  { id: 'nav3', label: 'Proxies',  to: '/settings/sdk-catalog' },
];

export default function NavItemListDemo() {
  return <NavItemList items={MOCK_NAV_ITEMS} />;
}
