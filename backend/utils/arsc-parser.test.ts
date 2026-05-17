import { describe, it, expect } from 'vitest';
import { isArscBuffer, parseArsc, type ArscResource } from './arsc-parser';

// ---------------------------------------------------------------------------
// Helpers for building minimal ARSC buffers
// ---------------------------------------------------------------------------

function writeU8(buf: Buffer, off: number, val: number): void {
  buf[off] = val & 0xFF;
}
function writeU16(buf: Buffer, off: number, val: number): void {
  buf.writeUInt16LE(val, off);
}
function writeU32(buf: Buffer, off: number, val: number): void {
  buf.writeUInt32LE(val, off);
}

/** Build a UTF-8 string pool chunk */
function buildStringPool(strings: string[]): Buffer {
  const stringBufs: Buffer[] = [];
  for (const s of strings) {
    const utf8 = Buffer.from(s, 'utf8');
    const entry = Buffer.alloc(1 + 1 + utf8.length + 1);
    entry[0] = s.length;
    entry[1] = utf8.length;
    utf8.copy(entry, 2);
    entry[2 + utf8.length] = 0;
    stringBufs.push(entry);
  }

  const headerSize = 28;
  const offsetArraySize = strings.length * 4;
  const dataSize = stringBufs.reduce((sum, b) => sum + b.length, 0);
  const stringsStart = headerSize + offsetArraySize;
  const chunkSize = stringsStart + dataSize;

  const buf = Buffer.alloc(chunkSize);
  writeU16(buf, 0, 0x0001);
  writeU16(buf, 2, headerSize);
  writeU32(buf, 4, chunkSize);
  writeU32(buf, 8, strings.length);
  writeU32(buf, 12, 0);
  writeU32(buf, 16, 1 << 8); // UTF-8
  writeU32(buf, 20, stringsStart);
  writeU32(buf, 24, 0);

  let dataOff = 0;
  for (let i = 0; i < strings.length; i++) {
    writeU32(buf, headerSize + i * 4, dataOff);
    dataOff += stringBufs[i].length;
  }

  let pos = stringsStart;
  for (const sb of stringBufs) {
    sb.copy(buf, pos);
    pos += sb.length;
  }

  return buf;
}

/**
 * Build a minimal resources.arsc with one package containing one type with one simple entry.
 */
