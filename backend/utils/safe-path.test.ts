import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'path';
import { assertPathInside, safeJoinInside } from './safe-path';

const BASE = resolve('/tmp/darkride-test-base');

describe('assertPathInside', () => {
  it('accepts a direct child', () => {
    expect(() => assertPathInside(BASE, join(BASE, 'foo.png'))).not.toThrow();
  });

  it('accepts a deep descendant', () => {
    expect(() => assertPathInside(BASE, join(BASE, 'a', 'b', 'c.png'))).not.toThrow();
  });

  it('accepts the base directory itself', () => {
    expect(() => assertPathInside(BASE, BASE)).not.toThrow();
  });

  it('rejects ../ escape', () => {
    expect(() => assertPathInside(BASE, join(BASE, '..', 'evil'))).toThrow(/outside/i);
  });

  it('rejects nested ../ escape', () => {
    expect(() => assertPathInside(BASE, join(BASE, 'a', '..', '..', 'evil'))).toThrow(/outside/i);
  });

  it('rejects absolute path that escapes via prefix-match shadowing', () => {
    // '/tmp/darkride-test-base-evil' starts with the base path as a STRING prefix
    // but is not actually inside the base directory. Naive startsWith() would
    // accept this; the implementation must use path separator boundaries.
    expect(() => assertPathInside(BASE, '/tmp/darkride-test-base-evil/x.png')).toThrow(/outside/i);
  });

  it('rejects an unrelated absolute path', () => {
    expect(() => assertPathInside(BASE, '/etc/passwd')).toThrow(/outside/i);
  });
});

describe('safeJoinInside', () => {
  it('joins safe path components', () => {
    const result = safeJoinInside(BASE, 'screenshots', 'a.png');
    expect(result).toBe(join(BASE, 'screenshots', 'a.png'));
  });

  it('rejects components that escape via ..', () => {
    expect(() => safeJoinInside(BASE, '..', 'evil.png')).toThrow(/outside/i);
  });

  it('rejects entries with embedded ..', () => {
    expect(() => safeJoinInside(BASE, 'a/../../etc/passwd')).toThrow(/outside/i);
  });

  it('rejects absolute component values', () => {
    // join() lets later absolute paths override earlier ones — we must block that.
    expect(() => safeJoinInside(BASE, '/etc/passwd')).toThrow(/outside/i);
  });
});
