import { lazy } from 'react';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';

pluginRegistry.registerPages('{{slug}}', [
  { path: '/{{slug}}', component: lazy(() => import('./pages/Main').then(m => ({ default: m.default }))) },
]);

pluginRegistry.registerNav('{{slug}}', [
  { group: 'Tools', label: '{{label}}', path: '/{{slug}}', icon: 'box' },
]);
