import { describe, it, expect } from 'vitest';
import {
  generateToken, sha256Hex, verifyPkceS256,
  matchesRedirectUri, tokenPrefix,
} from '../oauth-crypto';

describe('oauth-crypto', () => {
  describe('generateToken', () => {
    it('produces the expected format', () => {
      const t = generateToken('oauth_at_');
      expect(t).toMatch(/^oauth_at_[0-9a-f]{40}$/);
    });
    it('is non-deterministic', () => {
      expect(generateToken('oauth_at_')).not.toBe(generateToken('oauth_at_'));
    });
  });

  describe('sha256Hex', () => {
    it('produces stable sha256 hex', () => {
      expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });
  });

  describe('verifyPkceS256', () => {
    it('returns true for a valid verifier/challenge pair', () => {
      expect(verifyPkceS256(
        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      )).toBe(true);
    });
    it('returns false on mismatch', () => {
      expect(verifyPkceS256('wrong', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(false);
    });
  });

  describe('matchesRedirectUri', () => {
    it('exact match passes', () => {
      expect(matchesRedirectUri(['http://127.0.0.1:1234/cb'], 'http://127.0.0.1:1234/cb')).toBe(true);
    });
    it('non-loopback mismatch fails', () => {
      expect(matchesRedirectUri(['https://example.com/cb'], 'https://example.com/other')).toBe(false);
    });
    it('loopback: any port is allowed if host+path match', () => {
      expect(matchesRedirectUri(['http://127.0.0.1:0/cb'], 'http://127.0.0.1:55555/cb')).toBe(true);
      expect(matchesRedirectUri(['http://localhost/cb'], 'http://localhost:12345/cb')).toBe(true);
    });
    it('loopback: path mismatch fails', () => {
      expect(matchesRedirectUri(['http://127.0.0.1/cb'], 'http://127.0.0.1:1234/other')).toBe(false);
    });
    it('rejects non-loopback http unless registered', () => {
      expect(matchesRedirectUri(['https://example.com/cb'], 'http://example.com/cb')).toBe(false);
    });
  });

  describe('tokenPrefix', () => {
    it('returns 12 chars after the oauth_at_ prefix', () => {
      expect(tokenPrefix('oauth_at_abcdef0123456789xxxxxxxxxxxxxxxxxxxxxxxx')).toBe('abcdef012345');
    });
    it('handles short prefixes like dcr_', () => {
      expect(tokenPrefix('dcr_abcdef0123456789xxxxxxxxxxxxxxxxxxxxxxxx')).toBe('abcdef012345');
    });
    it('handles oauth_rt_ prefix', () => {
      expect(tokenPrefix('oauth_rt_abcdef0123456789xxxxxxxxxxxxxxxxxxxxxxxx')).toBe('abcdef012345');
    });
    it('returns first 12 chars for unrecognized format (no underscore)', () => {
      expect(tokenPrefix('nomatch')).toBe('nomatch');
    });
  });
});
