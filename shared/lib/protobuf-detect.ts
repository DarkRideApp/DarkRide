/**
 * Protobuf detection and schema-less decoding utilities — shared between backend and frontend.
 */

/** Content-Type values that indicate protobuf payloads. */
const PROTOBUF_CONTENT_TYPES = [
  'application/x-protobuf',
  'application/protobuf',
  'application/grpc',
  'application/grpc+proto',
  'application/grpc-web',
  'application/grpc-web+proto',
  'application/vnd.google.protobuf',
];

export interface ProtobufInfo {
  /** Whether the request carries protobuf */
  isRequest: boolean;
  /** Whether the response carries protobuf */
  isResponse: boolean;
  /** Whether this is a gRPC call */
  isGrpc: boolean;
  /** Detected content-type value */
  contentType: string | null;
}

/**
 * Detect if a traffic entry involves protobuf based on Content-Type headers.
 * Returns null if no protobuf detected.
 */
export function detectProtobuf(
  requestHeaders: string | null,
  responseHeaders: string | null,
): ProtobufInfo | null {
  const reqCt = extractContentType(requestHeaders);
  const resCt = extractContentType(responseHeaders);

  const reqIsProto = isProtobufContentType(reqCt);
  const resIsProto = isProtobufContentType(resCt);

  if (!reqIsProto && !resIsProto) return null;

  const ct = reqIsProto ? reqCt : resCt;
  const isGrpc = (reqCt || '').includes('grpc') || (resCt || '').includes('grpc');

  return {
    isRequest: reqIsProto,
    isResponse: resIsProto,
    isGrpc,
    contentType: ct,
  };
}

