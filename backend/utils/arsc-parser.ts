/**
 * Pure TypeScript Android resources.arsc parser.
 *
 * Binary format reference:
 *   https://android.googlesource.com/platform/frameworks/base/+/master/libs/androidfw/include/androidfw/ResourceTypes.h
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArscResource {
  type: string;       // e.g. "string", "drawable", "layout", "color", "dimen", "style", "attr"
  name: string;       // resource key name e.g. "app_name"
  value: string;      // formatted value string
  resourceId: string; // hex resource ID e.g. "0x7f040001"
  config: string;     // config qualifier e.g. "default", "en", "hdpi", "v21"
}

// ---------------------------------------------------------------------------
// Chunk type constants
// ---------------------------------------------------------------------------

const RES_TABLE_TYPE          = 0x0002;
const RES_STRING_POOL_TYPE    = 0x0001;
const RES_TABLE_PACKAGE_TYPE  = 0x0200;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;
const RES_TABLE_TYPE_TYPE     = 0x0201;

// ---------------------------------------------------------------------------
// Res_value data‑type constants
// ---------------------------------------------------------------------------

const TYPE_NULL             = 0x00;
const TYPE_REFERENCE        = 0x01;
const TYPE_ATTRIBUTE        = 0x02;
const TYPE_STRING           = 0x03;
const TYPE_FLOAT            = 0x04;
const TYPE_DIMENSION        = 0x05;
const TYPE_FRACTION         = 0x06;
const TYPE_INT_DEC          = 0x10;
const TYPE_INT_HEX          = 0x11;
const TYPE_INT_BOOLEAN      = 0x12;
const TYPE_INT_COLOR_ARGB8  = 0x1c;
const TYPE_INT_COLOR_RGB8   = 0x1d;

const FLAG_COMPLEX = 0x0001;

// Dimension unit strings (indexed by low 4 bits of complex data)
const DIMENSION_UNITS = ['px', 'dp', 'sp', 'pt', 'in', 'mm'];
const FRACTION_UNITS  = ['%', '%p'];

// ---------------------------------------------------------------------------
// Density → qualifier mapping
// ---------------------------------------------------------------------------

const DENSITY_MAP: Record<number, string> = {
  120: 'ldpi',
  160: 'mdpi',
  240: 'hdpi',
  320: 'xhdpi',
  480: 'xxhdpi',
  640: 'xxxhdpi',
};

function densityToString(density: number): string {
  return DENSITY_MAP[density] || `${density}dpi`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe read – returns 0/empty when out of bounds. */
function safeU8(buf: Buffer, off: number): number {
  return off >= 0 && off < buf.length ? buf[off] : 0;
}
function safeU16(buf: Buffer, off: number): number {
  return off >= 0 && off + 1 < buf.length ? buf.readUInt16LE(off) : 0;
}
function safeU32(buf: Buffer, off: number): number {
  return off >= 0 && off + 3 < buf.length ? buf.readUInt32LE(off) : 0;
}
function safeI32(buf: Buffer, off: number): number {
  return off >= 0 && off + 3 < buf.length ? buf.readInt32LE(off) : 0;
}
function safeFloat(buf: Buffer, off: number): number {
  return off >= 0 && off + 3 < buf.length ? buf.readFloatLE(off) : 0;
}

// ---------------------------------------------------------------------------
// Complex value helpers (dimension / fraction)
// ---------------------------------------------------------------------------

const RADIX_SHIFTS = [0, 7, 15, 23];

function complexToFloat(data: number): number {
  const mantissa = (data >> 8) & 0xffffff;
  // sign‑extend 24‑bit mantissa
  const signed = mantissa >= 0x800000 ? mantissa - 0x1000000 : mantissa;
  const radix = (data >> 4) & 0x03;
  return signed / (1 << RADIX_SHIFTS[radix]);
}

function formatDimension(data: number): string {
  const value = complexToFloat(data);
  const unitIdx = data & 0x0f;
  const unit = DIMENSION_UNITS[unitIdx] || '??';
  return `${stripTrailingZeros(value)}${unit}`;
}

function formatFraction(data: number): string {
  const value = complexToFloat(data) * 100;
  const unitIdx = data & 0x0f;
  const unit = FRACTION_UNITS[unitIdx] || '%';
  return `${stripTrailingZeros(value)}${unit}`;
}

function stripTrailingZeros(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  // Up to 6 decimal places, strip trailing zeros
  return parseFloat(n.toFixed(6)).toString();
}

// ---------------------------------------------------------------------------
// String pool parser
// ---------------------------------------------------------------------------

