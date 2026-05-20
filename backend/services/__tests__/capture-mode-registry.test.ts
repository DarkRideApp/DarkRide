import { describe, it, expect, vi } from 'vitest';
import { createCaptureModeRegistry } from '../capture-mode-registry';
import type { DeviceProviderInstance, NetworkConfig } from '@darkrideapp/plugin-sdk';

const sampleInstance: DeviceProviderInstance = {
  id: 'x', displayName: 'x', state: 'running', serial: 'x', spawnedByDarkride: false,
};

describe('captureModeRegistry', () => {
  it('register + dispatch routes to the matching handler', async () => {
    const reg = createCaptureModeRegistry();
    const wg = vi.fn().mockResolvedValue(undefined);
    reg.register('wireguard', wg);
    await reg.dispatch(sampleInstance, { mode: 'wireguard' });
    expect(wg).toHaveBeenCalledWith(sampleInstance, { mode: 'wireguard' });
  });

  it('dispatch on an unregistered mode throws a structured error', async () => {
    const reg = createCaptureModeRegistry();
    await expect(reg.dispatch(sampleInstance, { mode: 'unknown' } as NetworkConfig))
      .rejects.toThrow(/No capture handler registered for mode "unknown"/);
  });

  it('registering the same mode twice throws (modes are unique)', () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', vi.fn());
    expect(() => reg.register('wireguard', vi.fn())).toThrow(/already registered/i);
  });

  it('has() reports registration status', () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', vi.fn());
    expect(reg.has('wireguard')).toBe(true);
    expect(reg.has('ios-bridge')).toBe(false);
  });
});
