import { Breadcrumbs } from '@darkrideapp/plugin-sdk/react';

export default function BreadcrumbsDemo() {
  return (
    <Breadcrumbs items={[
      { label: 'Settings', to: '/ui/settings' },
      { label: 'Plugins', to: '/ui/settings/plugins' },
      { label: 'SDK Catalog' },
    ]} />
  );
}
