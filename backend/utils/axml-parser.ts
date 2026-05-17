// Android Binary XML (AXML) parser — pure TypeScript
// Decodes compiled AndroidManifest.xml and other binary XML resources

const CHUNK_AXML_FILE = 0x0003;
const CHUNK_STRING_POOL = 0x0001;
const CHUNK_RESOURCE_MAP = 0x0180;
const CHUNK_NS_START = 0x0100;
const CHUNK_NS_END = 0x0101;
const CHUNK_ELEM_START = 0x0102;
const CHUNK_ELEM_END = 0x0103;
const CHUNK_CDATA = 0x0104;

const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01;
const TYPE_ATTRIBUTE = 0x02;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_DIMENSION = 0x05;
const TYPE_FRACTION = 0x06;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;
const TYPE_INT_COLOR_ARGB8 = 0x1c;
const TYPE_INT_COLOR_RGB8 = 0x1d;
const TYPE_INT_COLOR_ARGB4 = 0x1e;
const TYPE_INT_COLOR_RGB4 = 0x1f;

const DIMENSION_UNITS = ['px', 'dp', 'sp', 'pt', 'in', 'mm'];
const RADIX_SHIFTS = [0, 7, 15, 23];

const AXML_MAGIC = Buffer.from([0x03, 0x00, 0x08, 0x00]);

export function isAxmlBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x03 && buf[1] === 0x00 && buf[2] === 0x08 && buf[3] === 0x00;
}

interface Attribute {
  nsIdx: number;
  nameIdx: number;
  rawValueIdx: number;
  typedValueSize: number;
  typedValueRes0: number;
  typedValueType: number;
  typedValueData: number;
}

class AxmlParser {
  private buf: Buffer;
  private pos = 0;
  private strings: string[] = [];
  private resourceIds: number[] = [];
  private namespaces = new Map<string, string>(); // uri -> prefix
  private pendingNs: Array<{ prefix: string; uri: string }> = [];
  private output: string[] = [];
  private depth = 0;

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  private u8(): number {
    return this.buf[this.pos++];
  }

