import Pbf from 'pbf';

export interface BpbTileRequest {
  z: number;
  x: number;
  y: number;
}

export interface BpbDecodedInfo {
  type: 'google-maps-bpb';
  label: string;
  tiles: BpbTileRequest[];
  locale: string | null;
  country: string | null;
  style: string | null;
  styleFlags: Record<string, string>;
  scaleFactor: number | null;
}

/** Decode URL-safe base64 to Uint8Array */
function base64UrlDecode(str: string): Uint8Array {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Check if a URL is a Google Maps bpb protobuf tile URL */
export function isGoogleMapsBpbUrl(url: string): boolean {
  return url.includes('google.com/maps/vt') && url.includes('bpb=');
}

/** Decode a Google Maps bpb URL into structured tile information */
export function decodeGoogleMapsBpb(url: string): BpbDecodedInfo | null {
  try {
    const parsed = new URL(url);
    const bpb = parsed.searchParams.get('bpb');
    if (!bpb) return null;

    const buf = base64UrlDecode(bpb);
    const tiles: BpbTileRequest[] = [];
    let locale: string | null = null;
    let country: string | null = null;
    let style: string | null = null;
    let scaleFactor: number | null = null;
    const styleFlags: Record<string, string> = {};

    // Parse top-level fields
    const pbf = new Pbf(buf);
    while (pbf.pos < buf.length) {
      const tag = pbf.readVarint();
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;

      if (wireType === 2) {
        const bytes = pbf.readBytes();

        if (fieldNum === 1) {
          // Tile request message
          const tile = parseTileRequest(bytes);
          if (tile) tiles.push(tile);
        } else if (fieldNum === 3) {
          // Locale/style message
          const info = parseLocaleStyle(bytes);
          if (info.locale) locale = info.locale;
          if (info.country) country = info.country;
          if (info.style) style = info.style;
          Object.assign(styleFlags, info.flags);
        }
      } else if (wireType === 5) {
        // 32-bit float
        if (fieldNum === 5 || pbf.pos + 4 <= buf.length) {
          // Read float from current position
          const fbuf = new DataView(buf.buffer, buf.byteOffset + pbf.pos - 4, 4);
          // Actually we already consumed the tag, need to read the float
        }
        // Skip 4 bytes — the Pbf library doesn't auto-skip for raw reading
        // Actually pbf.readVarint already consumed the tag, we need to skip the value
        const view = new DataView(new ArrayBuffer(4));
        for (let i = 0; i < 4 && pbf.pos + i < buf.length; i++) {
          view.setUint8(i, buf[pbf.pos + i]);
        }
        const fval = view.getFloat32(0, true);
        if (fieldNum === 5 && fval > 0 && fval <= 4) {
          scaleFactor = fval;
        }
        pbf.pos += 4;
      } else if (wireType === 0) {
        pbf.readVarint();
      } else if (wireType === 1) {
        pbf.pos += 8;
      } else {
        break;
      }
    }

    if (tiles.length === 0) return null;

    const label = tiles.length === 1
      ? `Google Maps Tile z=${tiles[0].z} x=${tiles[0].x} y=${tiles[0].y}`
      : `Google Maps Tiles (${tiles.length} tiles)`;

    return { type: 'google-maps-bpb', label, tiles, locale, country, style, styleFlags, scaleFactor };
  } catch {
    return null;
  }
}

/** Parse a tile request message (field 1 of bpb root) */
function parseTileRequest(bytes: Uint8Array): BpbTileRequest | null {
  const pbf = new Pbf(bytes);
  let z = -1, x = -1, y = -1;

  while (pbf.pos < bytes.length) {
    const tag = pbf.readVarint();
    const fn = tag >> 3;
    const wt = tag & 0x7;

    if (wt === 2) {
      const inner = pbf.readBytes();
      if (fn === 1) {
        // Coordinates message: field 1=z, 2=x, 3=y
        const coordPbf = new Pbf(inner);
        while (coordPbf.pos < inner.length) {
          const ct = coordPbf.readVarint();
          const cfn = ct >> 3;
          const cwt = ct & 0x7;
          if (cwt === 0) {
            const val = coordPbf.readVarint();
            if (cfn === 1) z = val;
            else if (cfn === 2) x = val;
            else if (cfn === 3) y = val;
          } else if (cwt === 2) {
            coordPbf.readBytes();
          } else if (cwt === 5) {
            coordPbf.pos += 4;
          } else if (cwt === 1) {
            coordPbf.pos += 8;
          } else break;
        }
      }
    } else if (wt === 0) {
      pbf.readVarint();
    } else if (wt === 5) {
      pbf.pos += 4;
    } else if (wt === 1) {
      pbf.pos += 8;
    } else break;
  }

  if (z >= 0 && x >= 0 && y >= 0) return { z, x, y };
  return null;
}

/** Parse locale/style message (field 3 of bpb root) */
function parseLocaleStyle(bytes: Uint8Array): {
  locale: string | null;
  country: string | null;
  style: string | null;
  flags: Record<string, string>;
} {
  const pbf = new Pbf(bytes);
  let locale: string | null = null;
  let country: string | null = null;
  let style: string | null = null;
  const flags: Record<string, string> = {};

  while (pbf.pos < bytes.length) {
    const tag = pbf.readVarint();
    const fn = tag >> 3;
    const wt = tag & 0x7;

    if (wt === 2) {
      const inner = pbf.readBytes();
      if (fn === 2) {
        // Locale string (e.g. "en-GB")
        const str = new TextDecoder().decode(inner);
        if (/^[a-z]{2}(-[A-Z]{2})?$/i.test(str)) locale = str;
      } else if (fn === 3) {
        // Country code (e.g. "GB")
        const str = new TextDecoder().decode(inner);
        if (/^[A-Z]{2}$/i.test(str)) country = str;
      } else if (fn === 12) {
        // Style/feature flag message
        parseStyleFlag(inner, flags);
      }
    } else if (wt === 0) {
      const val = pbf.readVarint();
      if (fn === 5) {
        // Style ID
        style = `Style #${val}`;
      }
    } else if (wt === 5) {
      pbf.pos += 4;
    } else if (wt === 1) {
      pbf.pos += 8;
    } else break;
  }

  return { locale, country, style, flags };
}

/** Parse a style flag sub-message (field 12 of locale/style message) */
function parseStyleFlag(bytes: Uint8Array, flags: Record<string, string>): void {
  const pbf = new Pbf(bytes);
  let key: string | null = null;
  let value: string | null = null;

  while (pbf.pos < bytes.length) {
    const tag = pbf.readVarint();
    const fn = tag >> 3;
    const wt = tag & 0x7;

    if (wt === 2) {
      const inner = pbf.readBytes();
      if (fn === 2) {
        // Nested key-value pair
        const kvPbf = new Pbf(inner);
        while (kvPbf.pos < inner.length) {
          const kvTag = kvPbf.readVarint();
          const kvFn = kvTag >> 3;
          const kvWt = kvTag & 0x7;
          if (kvWt === 2) {
            const str = new TextDecoder().decode(kvPbf.readBytes());
            if (kvFn === 1) key = str;
            else if (kvFn === 2) value = str;
          } else if (kvWt === 0) {
            kvPbf.readVarint();
          } else break;
        }
        if (key && value) flags[key] = value;
      }
    } else if (wt === 0) {
      pbf.readVarint();
    } else if (wt === 5) {
      pbf.pos += 4;
    } else if (wt === 1) {
      pbf.pos += 8;
    } else break;
  }
}
