import net from 'node:net';
import { foldMappedV4 } from './peer-key';

export interface EndpointContext {
  portStart: number;
  portEnd: number;
  bindHost: string;
  /** The host the connect command names: an address or a host name. */
  advertisedHost: string;
  /** This machine's interface addresses; they reach the proxy only while it listens on every address. */
  localAddresses: string[];
}

const WILDCARDS = new Set(['', '0.0.0.0', '::']);

export const isWildcard = (host: string) => WILDCARDS.has(host);

/** The host a remote machine should connect to: the bind address when it is a specific one, else the detected one. */
export function advertisedHostFor(bindHost: string, detected: (() => string) | undefined): string {
  if (!isWildcard(bindHost)) return bindHost;
  return detected?.() ?? '';
}

function splitSerial(serial: string): { host: string; port: number } | null {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(serial) ?? /^([^:[\]]+):(\d{1,5})$/.exec(serial);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

/**
 * Whether an ADB serial of the form host:port names one of the proxy's own listeners, as it does after
 * `adb connect` to the proxy from this machine. Such a device must not be proxied again.
 */
export function isOwnEndpoint(serial: string, ctx: EndpointContext): boolean {
  const parts = splitSerial(serial);
  if (!parts || parts.port < ctx.portStart || parts.port > ctx.portEnd) return false;
  const host = parts.host.toLowerCase();
  if (host === 'localhost' || host === ctx.advertisedHost.toLowerCase()) return true;
  const address = foldMappedV4(host);
  const family = net.isIP(address);
  if (family === 0) return false;
  const own = new net.BlockList();
  own.addSubnet('127.0.0.0', 8, 'ipv4');
  own.addAddress('0.0.0.0', 'ipv4');
  own.addAddress('::1', 'ipv6');
  const addresses = [ctx.bindHost, ctx.advertisedHost, ...(isWildcard(ctx.bindHost) ? ctx.localAddresses : [])];
  for (const a of addresses.map((x) => foldMappedV4(x.split('%')[0]))) {
    const f = net.isIP(a);
    if (f !== 0 && !isWildcard(a)) own.addAddress(a, f === 4 ? 'ipv4' : 'ipv6');
  }
  return own.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
