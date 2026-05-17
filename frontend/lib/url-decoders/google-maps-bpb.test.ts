import { describe, it, expect } from 'vitest';
import Pbf from 'pbf';
import { isGoogleMapsBpbUrl, decodeGoogleMapsBpb } from './google-maps-bpb';

/** Encode bytes to URL-safe base64 (no padding) */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a minimal bpb protobuf buffer with tile coords */
function buildBpb(opts: {
  tiles?: Array<{ z: number; x: number; y: number }>;
  locale?: string;
  country?: string;
  styleId?: number;
  styleFlags?: Record<string, string>;
}): Uint8Array {
  const pbf = new Pbf();

  // Field 1 (repeated): tile requests
  for (const tile of opts.tiles || []) {
    // Build coords sub-message (field 1 of tile request)
    const coordsPbf = new Pbf();
    coordsPbf.writeVarintField(1, tile.z);
    coordsPbf.writeVarintField(2, tile.x);
    coordsPbf.writeVarintField(3, tile.y);
    const coordsBytes = coordsPbf.finish();

    // Build tile request message
    const tilePbf = new Pbf();
    tilePbf.writeBytesField(1, coordsBytes);
    const tileBytes = tilePbf.finish();

    pbf.writeBytesField(1, tileBytes);
  }

  // Field 3: locale/style message
  if (opts.locale || opts.country || opts.styleId !== undefined || opts.styleFlags) {
    const localePbf = new Pbf();
    if (opts.locale) localePbf.writeStringField(2, opts.locale);
    if (opts.country) localePbf.writeStringField(3, opts.country);
    if (opts.styleId !== undefined) localePbf.writeVarintField(5, opts.styleId);
    if (opts.styleFlags) {
      for (const [key, value] of Object.entries(opts.styleFlags)) {
        // field 12: style flag message containing field 2 (key-value pair)
        const kvPbf = new Pbf();
        kvPbf.writeStringField(1, key);
        kvPbf.writeStringField(2, value);
        const kvBytes = kvPbf.finish();

        const flagPbf = new Pbf();
        flagPbf.writeBytesField(2, kvBytes);
        const flagBytes = flagPbf.finish();

        localePbf.writeBytesField(12, flagBytes);
      }
    }
    const localeBytes = localePbf.finish();
    pbf.writeBytesField(3, localeBytes);
  }

  return pbf.finish();
}

function buildBpbUrl(bpbBytes: Uint8Array): string {
  return `https://www.google.com/maps/vt/proto?bpb=${base64UrlEncode(bpbBytes)}`;
}

describe('isGoogleMapsBpbUrl', () => {
  it('returns true for Google Maps bpb URLs', () => {
    expect(isGoogleMapsBpbUrl('https://www.google.com/maps/vt/proto?bpb=abc123')).toBe(true);
  });

  it('returns true for subdomain variations', () => {
    expect(isGoogleMapsBpbUrl('https://mt1.google.com/maps/vt?lyrs=m&bpb=abc')).toBe(true);
  });

  it('returns false for non-Google URLs', () => {
    expect(isGoogleMapsBpbUrl('https://example.com/maps/vt?bpb=abc')).toBe(false);
  });

  it('returns false for Google URLs without bpb', () => {
    expect(isGoogleMapsBpbUrl('https://www.google.com/maps/vt/proto?x=1&y=2')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isGoogleMapsBpbUrl('')).toBe(false);
  });
});

