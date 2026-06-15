import { describe, it, expectTypeOf } from 'vitest';
import type {
  DeviceProvider,
  DeviceProviderInstance,
  NetworkConfig,
  NetworkMode,
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

    // A typo of a built-in mode must not silently typecheck against the
    // narrowed arm. The `@ts-expect-error` line below MUST be an error
    // (TS reports "unused @ts-expect-error" if it's not).
    // @ts-expect-error 'wireguad' is a typo of 'wireguard' — must not satisfy the narrowed arm.
    const typoBlocked: { mode: 'wireguard' } = { mode: 'wireguad' };
    void typoBlocked;
  });

  it('NetworkMode is exported and usable as a standalone alias', () => {
    const m: NetworkMode = 'wireguard';
    const plug: NetworkMode = 'corellium-tunnel';
    expectTypeOf<NetworkMode>().toMatchTypeOf<string>();
    void m; void plug;
  });

  it('DeviceProviderInstance has state union restricted to the documented values', () => {
    type State = DeviceProviderInstance['state'];
    expectTypeOf<State>().toEqualTypeOf<'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error'>();
  });
});

describe('DeviceProvider — video transport', () => {
  it('declares optional videoTransport with the webrtc | scrcpy union', () => {
    expectTypeOf<DeviceProvider['videoTransport']>().toEqualTypeOf<'webrtc' | 'scrcpy' | undefined>();
  });

  it('declares optional getGrpcEndpoint returning host+port+token', () => {
    type Endpoint = NonNullable<DeviceProvider['getGrpcEndpoint']>;
    expectTypeOf<Awaited<ReturnType<Endpoint>>>().toEqualTypeOf<{ host: string; port: number; token?: string }>();
  });
});
