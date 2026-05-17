import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, validatePasswordPolicy } from './password';

describe('hashPassword + verifyPassword', () => {
  it('hashes and verifies a valid password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('wrong-password-here', hash)).toBe(false);
  });

  it('produces different hashes for the same password (salted)', async () => {
    const h1 = await hashPassword('same-password-twice');
    const h2 = await hashPassword('same-password-twice');
    expect(h1).not.toBe(h2);
  });
});

describe('validatePasswordPolicy', () => {
  it('accepts a 12+ char password', () => {
    const result = validatePasswordPolicy('a-valid-password-123', 'alice', null);
    expect(result.valid).toBe(true);
  });

  it('rejects a password shorter than 12 chars', () => {
    const result = validatePasswordPolicy('short', 'alice', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('12');
  });

  it('rejects a password longer than 256 chars', () => {
    const result = validatePasswordPolicy('x'.repeat(257), 'alice', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('256');
  });

  it('rejects a password that matches the username', () => {
    const result = validatePasswordPolicy('alicealicealice', 'alicealicealice', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('username');
  });

  it('rejects a password that matches the email', () => {
    const result = validatePasswordPolicy('alice@example.com', 'alice', 'alice@example.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('email');
  });

  it('rejects a common password', () => {
    const result = validatePasswordPolicy('password1234', 'alice', null);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('common');
  });

  // IG-6: exact boundary tests
  it('rejects exactly 11 chars', () => {
    expect(validatePasswordPolicy('a'.repeat(11), 'user', null).valid).toBe(false);
  });

  it('accepts exactly 12 chars', () => {
    expect(validatePasswordPolicy('a'.repeat(12), 'user', null).valid).toBe(true);
  });

  it('accepts exactly 256 chars', () => {
    expect(validatePasswordPolicy('a'.repeat(256), 'user', null).valid).toBe(true);
  });

  // IG-7: email match is case-insensitive
  it('rejects password matching email case-insensitively', () => {
    const result = validatePasswordPolicy('ALICE@EXAMPLE.COM', 'alice', 'alice@example.com');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('email');
  });
});

describe('verifyPassword — malformed hash handling', () => {
  it('returns false for a garbage stored hash without throwing', async () => {
    expect(await verifyPassword('any-password', 'not-argon2-at-all')).toBe(false);
  });

  it('returns false when stored hash is an empty string', async () => {
    expect(await verifyPassword('any-password', '')).toBe(false);
  });
});