  private u16(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  private u32(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  private i32(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  private str(idx: number): string {
    if (idx === -1 || idx === 0xFFFFFFFF || idx < 0 || idx >= this.strings.length) return '';
    return this.strings[idx];
  }

  private parseStringPool(chunkStart: number, chunkSize: number): void {
    const stringCount = this.u32();
    const styleCount = this.u32();
    const flags = this.u32();
    const stringsStart = this.u32();
    const _stylesStart = this.u32();
    const isUtf8 = (flags & (1 << 8)) !== 0;

    const offsets: number[] = [];
    for (let i = 0; i < stringCount; i++) offsets.push(this.u32());
    // skip style offsets
    this.pos += styleCount * 4;

    const dataStart = chunkStart + stringsStart;

    for (let i = 0; i < stringCount; i++) {
      const spos = dataStart + offsets[i];
      if (isUtf8) {
        this.strings.push(this.readUtf8String(spos));
      } else {
        this.strings.push(this.readUtf16String(spos));
      }
    }

    this.pos = chunkStart + chunkSize;
  }

  private readUtf8String(pos: number): string {
    let p = pos;
    // First length prefix: character count (1 or 2 bytes)
    if (this.buf[p] & 0x80) p += 2; else p += 1;
    // Second length prefix: byte count (1 or 2 bytes)
    let byteLen: number;
    if (this.buf[p] & 0x80) {
      byteLen = ((this.buf[p] & 0x7F) << 8) | this.buf[p + 1];
      p += 2;
    } else {
      byteLen = this.buf[p];
      p += 1;
    }
    return this.buf.toString('utf8', p, p + byteLen);
  }

  private readUtf16String(pos: number): string {
    let p = pos;
    let charLen: number;
    if (this.buf.readUInt16LE(p) & 0x8000) {
      charLen = ((this.buf.readUInt16LE(p) & 0x7FFF) << 16) | this.buf.readUInt16LE(p + 2);
      p += 4;
    } else {
      charLen = this.buf.readUInt16LE(p);
      p += 2;
    }
    const codes: number[] = [];
    for (let i = 0; i < charLen; i++) {
      codes.push(this.buf.readUInt16LE(p + i * 2));
    }
    return String.fromCharCode(...codes);
  }

  private parseResourceMap(chunkStart: number, chunkSize: number): void {
    const count = (chunkSize - 8) / 4;
    for (let i = 0; i < count; i++) this.resourceIds.push(this.u32());
  }

  private parseNsStart(): void {
    const _lineNumber = this.u32();
    const _comment = this.i32();
    const prefixIdx = this.i32();
    const uriIdx = this.i32();
    const prefix = this.str(prefixIdx);
    const uri = this.str(uriIdx);
    this.namespaces.set(uri, prefix);
    this.pendingNs.push({ prefix, uri });
  }

  private parseNsEnd(): void {
    const _lineNumber = this.u32();
    const _comment = this.i32();
    const _prefixIdx = this.i32();
    const uriIdx = this.i32();
    const uri = this.str(uriIdx);
    this.namespaces.delete(uri);
  }

  private parseElemStart(): void {
    const _lineNumber = this.u32();
    const _comment = this.i32();
    const nsIdx = this.i32();
    const nameIdx = this.i32();
    const _attrStart = this.u16();
    const _attrSize = this.u16();
    const attrCount = this.u16();
    const _idIndex = this.u16();
    const _classIndex = this.u16();
    const _styleIndex = this.u16();

    const attrs: Attribute[] = [];
    for (let i = 0; i < attrCount; i++) {
      attrs.push({
        nsIdx: this.i32(),
        nameIdx: this.i32(),
        rawValueIdx: this.i32(),
        typedValueSize: this.u16(),
        typedValueRes0: this.u8(),
        typedValueType: this.u8(),
        typedValueData: this.u32(),
      });
    }

    const ns = nsIdx !== -1 ? this.str(nsIdx) : '';
    const name = this.str(nameIdx);
    const prefix = ns ? this.namespaces.get(ns) : undefined;
    const tagName = prefix ? `${prefix}:${name}` : name;

    const indent = '  '.repeat(this.depth);
    let line = `${indent}<${tagName}`;

    // Emit pending xmlns declarations
    for (const pns of this.pendingNs) {
      const nsAttr = pns.prefix ? `xmlns:${pns.prefix}` : 'xmlns';
      line += `\n${indent}  ${nsAttr}="${escapeXml(pns.uri)}"`;
    }
    this.pendingNs = [];

    for (const attr of attrs) {
      const aNs = attr.nsIdx !== -1 ? this.str(attr.nsIdx) : '';
      const aName = this.str(attr.nameIdx);
      const aPrefix = aNs ? this.namespaces.get(aNs) : undefined;
      const attrName = aPrefix ? `${aPrefix}:${aName}` : aName;
      const attrValue = this.formatAttrValue(attr);
      line += `\n${indent}  ${attrName}="${escapeXml(attrValue)}"`;
    }

    line += '>';
    this.output.push(line);
    this.depth++;
  }

  private parseElemEnd(): void {
    const _lineNumber = this.u32();
    const _comment = this.i32();
    const nsIdx = this.i32();
    const nameIdx = this.i32();
    const ns = nsIdx !== -1 ? this.str(nsIdx) : '';
    const name = this.str(nameIdx);
    const prefix = ns ? this.namespaces.get(ns) : undefined;
    const tagName = prefix ? `${prefix}:${name}` : name;
    this.depth--;
    this.output.push(`${'  '.repeat(this.depth)}</${tagName}>`);
  }

  private parseCdata(): void {
    const _lineNumber = this.u32();
    const _comment = this.i32();
    const dataIdx = this.i32();
    // skip typed value (8 bytes)
    this.pos += 8;
    const text = this.str(dataIdx);
    this.output.push(`${'  '.repeat(this.depth)}${escapeXml(text)}`);
  }

  private formatAttrValue(attr: Attribute): string {
    if (attr.rawValueIdx !== -1 && attr.typedValueType === TYPE_STRING) {
      return this.str(attr.rawValueIdx);
    }
    return this.formatTypedValue(attr.typedValueType, attr.typedValueData);
  }

  private formatTypedValue(type: number, data: number): string {
    switch (type) {
      case TYPE_NULL:
        return '';
      case TYPE_REFERENCE:
        return `@0x${data.toString(16).padStart(8, '0')}`;
      case TYPE_ATTRIBUTE:
        return `?0x${data.toString(16).padStart(8, '0')}`;
      case TYPE_STRING:
        return this.str(data);
      case TYPE_FLOAT: {
        const fbuf = Buffer.alloc(4);
        fbuf.writeUInt32LE(data);
        return fbuf.readFloatLE(0).toString();
      }
      case TYPE_DIMENSION:
        return this.formatDimension(data);
      case TYPE_FRACTION:
        return this.formatFraction(data);
      case TYPE_INT_DEC:
        return (data | 0).toString();
      case TYPE_INT_HEX:
        return `0x${data.toString(16)}`;
      case TYPE_INT_BOOLEAN:
        return data !== 0 ? 'true' : 'false';
      case TYPE_INT_COLOR_ARGB8:
        return `#${data.toString(16).padStart(8, '0')}`;
      case TYPE_INT_COLOR_RGB8:
        return `#${(data & 0xFFFFFF).toString(16).padStart(6, '0')}`;
      case TYPE_INT_COLOR_ARGB4:
        return `#${data.toString(16).padStart(4, '0')}`;
      case TYPE_INT_COLOR_RGB4:
        return `#${(data & 0xFFF).toString(16).padStart(3, '0')}`;
      default:
        return `0x${data.toString(16)}`;
    }
  }

  private formatDimension(data: number): string {
    const unitIdx = data & 0x0F;
    const radixIdx = (data >> 4) & 0x03;
    const mantissa = (data >> 8) & 0xFFFFFF;
    // Sign-extend 24-bit mantissa
    const signed = mantissa >= 0x800000 ? mantissa - 0x1000000 : mantissa;
    const value = signed / (1 << RADIX_SHIFTS[radixIdx]);
    const unit = DIMENSION_UNITS[unitIdx] || '';
    // Clean up float display
    const str = Number.isInteger(value) ? value.toString() : parseFloat(value.toPrecision(6)).toString();
    return `${str}${unit}`;
  }

  private formatFraction(data: number): string {
    const typeFlag = data & 0x0F;
    const radixIdx = (data >> 4) & 0x03;
    const mantissa = (data >> 8) & 0xFFFFFF;
    const signed = mantissa >= 0x800000 ? mantissa - 0x1000000 : mantissa;
    const value = signed / (1 << RADIX_SHIFTS[radixIdx]);
    const pct = value * 100;
    const suffix = typeFlag === 0 ? '%' : '%p';
    return `${parseFloat(pct.toPrecision(6))}${suffix}`;
  }

  parse(): string {
    // Validate file header
    const fileType = this.u16();
    const _fileHeaderSize = this.u16();
    const _fileTotalSize = this.u32();

    if (fileType !== CHUNK_AXML_FILE) {
      throw new Error(`Not an AXML file (type=0x${fileType.toString(16)})`);
    }

    while (this.pos < this.buf.length) {
      const chunkStart = this.pos;
      const chunkType = this.u16();
      const chunkHeaderSize = this.u16();
      const chunkSize = this.u32();

      switch (chunkType) {
        case CHUNK_STRING_POOL:
          this.parseStringPool(chunkStart, chunkSize);
          break;
        case CHUNK_RESOURCE_MAP:
          this.parseResourceMap(chunkStart, chunkSize);
          break;
        case CHUNK_NS_START:
          this.parseNsStart();
          this.pos = chunkStart + chunkSize;
          break;
        case CHUNK_NS_END:
          this.parseNsEnd();
          this.pos = chunkStart + chunkSize;
          break;
        case CHUNK_ELEM_START:
          this.parseElemStart();
          this.pos = chunkStart + chunkSize;
          break;
        case CHUNK_ELEM_END:
          this.parseElemEnd();
          this.pos = chunkStart + chunkSize;
          break;
        case CHUNK_CDATA:
          this.parseCdata();
          this.pos = chunkStart + chunkSize;
          break;
        default:
          // Skip unknown chunks
          this.pos = chunkStart + chunkSize;
          break;
      }
    }

    return this.output.join('\n');
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function decodeAxml(buf: Buffer): string {
  return new AxmlParser(buf).parse();
}
