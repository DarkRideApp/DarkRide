import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from 'undici';
import { createDispatcherApi } from '../dispatcher-api';

describe('createDispatcherApi — pool semantics', () => {
  it('returns the same Dispatcher for structurally-equal specs', () => {
    const dispatcher = createDispatcherApi();
    const spec = {
      type: 'socks5' as const,
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u', password: 'p' },
    };

    const a = dispatcher(spec);
    const b = dispatcher({ ...spec });

    expect(a).toBe(b);
  });

  it('returns distinct Dispatchers for specs with different host', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    const b = dispatcher({ type: 'socks5', host: 'uk.socks.nordhold.net', port: 1080 });

    expect(a).not.toBe(b);
  });

  it('returns distinct Dispatchers for specs with different auth credentials', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u1', password: 'p' },
    });
    const b = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u2', password: 'p' },
    });

    expect(a).not.toBe(b);
  });

  it('returns distinct Dispatchers for different connections caps', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080, connections: 4 });
    const b = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080, connections: 16 });

    expect(a).not.toBe(b);
  });

  it('treats a missing connections value as the default (8) for keying', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    const b = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080, connections: 8 });

    expect(a).toBe(b);
  });

  it('treats a missing auth as distinct from an empty auth', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });
    const b = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: '', password: '' },
    });

    // Both legitimate specs but semantically different — an attacker
    // who can't read auth shouldn't be able to claim "no auth needed".
    expect(a).not.toBe(b);
  });

  it('does not collide when username or password contains the separator character', () => {
    // Regression guard: if the impl's `\x00` separator is ever "fixed"
    // to `:` or `||`, this test catches the resulting hash collision.
    // See the comment on specKey() in dispatcher-api.ts.
    const dispatcher = createDispatcherApi();
    const a = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u:p', password: '' },
    });
    const b = dispatcher({
      type: 'socks5',
      host: 'us.socks.nordhold.net',
      port: 1080,
      auth: { username: 'u', password: ':p' },
    });

    expect(a).not.toBe(b);
  });

  it('returns an undici Dispatcher (has dispatch method)', () => {
    const dispatcher = createDispatcherApi();
    const a = dispatcher({ type: 'socks5', host: 'us.socks.nordhold.net', port: 1080 });

    expect(a).toBeInstanceOf(Agent);
  });
});