function buildMinimalArsc(opts: {
  globalStrings: string[];    // global string pool (value strings)
  typeStrings: string[];      // type names (e.g. ["string"])
  keyStrings: string[];       // key names (e.g. ["app_name"])
  entries: Array<{
    valueType: number;
    valueData: number;
  }>;
  config?: { lang?: string; density?: number; sdk?: number };
}): Buffer {
  const globalPool = buildStringPool(opts.globalStrings);
  const typePool = buildStringPool(opts.typeStrings);
  const keyPool = buildStringPool(opts.keyStrings);

  // Build Type chunk (0x0201)
  const entryCount = opts.entries.length;
  const typeHeaderSize = 76; // 8 (chunk hdr) + 1 (typeId) + 1 (res0) + 2 (res1) + 4 (entryCount) + 4 (entriesStart) + 56 (config, min 56 bytes)
  const offsetArraySize = entryCount * 4;
  const entriesDataSize = entryCount * 16; // each: 2(size)+2(flags)+4(key)+8(Res_value)
  const entriesStart = typeHeaderSize + offsetArraySize;
  const typeChunkSize = entriesStart + entriesDataSize;
  const typeBuf = Buffer.alloc(typeChunkSize);
  writeU16(typeBuf, 0, 0x0201);
  writeU16(typeBuf, 2, typeHeaderSize);
  writeU32(typeBuf, 4, typeChunkSize);
  writeU8(typeBuf, 8, 1); // typeId = 1 (1-based)
  writeU8(typeBuf, 9, 0); // res0
  writeU16(typeBuf, 10, 0); // res1
  writeU32(typeBuf, 12, entryCount);
  writeU32(typeBuf, 16, entriesStart);

  // Config at offset 20: configSize=56
  writeU32(typeBuf, 20, 56);
  if (opts.config?.lang) {
    writeU8(typeBuf, 28, opts.config.lang.charCodeAt(0));
    writeU8(typeBuf, 29, opts.config.lang.charCodeAt(1));
  }
  if (opts.config?.density) {
    writeU16(typeBuf, 34, opts.config.density);
  }
  if (opts.config?.sdk) {
    writeU16(typeBuf, 40, opts.config.sdk);
  }

  // Offset array
  for (let i = 0; i < entryCount; i++) {
    writeU32(typeBuf, typeHeaderSize + i * 4, i * 16);
  }

  // Entry data
  for (let i = 0; i < entryCount; i++) {
    const eOff = entriesStart + i * 16;
    writeU16(typeBuf, eOff, 8); // entry size
    writeU16(typeBuf, eOff + 2, 0); // flags: simple
    writeU32(typeBuf, eOff + 4, i); // key index
    // Res_value
    writeU16(typeBuf, eOff + 8, 8); // size
    writeU8(typeBuf, eOff + 10, 0); // res0
    writeU8(typeBuf, eOff + 11, opts.entries[i].valueType);
    writeU32(typeBuf, eOff + 12, opts.entries[i].valueData);
  }

  // Build package chunk (0x0200)
  const pkgHeaderSize = 288;
  const typePoolOff = pkgHeaderSize; // relative to package start
  const keyPoolOff = typePoolOff + typePool.length;
  const pkgContentSize = typePool.length + keyPool.length + typeBuf.length;
  const pkgChunkSize = pkgHeaderSize + pkgContentSize;
  const pkgBuf = Buffer.alloc(pkgChunkSize);
  writeU16(pkgBuf, 0, 0x0200);
  writeU16(pkgBuf, 2, pkgHeaderSize);
  writeU32(pkgBuf, 4, pkgChunkSize);
  writeU32(pkgBuf, 8, 0x7F); // packageId
  // Package name (UTF-16 at offset 12, 128 uint16s = 256 bytes) - leave empty
  writeU32(pkgBuf, 268, typePoolOff);
  writeU32(pkgBuf, 272, 0); // lastPublicType
  writeU32(pkgBuf, 276, keyPoolOff);
  writeU32(pkgBuf, 280, 0); // lastPublicKey

  typePool.copy(pkgBuf, pkgHeaderSize);
  keyPool.copy(pkgBuf, pkgHeaderSize + typePool.length);
  typeBuf.copy(pkgBuf, pkgHeaderSize + typePool.length + keyPool.length);

  // Assemble: file header + global pool + package
  const fileHeaderSize = 12;
  const totalSize = fileHeaderSize + globalPool.length + pkgBuf.length;
  const result = Buffer.alloc(totalSize);
  writeU16(result, 0, 0x0002); // RES_TABLE_TYPE
  writeU16(result, 2, fileHeaderSize);
  writeU32(result, 4, totalSize);
  writeU32(result, 8, 1); // packageCount

  globalPool.copy(result, fileHeaderSize);
  pkgBuf.copy(result, fileHeaderSize + globalPool.length);

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isArscBuffer', () => {
  it('returns true for buffers starting with 0x0002', () => {
    const buf = Buffer.alloc(12);
    writeU16(buf, 0, 0x0002);
    expect(isArscBuffer(buf)).toBe(true);
  });

  it('returns false for non-ARSC buffers', () => {
    expect(isArscBuffer(Buffer.from([0x03, 0x00, 0x08, 0x00]))).toBe(false);
    expect(isArscBuffer(Buffer.from([0x50, 0x4B, 0x03, 0x04]))).toBe(false);
    expect(isArscBuffer(Buffer.from('hello'))).toBe(false);
  });

  it('returns false for too-short buffers', () => {
    expect(isArscBuffer(Buffer.alloc(0))).toBe(false);
    expect(isArscBuffer(Buffer.alloc(1))).toBe(false);
  });

  it('returns false for null/undefined-like input', () => {
    expect(isArscBuffer(null as any)).toBe(false);
    expect(isArscBuffer(undefined as any)).toBe(false);
  });
});