describe('decodeGoogleMapsBpb', () => {
  it('decodes a single tile request', () => {
    const bpb = buildBpb({ tiles: [{ z: 14, x: 8520, y: 5462 }] });
    const result = decodeGoogleMapsBpb(buildBpbUrl(bpb));

    expect(result).not.toBeNull();
    expect(result!.type).toBe('google-maps-bpb');
    expect(result!.tiles).toHaveLength(1);
    expect(result!.tiles[0]).toEqual({ z: 14, x: 8520, y: 5462 });
    expect(result!.label).toBe('Google Maps Tile z=14 x=8520 y=5462');
  });

  it('decodes multiple tile requests', () => {
    const bpb = buildBpb({
      tiles: [
        { z: 9, x: 259, y: 176 },
        { z: 9, x: 259, y: 175 },
      ],
    });
    const result = decodeGoogleMapsBpb(buildBpbUrl(bpb));

    expect(result).not.toBeNull();
    expect(result!.tiles).toHaveLength(2);
    expect(result!.tiles[0]).toEqual({ z: 9, x: 259, y: 176 });
    expect(result!.tiles[1]).toEqual({ z: 9, x: 259, y: 175 });
    expect(result!.label).toBe('Google Maps Tiles (2 tiles)');
  });

  it('decodes locale from field 3', () => {
    const bpb = buildBpb({
      tiles: [{ z: 1, x: 0, y: 0 }],
      locale: 'en-GB',
    });
    const result = decodeGoogleMapsBpb(buildBpbUrl(bpb));

    expect(result).not.toBeNull();
    expect(result!.locale).toBe('en-GB');
  });

  it('decodes country from field 3', () => {
    const bpb = buildBpb({
      tiles: [{ z: 1, x: 0, y: 0 }],
      country: 'GB',
    });
    const result = decodeGoogleMapsBpb(buildBpbUrl(bpb));

    expect(result).not.toBeNull();
    expect(result!.country).toBe('GB');
  });

  it('decodes style ID from field 3', () => {
    const bpb = buildBpb({
      tiles: [{ z: 1, x: 0, y: 0 }],
      styleId: 47,
    });
    const result = decodeGoogleMapsBpb(buildBpbUrl(bpb));

    expect(result).not.toBeNull();
    expect(result!.style).toBe('Style #47');
  });

  it('decodes style flags', () => {
    const bpb = buildBpb({
      tiles: [{ z: 1, x: 0, y: 0 }],
      styleFlags: { set: 'Roadmap', multizoom: 'false' },
    });
    const result = decodeGoogleMapsBpb(buildBpbUrl(bpb));

    expect(result).not.toBeNull();
    expect(result!.styleFlags).toEqual({ set: 'Roadmap', multizoom: 'false' });
  });

  it('decodes all fields together', () => {
    const bpb = buildBpb({
      tiles: [{ z: 9, x: 259, y: 176 }],
      locale: 'fr-FR',
      country: 'FR',
      styleId: 47,
      styleFlags: { smartmaps: '1' },
    });
    const result = decodeGoogleMapsBpb(buildBpbUrl(bpb));

    expect(result).not.toBeNull();
    expect(result!.tiles[0]).toEqual({ z: 9, x: 259, y: 176 });
    expect(result!.locale).toBe('fr-FR');
    expect(result!.country).toBe('FR');
    expect(result!.style).toBe('Style #47');
    expect(result!.styleFlags).toEqual({ smartmaps: '1' });
  });

  it('returns null for non-bpb URL', () => {
    expect(decodeGoogleMapsBpb('https://www.google.com/maps/vt/proto?x=1')).toBeNull();
  });

  it('returns null for invalid base64', () => {
    expect(decodeGoogleMapsBpb('https://www.google.com/maps/vt/proto?bpb=!!invalid!!')).toBeNull();
  });

  it('returns null when no tiles are found', () => {
    // Empty protobuf with only locale
    const localePbf = new Pbf();
    localePbf.writeStringField(2, 'en-US');
    const localeBytes = localePbf.finish();
    const pbf = new Pbf();
    pbf.writeBytesField(3, localeBytes);
    const bpb = pbf.finish();

    expect(decodeGoogleMapsBpb(buildBpbUrl(bpb))).toBeNull();
  });

  it('handles the real DLP bpb URL', () => {
    const url = 'https://www.google.com/maps/vt/proto?bpb=Cg0KCAgJEIMCGLABygEACg0KCAgJEIMCGK8BygEAEgYIABi_hD0aWRIFZW4tR0IaAkdCYgIIL2ISCEQSDgoDc2V0EgdSb2FkbWFwYgIIFGIWCCMSEgoJbXVsdGl6b29tEgVmYWxzZWISCCUSDgoJc21hcnRtYXBzEgExKMQCoAEBIAEqBS0AAIA_MiwIDBACMAA4AeABBoACAbgCAcgCAdgCAegCAZADAbADAcgDAeADAdAEAbgFAboBNc7FU9HFU7KsVLrdqALsjrQW64i4Fu7fuRa_xMYi6pDzIsLY8yLZk_gs25P4LL30-Cy0lvksogEGGAEwAXgB';

    const result = decodeGoogleMapsBpb(url);
    expect(result).not.toBeNull();
    expect(result!.tiles).toHaveLength(2);
    expect(result!.tiles[0]).toEqual({ z: 9, x: 259, y: 176 });
    expect(result!.tiles[1]).toEqual({ z: 9, x: 259, y: 175 });
    expect(result!.locale).toBe('en-GB');
    expect(result!.country).toBe('GB');
  });

  it('handles URL-safe base64 with padding variations', () => {
    const bpb = buildBpb({ tiles: [{ z: 5, x: 16, y: 11 }] });
    // URL-safe base64 without padding
    const encoded = base64UrlEncode(bpb);
    const result = decodeGoogleMapsBpb(`https://www.google.com/maps/vt/proto?bpb=${encoded}`);
    expect(result).not.toBeNull();
    expect(result!.tiles[0]).toEqual({ z: 5, x: 16, y: 11 });
  });

  it('sets null for missing optional fields', () => {
    const bpb = buildBpb({ tiles: [{ z: 1, x: 0, y: 0 }] });
    const result = decodeGoogleMapsBpb(buildBpbUrl(bpb));

    expect(result).not.toBeNull();
    expect(result!.locale).toBeNull();
    expect(result!.country).toBeNull();
    expect(result!.style).toBeNull();
    expect(result!.scaleFactor).toBeNull();
    expect(result!.styleFlags).toEqual({});
  });
});