function extractContentType(headersJson: string | null): string | null {
  if (!headersJson) return null;
  try {
    const parsed = JSON.parse(headersJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Headers may be case-insensitive
    for (const [key, value] of Object.entries(parsed)) {
      if (key.toLowerCase() === 'content-type') {
        return String(value).toLowerCase();
      }
    }
  } catch {}
  return null;
}

function isProtobufContentType(ct: string | null): boolean {
  if (!ct) return false;
  return PROTOBUF_CONTENT_TYPES.some(proto => ct.includes(proto));
}

// --- Schema-less protobuf decoder ---

/** Wire types in the protobuf binary format. */
const WIRE_TYPES = {
  VARINT: 0,
  FIXED64: 1,
  LENGTH_DELIMITED: 2,
  START_GROUP: 3,
  END_GROUP: 4,
  FIXED32: 5,
} as const;

const WIRE_TYPE_NAMES: Record<number, string> = {
  0: 'varint',
  1: 'fixed64',
  2: 'bytes',
  3: 'start_group',
  4: 'end_group',
  5: 'fixed32',
};

export interface DecodedProtobufField {
  fieldNumber: number;
  wireType: number;
  wireTypeName: string;
  value: string | number | bigint | DecodedProtobufField[];
  /** For length-delimited fields, raw bytes as hex if not a sub-message or string */
  rawHex?: string;
  /** Interpretation hints */
  interpretation?: string;
}

/**
 * Strip gRPC frame header (1-byte compressed flag + 4-byte message length) if present.
 * Returns the payload bytes without the frame prefix.
 */
export function stripGrpcFrame(data: Uint8Array): Uint8Array {
  if (data.length < 5) return data;
  const compressedFlag = data[0];
  // Compressed flag must be 0 (uncompressed) or 1 (compressed)
  if (compressedFlag > 1) return data;
  const messageLength =
    (data[1] << 24) | (data[2] << 16) | (data[3] << 8) | data[4];
  if (messageLength === data.length - 5) {
    return data.subarray(5);
  }
  return data;
}

/**
 * Decode a base64-encoded protobuf payload without a schema.
 * Returns an array of decoded fields, or null if the data doesn't look like valid protobuf.
 * Automatically strips gRPC frame headers if present.
 */
export function decodeProtobufSchemaless(base64Data: string, isGrpc?: boolean): DecodedProtobufField[] | null {
  try {
    let bytes = base64ToUint8Array(base64Data);
    if (isGrpc) {
      bytes = stripGrpcFrame(bytes);
    }
    return decodeProtobufBytes(bytes, 0, bytes.length);
  } catch {
    return null;
  }
}

/**
 * Decode raw protobuf bytes without a schema.
 */
export function decodeProtobufBytes(
  data: Uint8Array,
  offset: number,
  end: number,
  depth: number = 0,
): DecodedProtobufField[] | null {
  if (depth > 10) return null; // Prevent infinite recursion

  const fields: DecodedProtobufField[] = [];
  let pos = offset;

  while (pos < end) {
    const tagResult = readVarint(data, pos, end);
    if (!tagResult) return fields.length > 0 ? fields : null;

    const tag = Number(tagResult.value);
    pos = tagResult.newPos;

    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (fieldNumber === 0 || fieldNumber > 536870911) {
      return fields.length > 0 ? fields : null;
    }

    const wireTypeName = WIRE_TYPE_NAMES[wireType] || 'unknown';

    switch (wireType) {
      case WIRE_TYPES.VARINT: {
        const result = readVarint(data, pos, end);
        if (!result) return fields.length > 0 ? fields : null;
        pos = result.newPos;
        const num = Number(result.value);
        const interpretation = guessVarintMeaning(result.value);
        fields.push({
          fieldNumber,
          wireType,
          wireTypeName,
          value: num <= Number.MAX_SAFE_INTEGER ? num : result.value,
          interpretation,
        });
        break;
      }

      case WIRE_TYPES.FIXED64: {
        if (pos + 8 > end) return fields.length > 0 ? fields : null;
        const view = new DataView(data.buffer, data.byteOffset + pos, 8);
        const lo = view.getUint32(0, true);
        const hi = view.getUint32(4, true);
        pos += 8;
        const asDouble = view.getFloat64(0, true);
        const asInt = BigInt(hi) * BigInt(0x100000000) + BigInt(lo);
        // Use double if it looks like a reasonable float
        const interpretation = isReasonableDouble(asDouble) ? `double: ${asDouble}` : undefined;
        fields.push({
          fieldNumber,
          wireType,
          wireTypeName,
          value: Number(asInt),
          interpretation,
        });
        break;
      }

      case WIRE_TYPES.LENGTH_DELIMITED: {
        const lenResult = readVarint(data, pos, end);
        if (!lenResult) return fields.length > 0 ? fields : null;
        const len = Number(lenResult.value);
        pos = lenResult.newPos;
        if (pos + len > end) return fields.length > 0 ? fields : null;

        const subData = data.subarray(pos, pos + len);
        pos += len;

        // Try to decode as nested protobuf message
        const nested = decodeProtobufBytes(data, pos - len, pos, depth + 1);
        if (nested && nested.length > 0 && isLikelyProtobuf(nested, subData)) {
          fields.push({
            fieldNumber,
            wireType,
            wireTypeName,
            value: nested,
          });
        } else {
          // Try as UTF-8 string
          const str = tryDecodeUtf8(subData);
          if (str !== null && isPrintableString(str)) {
            fields.push({
              fieldNumber,
              wireType,
              wireTypeName,
              value: str,
              interpretation: 'string',
            });
          } else {
            // Raw bytes
            fields.push({
              fieldNumber,
              wireType,
              wireTypeName,
              value: `(${len} bytes)`,
              rawHex: bytesToHex(subData.subarray(0, Math.min(len, 64))),
              interpretation: len > 64 ? `bytes (showing first 64 of ${len})` : 'bytes',
            });
          }
        }
        break;
      }

      case WIRE_TYPES.FIXED32: {
        if (pos + 4 > end) return fields.length > 0 ? fields : null;
        const view = new DataView(data.buffer, data.byteOffset + pos, 4);
        const asUint = view.getUint32(0, true);
        const asFloat = view.getFloat32(0, true);
        pos += 4;
        const interpretation = isReasonableFloat(asFloat) ? `float: ${asFloat}` : undefined;
        fields.push({
          fieldNumber,
          wireType,
          wireTypeName,
          value: asUint,
          interpretation,
        });
        break;
      }

      case WIRE_TYPES.START_GROUP:
      case WIRE_TYPES.END_GROUP:
        // Deprecated, skip
        fields.push({
          fieldNumber,
          wireType,
          wireTypeName,
          value: '(group)',
        });
        break;

      default:
        return fields.length > 0 ? fields : null;
    }
  }

  return fields.length > 0 ? fields : null;
}

function readVarint(
  data: Uint8Array,
  pos: number,
  end: number,
): { value: bigint; newPos: number } | null {
  let result = BigInt(0);
  let shift = 0;

  for (let i = 0; i < 10; i++) {
    if (pos >= end) return null;
    const byte = data[pos++];
    result |= BigInt(byte & 0x7f) << BigInt(shift);
    if ((byte & 0x80) === 0) {
      return { value: result, newPos: pos };
    }
    shift += 7;
  }
  return null; // Varint too long
}

function guessVarintMeaning(value: bigint): string | undefined {
  const num = Number(value);
  // Check if it could be a boolean
  if (num === 0 || num === 1) return num === 1 ? 'true' : 'false';
  // Check if it could be a signed int (zigzag)
  const zigzag = Number((value >> BigInt(1)) ^ -(value & BigInt(1)));
  if (zigzag !== num && Math.abs(zigzag) < 1e9) return `sint: ${zigzag}`;
  // Check if it could be a timestamp (seconds since epoch, roughly 2000-2040)
  if (num > 946684800 && num < 2208988800) {
    return `timestamp: ${new Date(num * 1000).toISOString()}`;
  }
  // Millisecond timestamp
  if (num > 946684800000 && num < 2208988800000) {
    return `timestamp_ms: ${new Date(num).toISOString()}`;
  }
  return undefined;
}

function isReasonableDouble(d: number): boolean {
  if (!isFinite(d) || isNaN(d)) return false;
  if (d === 0) return false;
  const abs = Math.abs(d);
  return abs > 1e-10 && abs < 1e15;
}

function isReasonableFloat(f: number): boolean {
  if (!isFinite(f) || isNaN(f)) return false;
  if (f === 0) return false;
  const abs = Math.abs(f);
  return abs > 1e-6 && abs < 1e10;
}

function tryDecodeUtf8(data: Uint8Array): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return decoder.decode(data);
  } catch {
    return null;
  }
}

