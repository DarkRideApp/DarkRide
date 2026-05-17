import { describe, it, expect } from 'vitest';
import { isAxmlBuffer, decodeAxml } from './axml-parser';

// ---------------------------------------------------------------------------
// Helper: build a minimal AXML buffer programmatically
// ---------------------------------------------------------------------------

function writeU16(buf: Buffer, offset: number, val: number): void {
  buf.writeUInt16LE(val, offset);
}
function writeU32(buf: Buffer, offset: number, val: number): void {
  buf.writeUInt32LE(val, offset);
}
function writeI32(buf: Buffer, offset: number, val: number): void {
  buf.writeInt32LE(val, offset);
}

/** Build a UTF-8 string pool chunk with given strings */
function buildUtf8StringPool(strings: string[]): Buffer {
  // Calculate string data
  const stringBufs: Buffer[] = [];
  for (const s of strings) {
    const utf8 = Buffer.from(s, 'utf8');
    // charLen prefix (1 byte), byteLen prefix (1 byte), data, null terminator
    const entry = Buffer.alloc(1 + 1 + utf8.length + 1);
    entry[0] = s.length; // char count (simplified, < 128)
    entry[1] = utf8.length; // byte count
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
  writeU16(buf, 0, 0x0001); // type: string pool
  writeU16(buf, 2, headerSize);
  writeU32(buf, 4, chunkSize);
  writeU32(buf, 8, strings.length); // stringCount
  writeU32(buf, 12, 0); // styleCount
  writeU32(buf, 16, 1 << 8); // flags: UTF-8
  writeU32(buf, 20, stringsStart);
  writeU32(buf, 24, 0); // stylesStart

  // Offsets
  let dataOff = 0;
  for (let i = 0; i < strings.length; i++) {
    writeU32(buf, headerSize + i * 4, dataOff);
    dataOff += stringBufs[i].length;
  }

  // String data
  let pos = stringsStart;
  for (const sb of stringBufs) {
    sb.copy(buf, pos);
    pos += sb.length;
  }

  return buf;
}

/** Build a UTF-16 string pool chunk */
function buildUtf16StringPool(strings: string[]): Buffer {
  const stringBufs: Buffer[] = [];
  for (const s of strings) {
    // uint16 charLen, then uint16[charLen] chars, then uint16 null
    const entry = Buffer.alloc(2 + s.length * 2 + 2);
    entry.writeUInt16LE(s.length, 0);
    for (let i = 0; i < s.length; i++) {
      entry.writeUInt16LE(s.charCodeAt(i), 2 + i * 2);
    }
    entry.writeUInt16LE(0, 2 + s.length * 2);
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
  writeU32(buf, 16, 0); // flags: UTF-16
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
 * Build a minimal AXML document: string pool + one element start + element end.
 * strings[0] = tag name, strings[1..] = attr names/values
 */
function buildMinimalAxml(opts: {
  strings: string[];
  utf8?: boolean;
  attributes?: Array<{
    nameIdx: number;
    rawValueIdx?: number;
    type: number;
    data: number;
  }>;
  cdata?: { dataIdx: number };
}): Buffer {
  const poolBuf = opts.utf8 !== false
    ? buildUtf8StringPool(opts.strings)
    : buildUtf16StringPool(opts.strings);

  // Element start chunk
  const attrCount = opts.attributes?.length || 0;
  const elemStartSize = 8 + 4 + 4 + 4 + 4 + 2 + 2 + 2 + 2 + 2 + 2 + attrCount * 20;
  const elemStartBuf = Buffer.alloc(elemStartSize);
  writeU16(elemStartBuf, 0, 0x0102); // type
  writeU16(elemStartBuf, 2, 8 + 4 + 4 + 4 + 4 + 12); // headerSize (36)
  writeU32(elemStartBuf, 4, elemStartSize);
  writeU32(elemStartBuf, 8, 1); // lineNumber
  writeI32(elemStartBuf, 12, -1); // comment
  writeI32(elemStartBuf, 16, -1); // namespace (none)
  writeI32(elemStartBuf, 20, 0); // name = strings[0]
  writeU16(elemStartBuf, 24, 20); // attrStart (relative to nameIdx?)
  writeU16(elemStartBuf, 26, 20); // attrSize
  writeU16(elemStartBuf, 28, attrCount);
  writeU16(elemStartBuf, 30, 0); // idIndex
  writeU16(elemStartBuf, 32, 0); // classIndex
  writeU16(elemStartBuf, 34, 0); // styleIndex

  if (opts.attributes) {
    let off = 36;
    for (const attr of opts.attributes) {
      writeI32(elemStartBuf, off, -1); // nsIdx
      writeI32(elemStartBuf, off + 4, attr.nameIdx);
      writeI32(elemStartBuf, off + 8, attr.rawValueIdx ?? -1);
      writeU16(elemStartBuf, off + 12, 8); // typedValueSize
      elemStartBuf[off + 14] = 0; // res0
      elemStartBuf[off + 15] = attr.type;
      writeU32(elemStartBuf, off + 16, attr.data);
      off += 20;
    }
  }

  // Optional CDATA chunk
  let cdataBuf = Buffer.alloc(0);
  if (opts.cdata) {
    cdataBuf = Buffer.alloc(8 + 4 + 4 + 4 + 8);
    writeU16(cdataBuf, 0, 0x0104);
    writeU16(cdataBuf, 2, 8 + 4 + 4);
    writeU32(cdataBuf, 4, cdataBuf.length);
    writeU32(cdataBuf, 8, 1); // lineNumber
    writeI32(cdataBuf, 12, -1); // comment
    writeI32(cdataBuf, 16, opts.cdata.dataIdx); // data string idx
    // typed value (8 bytes of zeros)
    writeU16(cdataBuf, 20, 8);
    cdataBuf[22] = 0;
    cdataBuf[23] = 0;
    writeU32(cdataBuf, 24, 0);
  }

  // Element end chunk
  const elemEndBuf = Buffer.alloc(8 + 4 + 4 + 4 + 4);
  writeU16(elemEndBuf, 0, 0x0103);
  writeU16(elemEndBuf, 2, 8 + 4 + 4);
  writeU32(elemEndBuf, 4, elemEndBuf.length);
  writeU32(elemEndBuf, 8, 1); // lineNumber
  writeI32(elemEndBuf, 12, -1); // comment
  writeI32(elemEndBuf, 16, -1); // namespace
  writeI32(elemEndBuf, 20, 0); // name = strings[0]

  // Assemble: file header + pool + elemStart + cdata? + elemEnd
  const totalSize = 8 + poolBuf.length + elemStartBuf.length + cdataBuf.length + elemEndBuf.length;
  const result = Buffer.alloc(totalSize);
  writeU16(result, 0, 0x0003); // AXML file type
  writeU16(result, 2, 8); // headerSize
  writeU32(result, 4, totalSize);

  let pos = 8;
  poolBuf.copy(result, pos); pos += poolBuf.length;
  elemStartBuf.copy(result, pos); pos += elemStartBuf.length;
  cdataBuf.copy(result, pos); pos += cdataBuf.length;
  elemEndBuf.copy(result, pos);

  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isAxmlBuffer', () => {
  it('returns true for buffers starting with AXML magic bytes', () => {
    const buf = Buffer.from([0x03, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(isAxmlBuffer(buf)).toBe(true);
  });

  it('returns false for non-AXML buffers', () => {
    expect(isAxmlBuffer(Buffer.from([0x50, 0x4B, 0x03, 0x04]))).toBe(false); // PK (zip)
    expect(isAxmlBuffer(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(false);
    expect(isAxmlBuffer(Buffer.from('<?xml version="1.0"?>'))).toBe(false);
  });

  it('returns false for buffers shorter than 4 bytes', () => {
    expect(isAxmlBuffer(Buffer.from([0x03, 0x00]))).toBe(false);
    expect(isAxmlBuffer(Buffer.alloc(0))).toBe(false);
  });
});

describe('decodeAxml', () => {
  it('decodes a minimal element with UTF-8 string pool', () => {
    const buf = buildMinimalAxml({ strings: ['manifest'], utf8: true });
    const xml = decodeAxml(buf);
    expect(xml).toContain('<manifest>');
    expect(xml).toContain('</manifest>');
  });

  it('decodes a minimal element with UTF-16 string pool', () => {
    const buf = buildMinimalAxml({ strings: ['manifest'], utf8: false });
    const xml = decodeAxml(buf);
    expect(xml).toContain('<manifest>');
    expect(xml).toContain('</manifest>');
  });

  it('decodes string attributes (TYPE_STRING with rawValueIdx)', () => {
    const buf = buildMinimalAxml({
      strings: ['manifest', 'package', 'com.example.app'],
      attributes: [{ nameIdx: 1, rawValueIdx: 2, type: 0x03, data: 2 }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('package="com.example.app"');
  });

  it('decodes TYPE_INT_DEC attributes', () => {
    const buf = buildMinimalAxml({
      strings: ['manifest', 'versionCode'],
      attributes: [{ nameIdx: 1, type: 0x10, data: 42 }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('versionCode="42"');
  });

  it('decodes TYPE_INT_HEX attributes', () => {
    const buf = buildMinimalAxml({
      strings: ['manifest', 'flags'],
      attributes: [{ nameIdx: 1, type: 0x11, data: 0x1234 }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('flags="0x1234"');
  });

  it('decodes TYPE_INT_BOOLEAN true and false', () => {
    const buf = buildMinimalAxml({
      strings: ['manifest', 'enabled', 'disabled'],
      attributes: [
        { nameIdx: 1, type: 0x12, data: 0xFFFFFFFF },
        { nameIdx: 2, type: 0x12, data: 0 },
      ],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('enabled="true"');
    expect(xml).toContain('disabled="false"');
  });

  it('decodes TYPE_REFERENCE attributes', () => {
    const buf = buildMinimalAxml({
      strings: ['manifest', 'theme'],
      attributes: [{ nameIdx: 1, type: 0x01, data: 0x7F0B0001 }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('theme="@0x7f0b0001"');
  });

  it('decodes TYPE_INT_COLOR_ARGB8', () => {
    const buf = buildMinimalAxml({
      strings: ['manifest', 'color'],
      attributes: [{ nameIdx: 1, type: 0x1c, data: 0xFF112233 }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('color="#ff112233"');
  });

  it('decodes CDATA text nodes', () => {
    const buf = buildMinimalAxml({
      strings: ['text', 'Hello World'],
      cdata: { dataIdx: 1 },
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('Hello World');
  });

  it('escapes special XML characters in attribute values', () => {
    const buf = buildMinimalAxml({
      strings: ['manifest', 'label', 'A & B <C>'],
      attributes: [{ nameIdx: 1, rawValueIdx: 2, type: 0x03, data: 2 }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('label="A &amp; B &lt;C&gt;"');
  });

  it('throws on non-AXML input', () => {
    expect(() => decodeAxml(Buffer.from('not xml'))).toThrow();
  });

  it('handles empty AXML (just header + string pool, no elements)', () => {
    const pool = buildUtf8StringPool([]);
    const totalSize = 8 + pool.length;
    const buf = Buffer.alloc(totalSize);
    writeU16(buf, 0, 0x0003);
    writeU16(buf, 2, 8);
    writeU32(buf, 4, totalSize);
    pool.copy(buf, 8);
    const xml = decodeAxml(buf);
    expect(xml).toBe('');
  });

  it('decodes TYPE_DIMENSION dp values', () => {
    // 16dp: mantissa=16 at radix 0, unit=dp(1)
    // data = (mantissa << 8) | (radix << 4) | unit
    const data = (16 << 8) | (0 << 4) | 1;
    const buf = buildMinimalAxml({
      strings: ['view', 'padding'],
      attributes: [{ nameIdx: 1, type: 0x05, data }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('padding="16dp"');
  });

  it('decodes TYPE_DIMENSION sp values', () => {
    const data = (14 << 8) | (0 << 4) | 2; // 14sp
    const buf = buildMinimalAxml({
      strings: ['view', 'textSize'],
      attributes: [{ nameIdx: 1, type: 0x05, data }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('textSize="14sp"');
  });

  it('decodes TYPE_INT_COLOR_RGB8', () => {
    const buf = buildMinimalAxml({
      strings: ['view', 'bg'],
      attributes: [{ nameIdx: 1, type: 0x1d, data: 0xFF336699 }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('bg="#336699"');
  });

  it('decodes TYPE_ATTRIBUTE reference', () => {
    const buf = buildMinimalAxml({
      strings: ['view', 'style'],
      attributes: [{ nameIdx: 1, type: 0x02, data: 0x01010000 }],
    });
    const xml = decodeAxml(buf);
    expect(xml).toContain('style="?0x01010000"');
  });
});
