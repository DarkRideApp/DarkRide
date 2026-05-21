import { describe, it, expect, vi } from 'vitest';
import { definePlugin } from '../define-plugin';
import { PluginContextImpl, createEmptyContributions } from '../../../../backend/plugins/plugin-context';
import { HookBusImpl } from '../hook-bus-impl';

describe('ctx.deviceProviders([...])', () => {
  it('collects provider registrations from register() into contributions', () => {
    const plugin = definePlugin({
      name: 'demo',
      register(ctx) {
        ctx.deviceProviders([
          {
            id: 'corellium',
            displayName: 'Corellium',
            networkMode: 'corellium-tunnel',
            implementation: { /* DeviceProvider impl */ } as any,
            captureHandler: async () => {},
            capabilities: { canCreate: true, canDelete: true },
          },
        ]);
      },
    });

    const contributions = createEmptyContributions();
    const ctx = new PluginContextImpl('demo', new HookBusImpl(), contributions, '/tmp');
    plugin.register(ctx);
    expect(contributions.deviceProviders).toHaveLength(1);
    expect(contributions.deviceProviders[0]).toMatchObject({
      id: 'corellium',
      networkMode: 'corellium-tunnel',
    });
  });
});
