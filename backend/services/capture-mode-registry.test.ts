import { describe, it, expect, vi } from 'vitest';
import { createCaptureModeRegistry, type CaptureModeContext } from './capture-mode-registry';

function ctx(over: Partial<CaptureModeContext> = {}): CaptureModeContext {
  return {
    deviceId: 'localhost:32770',
    sessionId: 1,
    platform: 'android',
    mode: 'wireguard',
    mitmOptions: {},
    setSubsystem: vi.fn(),
    ...over,
  } as CaptureModeContext;
}

describe('CaptureModeRegistry', () => {
  it('dispatches to the handler registered for the context mode and returns its result', async () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', async () => ({ tunnelActivated: true }));
    const result = await reg.dispatch(ctx({ mode: 'wireguard' }));
    expect(result).toEqual({ tunnelActivated: true });
  });
  it('throws when no handler is registered for the mode', async () => {
    const reg = createCaptureModeRegistry();
    await expect(reg.dispatch(ctx({ mode: 'nope' }))).rejects.toThrow(/no capture handler/i);
  });
  it('refuses duplicate registration of the same mode', () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', async () => ({ tunnelActivated: false }));
    expect(() => reg.register('wireguard', async () => ({ tunnelActivated: false }))).toThrow(/already registered/i);
  });
  it('has() reports whether a mode is registered', () => {
    const reg = createCaptureModeRegistry();
    reg.register('wireguard', async () => ({ tunnelActivated: false }));
    expect(reg.has('wireguard')).toBe(true);
    expect(reg.has('ios-bridge')).toBe(false);
  });
});