function isPrintableString(str: string): boolean {
  if (str.length === 0) return false;
  // Allow printable ASCII, common unicode, whitespace
  return /^[\x20-\x7E\t\n\r\u00A0-\uFFFF]+$/.test(str);
}

function bytesToHex(data: Uint8Array): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

function isLikelyProtobuf(fields: DecodedProtobufField[], rawData: Uint8Array): boolean {
  // Heuristic: if we decoded fields and consumed most of the data,
  // and field numbers are reasonable, it's likely protobuf
  if (fields.length === 0) return false;

  // Check field numbers are sequential-ish (not random)
  const fieldNums = fields.map(f => f.fieldNumber);
  const maxField = Math.max(...fieldNums);

  // If field numbers are all very large, probably not a message
  if (maxField > 1000) return false;

  // If there's only one field and it's a string, prefer string interpretation
  if (fields.length === 1 && typeof fields[0].value === 'string') return false;

  return true;
}

function base64ToUint8Array(b64: string): Uint8Array {
  // Handle both standard and URL-safe base64
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Format decoded protobuf fields into a readable tree string.
 */
export function formatProtobufTree(
  fields: DecodedProtobufField[],
  indent: number = 0,
): string {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];

  for (const field of fields) {
    if (Array.isArray(field.value)) {
      lines.push(`${prefix}field ${field.fieldNumber} {`);
      lines.push(formatProtobufTree(field.value, indent + 1));
      lines.push(`${prefix}}`);
    } else {
      let line = `${prefix}field ${field.fieldNumber} [${field.wireTypeName}]: ${field.value}`;
      if (field.interpretation) {
        line += `  // ${field.interpretation}`;
      }
      if (field.rawHex) {
        line += `\n${prefix}  hex: ${field.rawHex}`;
      }
      lines.push(line);
    }
  }

  return lines.join('\n');
}
