import net from 'node:net';

const withoutZone = (addr: string) => {
  const at = addr.indexOf('%');
  return at === -1 ? addr : addr.slice(0, at);
};

/** The eight 16-bit groups of a valid IPv6 address without a zone id, or null. */
function groupsOf(addr: string): number[] | null {
  if (!net.isIPv6(addr)) return null;
  let text = addr.toLowerCase();
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = text.includes('::') ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every(Number.isInteger) ? groups : null;
}

/** The address with an IPv4-mapped IPv6 form folded to dotted IPv4 and any zone id removed. */
export function foldMappedV4(addr: string | undefined): string {
  if (addr === undefined) return 'unknown';
  const bare = withoutZone(addr);
  const groups = groupsOf(bare);
  if (!groups) return addr;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return bare;
}

/** The bucket a peer is limited under: an IPv4 address itself, an IPv6 address as its /64, since a host can pick any address inside its /64. */
export function peerKey(addr: string | undefined): string {
  const folded = foldMappedV4(addr);
  const groups = groupsOf(folded);
  return groups ? `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64` : folded;
}
