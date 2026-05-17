import { lazy } from 'react';
import { pluginRegistry } from '@darkrideapp/plugin-sdk/react';
import { DemoExtra } from './contributions/DemoExtra';

pluginRegistry.registerPages('kitchen-sink', [
  { path: '/kitchen-sink', component: lazy(() => import('./pages/KitchenSink').then(m => ({ default: m.KitchenSink }))) },
]);

pluginRegistry.registerNav('kitchen-sink', [
  { group: 'Tools', label: 'Kitchen Sink', path: '/kitchen-sink', icon: 'flask-conical' },
]);

pluginRegistry.registerCommands('kitchen-sink', [
  {
    id: 'kitchen-sink:hello',
    label: 'Kitchen Sink: Say Hello',
    keywords: ['test', 'greeting'],
    icon: 'flask-conical',
    action: () => { window.location.href = '/ui/kitchen-sink'; },
  },
]);

pluginRegistry.registerUiSlots('kitchen-sink', [
  {
    id: 'kitchen-sink:demo:extra',
    kind: 'container',
    description: 'Demo slot on the kitchen-sink demo page. Shows off cross-plugin slot contributions — even if only the same plugin contributes.',
  },
]);

pluginRegistry.registerContributionComponents('kitchen-sink', {
  DemoExtra,
});

pluginRegistry.registerUiContributions('kitchen-sink', [
  { slot: 'kitchen-sink:demo:extra', id: 'kitchen-sink:demo-extra', component: 'DemoExtra' },
]);

pluginRegistry.registerButtonContribution('kitchen-sink', {
  slot: 'device-viewer:overflow-actions',
  id: 'kitchen-sink:hello-device',
  label: 'Kitchen Sink: Say Hello',
  icon: 'flask-conical',
  onClick: () => { alert('Hello from kitchen-sink plugin!'); },
});

// Dummy protocol decoder to test the extension point
pluginRegistry.registerDecoders('kitchen-sink', [
  {
    id: 'kitchen-sink-echo',
    name: 'Kitchen Sink Echo (test)',
    detect: (headers: Record<string, string>) => {
      return headers['x-kitchen-sink-test'] === 'true';
    },
    decodeFrames: (frames) => frames.map((f, i) => ({
      messageNumber: i,
      type: 'request',
      typeLabel: 'ECHO',
      direction: f.direction,
      properties: { decoder: 'kitchen-sink-echo' },
      body: f.payload,
      bodySize: f.payloadSize,
      timestamp: f.timestamp,
      flags: [],
      rawFrameIds: [f.id],
    })),
  },
]);