function parseStringPool(buf: Buffer, offset: number): string[] {
  const strings: string[] = [];
  if (offset + 28 > buf.length) return strings;

  const type = safeU16(buf, offset);
  if (type !== RES_STRING_POOL_TYPE) return strings;

  const headerSize   = safeU16(buf, offset + 2);
  const chunkSize    = safeU32(buf, offset + 4);
  const stringCount  = safeU32(buf, offset + 8);
  // const styleCount   = safeU32(buf, offset + 12); // unused
  const flags        = safeU32(buf, offset + 16);
  const stringsStart = safeU32(buf, offset + 20);
  // const stylesStart  = safeU32(buf, offset + 24); // unused

  const isUtf8 = (flags & (1 << 8)) !== 0;

  // Absolute position where the string offset array begins
  const offsetArrayStart = offset + headerSize;
  // Absolute position where the raw string data begins
  const dataStart = offset + stringsStart;

  for (let i = 0; i < stringCount; i++) {
    const offPos = offsetArrayStart + i * 4;
    if (offPos + 4 > buf.length) {
      strings.push('');
      continue;
    }
    const strOff = safeU32(buf, offPos);
    const absOff = dataStart + strOff;

    if (absOff >= buf.length || absOff >= offset + chunkSize) {
      strings.push('');
      continue;
    }

    try {
      if (isUtf8) {
        strings.push(readUtf8String(buf, absOff));
      } else {
        strings.push(readUtf16String(buf, absOff));
      }
    } catch {
      strings.push('');
    }
  }

  return strings;
}

/**
 * Read a UTF-8 encoded string from the pool.
 * Format: encoded‑length prefix (1‑2 bytes), byte‑length prefix (1‑2 bytes), then UTF-8 bytes.
 */
function readUtf8String(buf: Buffer, off: number): string {
  let pos = off;

  // First length prefix: number of UTF‑16 code units (we skip it)
  if (pos >= buf.length) return '';
  const first = buf[pos];
  if (first & 0x80) {
    pos += 2;
  } else {
    pos += 1;
  }

  // Second length prefix: number of UTF-8 bytes
  if (pos >= buf.length) return '';
  let byteLen: number;
  const second = buf[pos];
  if (second & 0x80) {
    if (pos + 1 >= buf.length) return '';
    byteLen = ((second & 0x7f) << 8) | buf[pos + 1];
    pos += 2;
  } else {
    byteLen = second;
    pos += 1;
  }

  if (pos + byteLen > buf.length) {
    byteLen = buf.length - pos;
  }
  return buf.toString('utf8', pos, pos + byteLen);
}

/**
 * Read a UTF-16LE encoded string from the pool.
 * Format: uint16 charCount (if high bit set, next uint16 gives low 16 bits), then chars, then null terminator.
 */
function readUtf16String(buf: Buffer, off: number): string {
  let pos = off;
  if (pos + 2 > buf.length) return '';

  let charCount = safeU16(buf, pos);
  pos += 2;

  // Large strings: high bit indicates 32‑bit length
  if (charCount & 0x8000) {
    if (pos + 2 > buf.length) return '';
    const low = safeU16(buf, pos);
    pos += 2;
    charCount = ((charCount & 0x7fff) << 16) | low;
  }

  const byteLen = charCount * 2;
  if (pos + byteLen > buf.length) {
    const available = buf.length - pos;
    return buf.toString('utf16le', pos, pos + (available & ~1));
  }
  return buf.toString('utf16le', pos, pos + byteLen);
}

// ---------------------------------------------------------------------------
// Config qualifier builder
// ---------------------------------------------------------------------------

function buildConfigQualifier(buf: Buffer, configStart: number): string {
  const parts: string[] = [];

  const configSize = safeU32(buf, configStart);
  if (configSize < 4) return 'default';

  // Language: bytes 8-9 relative to configStart
  if (configSize >= 10) {
    const lang0 = safeU8(buf, configStart + 8);
    const lang1 = safeU8(buf, configStart + 9);
    if (lang0 !== 0 && lang1 !== 0) {
      const lang = String.fromCharCode(lang0) + String.fromCharCode(lang1);
      // Region: bytes 10-11
      if (configSize >= 12) {
        const reg0 = safeU8(buf, configStart + 10);
        const reg1 = safeU8(buf, configStart + 11);
        if (reg0 !== 0 && reg1 !== 0) {
          parts.push(`${lang}-r${String.fromCharCode(reg0)}${String.fromCharCode(reg1)}`);
        } else {
          parts.push(lang);
        }
      } else {
        parts.push(lang);
      }
    }
  }

  // Density: uint16 at offset 14
  if (configSize >= 16) {
    const density = safeU16(buf, configStart + 14);
    if (density !== 0) {
      parts.push(densityToString(density));
    }
  }

  // SDK version: uint16 at offset 20
  if (configSize >= 22) {
    const sdk = safeU16(buf, configStart + 20);
    if (sdk > 0) {
      parts.push(`v${sdk}`);
    }
  }

  return parts.length > 0 ? parts.join('-') : 'default';
}

