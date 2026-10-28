import { describe, expect, it } from 'vitest';
import { foldMappedV4, peerKey } from './peer-key';

describe('foldMappedV4', () => {
  it('returns unknown for a missing address', () => {
    expect(foldMappedV4(undefined)).toBe('unknown');
  });

  it('leaves plain IPv4 and IPv6 addresses alone', () => {
    expect(foldMappedV4('192.168.1.10')).toBe('192.168.1.10');
    expect(foldMappedV4('2001:db8::1')).toBe('2001:db8::1');
    expect(foldMappedV4('::1')).toBe('::1');
  });

  it('folds the dotted mapped form to IPv4', () => {
    expect(foldMappedV4('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(foldMappedV4('::FFFF:10.0.0.5')).toBe('10.0.0.5');
    expect(foldMappedV4('0:0:0:0:0:ffff:1.2.3.4')).toBe('1.2.3.4');
  });

  it('folds the hex mapped form to IPv4, with or without leading zeros', () => {
    expect(foldMappedV4('::ffff:0102:0304')).toBe('1.2.3.4');
    expect(foldMappedV4('::ffff:102:304')).toBe('1.2.3.4');
    expect(foldMappedV4('0:0:0:0:0:ffff:c0a8:010a')).toBe('192.168.1.10');
  });

  it('does not fold addresses that only look similar', () => {
    expect(foldMappedV4('::fffe:1.2.3.4')).toBe('::fffe:1.2.3.4');
    expect(foldMappedV4('1::ffff:1.2.3.4')).toBe('1::ffff:1.2.3.4');
    expect(foldMappedV4('64:ff9b::1.2.3.4')).toBe('64:ff9b::1.2.3.4');
  });

  it('strips an IPv6 zone id', () => {
    expect(foldMappedV4('fe80::1%eth0')).toBe('fe80::1');
    expect(foldMappedV4('::ffff:1.2.3.4%lo')).toBe('1.2.3.4');
  });

  it('returns unparseable input unchanged', () => {
    expect(foldMappedV4('garbage%x')).toBe('garbage%x');
    expect(foldMappedV4('')).toBe('');
  });
});

describe('peerKey', () => {
  it('keeps an IPv4 address as is', () => {
    expect(peerKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('collapses an IPv6 address to its /64', () => {
    expect(peerKey('2001:db8:0:1::5')).toBe('2001:db8:0:1::/64');
    expect(peerKey('2001:0db8:0000:0001:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:0:1::/64');
  });

  it('treats compressed and uncompressed forms of one address alike', () => {
    expect(peerKey('2001:db8::1')).toBe(peerKey('2001:0db8:0000:0000:0000:0000:0000:0001'));
    expect(peerKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });

  it('lower-cases', () => {
    expect(peerKey('2001:DB8:ABCD:EF01::1')).toBe('2001:db8:abcd:ef01::/64');
  });

  it('ignores a zone id', () => {
    expect(peerKey('fe80::1%eth0')).toBe(peerKey('fe80::1'));
    expect(peerKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('handles the loopback address', () => {
    expect(peerKey('::1')).toBe('0:0:0:0::/64');
    expect(peerKey('::')).toBe('0:0:0:0::/64');
  });

  it('gives two addresses in one /64 one key and another /64 another key', () => {
    expect(peerKey('2001:db8:0:1::1')).toBe(peerKey('2001:db8:0:1:ffff:ffff:ffff:ffff'));
    expect(peerKey('2001:db8:0:1::1')).not.toBe(peerKey('2001:db8:0:2::1'));
  });

  it('handles an IPv6 address with an embedded IPv4 tail', () => {
    expect(peerKey('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64');
  });

  it('gives a mapped IPv4 address the key of the plain address', () => {
    expect(peerKey('::ffff:1.2.3.4')).toBe(peerKey('1.2.3.4'));
    expect(peerKey('::ffff:0102:0304')).toBe('1.2.3.4');
  });

  it('returns garbage unchanged and never throws', () => {
    expect(peerKey('not-an-ip')).toBe('not-an-ip');
    expect(peerKey('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
    expect(peerKey('1::2::3')).toBe('1::2::3');
    expect(peerKey('')).toBe('');
    expect(peerKey(undefined)).toBe('unknown');
    expect(() => peerKey('::ffff:999.1.1.1')).not.toThrow();
  });
});