describe('parseArsc', () => {
  it('parses a minimal ARSC with a single string resource', () => {
    const buf = buildMinimalArsc({
      globalStrings: ['My App'],
      typeStrings: ['string'],
      keyStrings: ['app_name'],
      entries: [{ valueType: 0x03, valueData: 0 }], // TYPE_STRING, index 0
    });

    const resources = parseArsc(buf);
    expect(resources.length).toBe(1);
    expect(resources[0].type).toBe('string');
    expect(resources[0].name).toBe('app_name');
    expect(resources[0].value).toBe('My App');
    expect(resources[0].resourceId).toBe('0x7f010000');
    expect(resources[0].config).toBe('default');
  });

  it('parses multiple entries of the same type', () => {
    const buf = buildMinimalArsc({
      globalStrings: ['My App', 'Settings', 'About'],
      typeStrings: ['string'],
      keyStrings: ['app_name', 'settings', 'about'],
      entries: [
        { valueType: 0x03, valueData: 0 },
        { valueType: 0x03, valueData: 1 },
        { valueType: 0x03, valueData: 2 },
      ],
    });

    const resources = parseArsc(buf);
    expect(resources.length).toBe(3);
    expect(resources[0].name).toBe('app_name');
    expect(resources[0].value).toBe('My App');
    expect(resources[1].name).toBe('settings');
    expect(resources[1].value).toBe('Settings');
    expect(resources[2].name).toBe('about');
    expect(resources[2].value).toBe('About');
  });

  it('formats TYPE_INT_DEC values', () => {
    const buf = buildMinimalArsc({
      globalStrings: [],
      typeStrings: ['integer'],
      keyStrings: ['max_count'],
      entries: [{ valueType: 0x10, valueData: 100 }],
    });

    const resources = parseArsc(buf);
    expect(resources[0].value).toBe('100');
  });

  it('formats TYPE_INT_BOOLEAN values', () => {
    const buf = buildMinimalArsc({
      globalStrings: [],
      typeStrings: ['bool'],
      keyStrings: ['is_tablet'],
      entries: [{ valueType: 0x12, valueData: 0xFFFFFFFF }],
    });

    const resources = parseArsc(buf);
    expect(resources[0].value).toBe('true');
  });

  it('formats TYPE_INT_BOOLEAN false', () => {
    const buf = buildMinimalArsc({
      globalStrings: [],
      typeStrings: ['bool'],
      keyStrings: ['is_phone'],
      entries: [{ valueType: 0x12, valueData: 0 }],
    });

    const resources = parseArsc(buf);
    expect(resources[0].value).toBe('false');
  });

  it('formats TYPE_REFERENCE values', () => {
    const buf = buildMinimalArsc({
      globalStrings: [],
      typeStrings: ['style'],
      keyStrings: ['app_theme'],
      entries: [{ valueType: 0x01, valueData: 0x7F0B0001 }],
    });

    const resources = parseArsc(buf);
    expect(resources[0].value).toBe('@0x7f0b0001');
  });

  it('formats TYPE_INT_COLOR_ARGB8', () => {
    const buf = buildMinimalArsc({
      globalStrings: [],
      typeStrings: ['color'],
      keyStrings: ['primary'],
      entries: [{ valueType: 0x1c, valueData: 0xFF336699 }],
    });

    const resources = parseArsc(buf);
    expect(resources[0].value).toBe('#ff336699');
  });

  it('formats TYPE_INT_HEX values', () => {
    const buf = buildMinimalArsc({
      globalStrings: [],
      typeStrings: ['integer'],
      keyStrings: ['flags'],
      entries: [{ valueType: 0x11, valueData: 0xABCD }],
    });

    const resources = parseArsc(buf);
    expect(resources[0].value).toBe('0xabcd');
  });

  it('extracts language config qualifier', () => {
    const buf = buildMinimalArsc({
      globalStrings: ['Mon App'],
      typeStrings: ['string'],
      keyStrings: ['app_name'],
      entries: [{ valueType: 0x03, valueData: 0 }],
      config: { lang: 'fr' },
    });

    const resources = parseArsc(buf);
    expect(resources[0].config).toBe('fr');
  });

  it('extracts density config qualifier', () => {
    const buf = buildMinimalArsc({
      globalStrings: [],
      typeStrings: ['drawable'],
      keyStrings: ['icon'],
      entries: [{ valueType: 0x03, valueData: 0 }],
      config: { density: 320 },
    });

    const resources = parseArsc(buf);
    expect(resources[0].config).toBe('xhdpi');
  });

  it('extracts SDK version config qualifier', () => {
    const buf = buildMinimalArsc({
      globalStrings: [],
      typeStrings: ['style'],
      keyStrings: ['theme'],
      entries: [{ valueType: 0x01, valueData: 0 }],
      config: { sdk: 21 },
    });

    const resources = parseArsc(buf);
    expect(resources[0].config).toBe('v21');
  });

  it('combines multiple config qualifiers', () => {
    const buf = buildMinimalArsc({
      globalStrings: ['Hola'],
      typeStrings: ['string'],
      keyStrings: ['greeting'],
      entries: [{ valueType: 0x03, valueData: 0 }],
      config: { lang: 'es', density: 240, sdk: 28 },
    });

    const resources = parseArsc(buf);
    expect(resources[0].config).toBe('es-hdpi-v28');
  });

  it('returns empty array for null input', () => {
    expect(parseArsc(null as any)).toEqual([]);
  });

  it('returns empty array for too-short input', () => {
    expect(parseArsc(Buffer.alloc(4))).toEqual([]);
  });

  it('returns empty array for wrong file type', () => {
    const buf = Buffer.alloc(12);
    writeU16(buf, 0, 0x0003); // AXML type, not ARSC
    expect(parseArsc(buf)).toEqual([]);
  });

  it('generates correct resource IDs', () => {
    const buf = buildMinimalArsc({
      globalStrings: ['a', 'b', 'c'],
      typeStrings: ['string'],
      keyStrings: ['s1', 's2', 's3'],
      entries: [
        { valueType: 0x03, valueData: 0 },
        { valueType: 0x03, valueData: 1 },
        { valueType: 0x03, valueData: 2 },
      ],
    });

    const resources = parseArsc(buf);
    expect(resources[0].resourceId).toBe('0x7f010000');
    expect(resources[1].resourceId).toBe('0x7f010001');
    expect(resources[2].resourceId).toBe('0x7f010002');
  });
});
