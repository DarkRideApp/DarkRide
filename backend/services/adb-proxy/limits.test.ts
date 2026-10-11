import { describe, expect, it } from 'vitest';
import { PreAuthLimiter } from './limits';

describe('PreAuthLimiter', () => {
  it('allows 8 sockets per IP by default and refuses the ninth', () => {
    const l = new PreAuthLimiter();
    for (let i = 0; i < 8; i++) expect(l.acquire('10.0.0.1')).not.toBeNull();
    expect(l.acquire('10.0.0.1')).toBeNull();
  });

  it('counts IPs independently', () => {
    const l = new PreAuthLimiter(1, 10);
    expect(l.acquire('a')).not.toBeNull();
    expect(l.acquire('b')).not.toBeNull();
    expect(l.acquire('a')).toBeNull();
  });

  it('enforces the total cap across IPs', () => {
    const l = new PreAuthLimiter(10, 3);
    expect(l.acquire('a')).not.toBeNull();
    expect(l.acquire('b')).not.toBeNull();
    expect(l.acquire('c')).not.toBeNull();
    expect(l.acquire('d')).toBeNull();
  });

  it('gives the slot back on release so the same IP can connect again', () => {
    const l = new PreAuthLimiter(1, 10);
    const release = l.acquire('a')!;
    expect(l.acquire('a')).toBeNull();
    release();
    expect(l.active).toBe(0);
    expect(l.acquire('a')).not.toBeNull();
  });

  it('treats a second release of the same slot as a no-op', () => {
    const l = new PreAuthLimiter(2, 10);
    const first = l.acquire('a')!;
    l.acquire('a');
    first();
    first();
    expect(l.active).toBe(1);
    expect(l.acquire('a')).not.toBeNull();
    expect(l.acquire('a')).toBeNull();
  });
});