// ---------------------------------------------------------------------------
// Res_value formatter
// ---------------------------------------------------------------------------

function formatValue(
  dataType: number,
  data: number,
  globalStrings: string[],
  buf: Buffer,
  valueOffset: number,
): string {
  switch (dataType) {
    case TYPE_NULL:
      return '';
    case TYPE_STRING:
      return data < globalStrings.length ? globalStrings[data] : '';
    case TYPE_REFERENCE:
      return `@0x${(data >>> 0).toString(16)}`;
    case TYPE_ATTRIBUTE:
      return `?0x${(data >>> 0).toString(16)}`;
    case TYPE_FLOAT:
      return stripTrailingZeros(safeFloat(buf, valueOffset + 4));
    case TYPE_DIMENSION:
      return formatDimension(data);
    case TYPE_FRACTION:
      return formatFraction(data);
    case TYPE_INT_DEC:
      return (data | 0).toString();
    case TYPE_INT_HEX:
      return `0x${(data >>> 0).toString(16)}`;
    case TYPE_INT_BOOLEAN:
      return data !== 0 ? 'true' : 'false';
    case TYPE_INT_COLOR_ARGB8:
      return `#${(data >>> 0).toString(16).padStart(8, '0')}`;
    case TYPE_INT_COLOR_RGB8:
      return `#${(data & 0x00ffffff).toString(16).padStart(6, '0')}`;
    default:
      return `0x${(data >>> 0).toString(16)}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether a buffer starts with a resources.arsc table header (chunk type 0x0002).
 */
export function isArscBuffer(buf: Buffer): boolean {
  if (!buf || buf.length < 2) return false;
  return buf.readUInt16LE(0) === RES_TABLE_TYPE;
}

/**
 * Parse a resources.arsc buffer and return a flat array of resources.
 * Malformed entries are silently skipped.
 */
export function parseArsc(buf: Buffer): ArscResource[] {
  const results: ArscResource[] = [];

  if (!buf || buf.length < 12) return results;

  // ── File header ────────────────────────────────────────────────
  const fileType       = safeU16(buf, 0);
  const fileHeaderSize = safeU16(buf, 2);
  // const fileTotalSize  = safeU32(buf, 4);
  // const packageCount   = safeU32(buf, 8);

  if (fileType !== RES_TABLE_TYPE) return results;

  // ── Global string pool ─────────────────────────────────────────
  let pos = fileHeaderSize;
  let globalStrings: string[] = [];

  if (pos + 8 <= buf.length && safeU16(buf, pos) === RES_STRING_POOL_TYPE) {
    globalStrings = parseStringPool(buf, pos);
    const poolSize = safeU32(buf, pos + 4);
    pos += poolSize;
  }

  // ── Iterate remaining top‑level chunks (packages) ─────────────
  while (pos + 8 <= buf.length) {
    const chunkType = safeU16(buf, pos);
    const chunkSize = safeU32(buf, pos + 4);

    if (chunkSize < 8 || pos + chunkSize > buf.length + 4) {
      // Allow a little slack on the last chunk (some APKs have minor padding)
      break;
    }

    if (chunkType === RES_TABLE_PACKAGE_TYPE) {
      parsePackage(buf, pos, chunkSize, globalStrings, results);
    }

    pos += chunkSize;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Package parser
// ---------------------------------------------------------------------------

function parsePackage(
  buf: Buffer,
  pkgStart: number,
  pkgSize: number,
  globalStrings: string[],
  results: ArscResource[],
): void {
  if (pkgStart + 288 > buf.length) return;

  const headerSize       = safeU16(buf, pkgStart + 2);
  const packageId        = safeU32(buf, pkgStart + 8);
  const typeStringsOff   = safeU32(buf, pkgStart + 268); // offset relative to pkgStart
  const keyStringsOff    = safeU32(buf, pkgStart + 276); // offset relative to pkgStart

  // ── Type string pool ───────────────────────────────────────────
  let typeStrings: string[] = [];
  {
    const absOff = pkgStart + typeStringsOff;
    if (absOff + 8 <= buf.length && safeU16(buf, absOff) === RES_STRING_POOL_TYPE) {
      typeStrings = parseStringPool(buf, absOff);
    }
  }

  // ── Key string pool ────────────────────────────────────────────
  let keyStrings: string[] = [];
  {
    const absOff = pkgStart + keyStringsOff;
    if (absOff + 8 <= buf.length && safeU16(buf, absOff) === RES_STRING_POOL_TYPE) {
      keyStrings = parseStringPool(buf, absOff);
    }
  }

  // ── Walk sub‑chunks inside the package ─────────────────────────
  let pos = pkgStart + headerSize;
  const pkgEnd = pkgStart + pkgSize;

  while (pos + 8 <= pkgEnd && pos + 8 <= buf.length) {
    const chunkType = safeU16(buf, pos);
    const chunkSize = safeU32(buf, pos + 4);

    if (chunkSize < 8 || pos + chunkSize > pkgEnd + 4) break;

    if (chunkType === RES_TABLE_TYPE_TYPE) {
      parseTypeChunk(
        buf,
        pos,
        chunkSize,
        packageId,
        typeStrings,
        keyStrings,
        globalStrings,
        results,
      );
    }
    // TypeSpec (0x0202) and other chunks are skipped.

    pos += chunkSize;
  }
}

// ---------------------------------------------------------------------------
// Type chunk parser
// ---------------------------------------------------------------------------

function parseTypeChunk(
  buf: Buffer,
  chunkStart: number,
  chunkSize: number,
  packageId: number,
  typeStrings: string[],
  keyStrings: string[],
  globalStrings: string[],
  results: ArscResource[],
): void {
  const headerSize   = safeU16(buf, chunkStart + 2);
  const typeId       = safeU8(buf, chunkStart + 8);  // 1-based
  const entryCount   = safeU32(buf, chunkStart + 12);
  const entriesStart = safeU32(buf, chunkStart + 16);

  // Type name (typeId is 1-based; typeStrings is 0-based)
  const typeName = typeId > 0 && typeId - 1 < typeStrings.length
    ? typeStrings[typeId - 1]
    : `type${typeId}`;

  // Config block starts right after the fixed fields (offset 20 from chunk start)
  const configStart = chunkStart + 20;
  const configQualifier = buildConfigQualifier(buf, configStart);

  // Offset array begins right after the header
  const offsetArrayStart = chunkStart + headerSize;
  // Entry data begins at entriesStart relative to chunk start
  const entriesBase = chunkStart + entriesStart;

  for (let i = 0; i < entryCount; i++) {
    const offPos = offsetArrayStart + i * 4;
    if (offPos + 4 > buf.length) break;

    const entryOffset = safeU32(buf, offPos);
    // 0xFFFFFFFF means no entry
    if (entryOffset === 0xffffffff) continue;

    const entryPos = entriesBase + entryOffset;
    if (entryPos + 8 > buf.length) continue;

    const entrySize  = safeU16(buf, entryPos);
    const entryFlags = safeU16(buf, entryPos + 2);
    const keyIdx     = safeU32(buf, entryPos + 4);

    const keyName = keyIdx < keyStrings.length ? keyStrings[keyIdx] : `key${keyIdx}`;
    const resId = ((packageId & 0xff) << 24) | ((typeId & 0xff) << 16) | (i & 0xffff);
    const resourceId = `0x${(resId >>> 0).toString(16).padStart(8, '0')}`;

    if (entryFlags & FLAG_COMPLEX) {
      // ── Bag / complex entry ──────────────────────────────────
      const mapStart = entryPos + entrySize;
      if (mapStart + 8 > buf.length) continue;

      // const parentRef = safeU32(buf, mapStart);
      const mapCount  = safeU32(buf, mapStart + 4);
      const valuesStart = mapStart + 8;

      // Collect child values into a single string representation
      const parts: string[] = [];
      for (let m = 0; m < mapCount; m++) {
        const mOff = valuesStart + m * 12; // 4 (name) + 8 (Res_value)
        if (mOff + 12 > buf.length) break;

        const valueDT   = safeU8(buf, mOff + 4 + 2 + 1);  // Res_value: size(2) + res0(1) + dataType(1)
        const valueData = safeU32(buf, mOff + 4 + 4);       // Res_value: ...data(4)
        const formatted = formatValue(valueDT, valueData, globalStrings, buf, mOff + 4);
        parts.push(formatted);
      }

      results.push({
        type: typeName,
        name: keyName,
        value: parts.join(', '),
        resourceId,
        config: configQualifier,
      });
    } else {
      // ── Simple entry ─────────────────────────────────────────
      const valueStart = entryPos + entrySize;
      if (valueStart + 8 > buf.length) continue;

      // Res_value: uint16 size, uint8 res0, uint8 dataType, uint32 data
      const dataType = safeU8(buf, valueStart + 3);
      const data     = safeU32(buf, valueStart + 4);
      const value    = formatValue(dataType, data, globalStrings, buf, valueStart);

      results.push({
        type: typeName,
        name: keyName,
        value,
        resourceId,
        config: configQualifier,
      });
    }
  }
}
