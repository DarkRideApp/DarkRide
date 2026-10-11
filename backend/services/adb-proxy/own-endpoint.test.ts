import { describe, expect, it } from 'vitest';
import { advertisedHostFor, isOwnEndpoint, type EndpointContext } from './own-endpoint';

const ctx = (over: Partial<EndpointContext> = {}): EndpointContext => ({
  portStart: 6500, portEnd: 6599, bindHost: '0.0.0.0', advertisedHost: '192.168.1.10', localAddresses: ['10.8.0.2', 'fe80::1'], ...over,
});

describe('isOwnEndpoint', () => {
  it.each([
    '127.0.0.1:6500', '127.0.0.1:6599', '127.1.2.3:6550', 'localhost:6500', 'LOCALHOST:6501', '[::1]:6500',
    '[0:0:0:0:0:0:0:1]:6500', '[::ffff:127.0.0.1]:6500', '0.0.0.0:6500', '192.168.1.10:6500', '10.8.0.2:6500', '[fe80::1]:6500',
  ])('treats %s as one of the proxy\'s own endpoints while it listens on every address', (serial) => {
    expect(isOwnEndpoint(serial, ctx())).toBe(true);
  });

  it.each([
    ['a wireless debugging serial outside the range', '192.168.50.20:5555'],
    ['a loopback serial outside the range', '127.0.0.1:5555'],
    ['a serial just below the range', '127.0.0.1:6499'],
    ['a serial just above the range', '127.0.0.1:6600'],
    ['another host on a port in the range', '203.0.113.5:6500'],
    ['an emulator', 'emulator-5554'],
    ['a USB serial', 'R58M12ABCDE'],
    ['a malformed port', '127.0.0.1:65a0'],
  ])('proxies %s', (_name, serial) => {
    expect(isOwnEndpoint(serial, ctx())).toBe(false);
  });

  it('counts the bind address and not the other local addresses when the proxy is bound to one address', () => {
    const bound = ctx({ bindHost: '10.8.0.2', advertisedHost: '10.8.0.2', localAddresses: ['10.8.0.2', '192.168.1.10'] });
    expect(isOwnEndpoint('10.8.0.2:6500', bound)).toBe(true);
    expect(isOwnEndpoint('127.0.0.1:6500', bound)).toBe(true);
    expect(isOwnEndpoint('192.168.1.10:6500', bound)).toBe(false);
  });

  it('matches an advertised host name without regard to case', () => {
    expect(isOwnEndpoint('Lab-Box.local:6500', ctx({ advertisedHost: 'lab-box.local' }))).toBe(true);
  });
});

describe('advertisedHostFor', () => {
  it.each([['0.0.0.0'], ['::'], ['']])('uses the detected address when the proxy is bound to the wildcard %j', (bindHost) => {
    expect(advertisedHostFor(bindHost, () => '192.168.1.10')).toBe('192.168.1.10');
  });

  it.each([['10.8.0.2'], ['127.0.0.1'], ['fd00::5']])('uses the bind address %s when it is a specific address', (bindHost) => {
    expect(advertisedHostFor(bindHost, () => '192.168.1.10')).toBe(bindHost);
  });

  it('is empty when the proxy is bound to the wildcard and no address is detected', () => {
    expect(advertisedHostFor('0.0.0.0', undefined)).toBe('');
  });
});
