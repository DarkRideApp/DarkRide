/**
 * Type-level checks for the plugin lifecycle + peer service registry
 * generics. These assertions verify the COMPILE-TIME contract of `peer<T>()`,
 * `exposeService<T>()`, `hasPeer()`, and the `register`/`start`/`stop`
 * lifecycle method signatures.
 *
 * Implementation pattern: each runtime-failing call (e.g. `ctx.peer(...)`)
 * is wrapped in a helper function that is DEFINED but never INVOKED. The
 * helper's signature gives TypeScript everything it needs to extract the
 * return type at type-check time; the body never executes at runtime.
 *
 * `expectTypeOf<T>()` is the no-runtime variant — pass the type as a generic,
 * not as a runtime value.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { PluginContext, PluginDefinition, PluginInput } from '../types/plugin';

interface DemoApi {
  greet(name: string): string;
  count: number;
}

describe('PluginContext peer/exposeService/hasPeer types', () => {
  it('peer<T>(name) returns T', () => {
    const _peerReturn = (ctx: PluginContext) => ctx.peer<DemoApi>('demo');
    expectTypeOf<ReturnType<typeof _peerReturn>>().toEqualTypeOf<DemoApi>();
  });

  it('peer<T>(name) takes a string name', () => {
    expectTypeOf<PluginContext['peer']>().parameter(0).toEqualTypeOf<string>();
  });

  it('exposeService<T>(impl) takes an impl assignable to T', () => {
    const _exposeImpl = (ctx: PluginContext, impl: DemoApi) =>
      ctx.exposeService<DemoApi>(impl);
    expectTypeOf<Parameters<typeof _exposeImpl>[1]>().toEqualTypeOf<DemoApi>();
  });

  it('hasPeer(name) returns boolean', () => {
    const _hasPeerReturn = (ctx: PluginContext) => ctx.hasPeer('demo');
    expectTypeOf<ReturnType<typeof _hasPeerReturn>>().toEqualTypeOf<boolean>();
    expectTypeOf<PluginContext['hasPeer']>().parameter(0).toEqualTypeOf<string>();
  });
});

describe('PluginDefinition lifecycle field types', () => {
  it('start is optional async (ctx) => Promise<void>', () => {
    expectTypeOf<PluginDefinition['start']>()
      .toEqualTypeOf<((ctx: PluginContext) => Promise<void>) | undefined>();
  });

  it('stop is optional async (ctx) => Promise<void>', () => {
    expectTypeOf<PluginDefinition['stop']>()
      .toEqualTypeOf<((ctx: PluginContext) => Promise<void>) | undefined>();
  });

  it('startTimeoutMs is optional number', () => {
    expectTypeOf<PluginDefinition['startTimeoutMs']>().toEqualTypeOf<number | undefined>();
  });

  it('register is sync (ctx) => void — required', () => {
    expectTypeOf<PluginDefinition['register']>()
      .toEqualTypeOf<(ctx: PluginContext) => void>();
  });
});

describe('PluginInput mirrors PluginDefinition lifecycle fields', () => {
  it('PluginInput.start is optional', () => {
    expectTypeOf<PluginInput['start']>()
      .toEqualTypeOf<((ctx: PluginContext) => Promise<void>) | undefined>();
  });

  it('PluginInput.stop is optional', () => {
    expectTypeOf<PluginInput['stop']>()
      .toEqualTypeOf<((ctx: PluginContext) => Promise<void>) | undefined>();
  });

  it('PluginInput.startTimeoutMs is optional', () => {
    expectTypeOf<PluginInput['startTimeoutMs']>().toEqualTypeOf<number | undefined>();
  });
});
