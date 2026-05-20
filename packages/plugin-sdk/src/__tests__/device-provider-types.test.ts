import { describe, it, expectTypeOf } from 'vitest';
import type {
  DeviceProvider,
  DeviceProviderInstance,
  NetworkConfig,
  CreateInstanceSpec,
  RunningInstance,
  CreateFormSchema,
  CaptureHandler,
} from '../types';

describe('DeviceProvider type surface', () => {
  it('DeviceProvider is callable with the documented method set', () => {
    expectTypeOf<DeviceProvider>().toHaveProperty('id').toBeString();
    expectTypeOf<DeviceProvider>().toHaveProperty('displayName').toBeString();
    expectTypeOf<DeviceProvider>().toHaveProperty('isAvailable').toBeFunction();
    expectTypeOf<DeviceProvider>().toHaveProperty('listInstances').toBeFunction();
    expectTypeOf<DeviceProvider>().toHaveProperty('startInstance').toBeFunction();
    expectTypeOf<DeviceProvider>().toHaveProperty('stopInstance').toBeFunction();
    expectTypeOf<DeviceProvider>().toHaveProperty('getNetworkConfig').toBeFunction();
  });

  it('NetworkConfig discriminates by mode string with extension', () => {
    const wg: NetworkConfig = { mode: 'wireguard' };
    const ios: NetworkConfig = { mode: 'ios-bridge' };
    const plugin: NetworkConfig = { mode: 'corellium-tunnel', endpoint: 'wss://...' };
    expectTypeOf(wg).toMatchTypeOf<NetworkConfig>();
    expectTypeOf(ios).toMatchTypeOf<NetworkConfig>();
    expectTypeOf(plugin).toMatchTypeOf<NetworkConfig>();
  });

  it('DeviceProviderInstance has state union restricted to the documented values', () => {
    type State = DeviceProviderInstance['state'];
    expectTypeOf<State>().toEqualTypeOf<'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'>();
  });
});
