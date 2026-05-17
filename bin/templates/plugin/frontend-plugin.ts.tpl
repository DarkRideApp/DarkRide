import { lazy } from 'react';
import { pluginRegistry } from '../../../frontend/lib/plugin-registry';

pluginRegistry.registerPages('{{slug}}', [
  { path: '/{{slug}}', component: lazy(() => import('./pages/Main').then(m => ({ default: m.default }))) },
]);

pluginRegistry.registerNav('{{slug}}', [
  { group: 'Tools', label: '{{label}}', path: '/{{slug}}', icon: 'box' },
]);
