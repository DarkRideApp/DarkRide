import { describe, it, expect } from 'vitest';
import {
  detectProtobuf,
  decodeProtobufSchemaless,
  decodeProtobufBytes,
  formatProtobufTree,
  stripGrpcFrame,
  type DecodedProtobufField,
} from '../../shared/lib/protobuf-detect';

// Helper: build JSON headers string with a given content-type
function headers(contentType: string): string {
  return JSON.stringify({ 'Content-Type': contentType });
}

// Helper: encode a Uint8Array to base64
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// Helper: build a simple protobuf varint field (field 1, varint wire type 0, value 150)
// Tag: (1 << 3) | 0 = 0x08, Value: 150 = 0x96 0x01
const SIMPLE_PROTOBUF = new Uint8Array([0x08, 0x96, 0x01]);

// Helper: build a protobuf with a string field
// Field 2, wire type 2 (length-delimited), value "Hello, World!"
// Tag: (2 << 3) | 2 = 0x12, Length: 13
const STRING_PROTOBUF = new Uint8Array([
  0x12, 0x0d,
  0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x2c, 0x20,
  0x57, 0x6f, 0x72, 0x6c, 0x64, 0x21,
]);

// Helper: build a protobuf with multiple fields
// Field 1 varint 42, Field 2 string "test"
const MULTI_FIELD_PROTOBUF = new Uint8Array([
  0x08, 0x2a, // field 1, varint, value 42
  0x12, 0x04, 0x74, 0x65, 0x73, 0x74, // field 2, string "test"
]);

// Helper: wrap payload in gRPC frame (0x00 + 4-byte big-endian length + payload)
function wrapGrpcFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0x00; // not compressed
  frame[1] = (payload.length >> 24) & 0xff;
  frame[2] = (payload.length >> 16) & 0xff;
  frame[3] = (payload.length >> 8) & 0xff;
  frame[4] = payload.length & 0xff;
  frame.set(payload, 5);
  return frame;
}

// ── detectProtobuf ──────────────────────────────────────────────────

describe('detectProtobuf', () => {
  it('returns null when no protobuf content-type is present', () => {
    expect(detectProtobuf(headers('application/json'), headers('text/html'))).toBeNull();
  });

  it('returns null when headers are null', () => {
    expect(detectProtobuf(null, null)).toBeNull();
  });

  it('detects protobuf in request content-type', () => {
    const result = detectProtobuf(headers('application/x-protobuf'), headers('application/json'));
    expect(result).not.toBeNull();
    expect(result!.isRequest).toBe(true);
    expect(result!.isResponse).toBe(false);
    expect(result!.isGrpc).toBe(false);
  });

  it('detects protobuf in response content-type', () => {
    const result = detectProtobuf(headers('application/json'), headers('application/protobuf'));
    expect(result).not.toBeNull();
    expect(result!.isRequest).toBe(false);
    expect(result!.isResponse).toBe(true);
  });

  it('detects protobuf in both request and response', () => {
    const result = detectProtobuf(headers('application/x-protobuf'), headers('application/protobuf'));
    expect(result).not.toBeNull();
    expect(result!.isRequest).toBe(true);
    expect(result!.isResponse).toBe(true);
  });

  it('detects gRPC from request content-type', () => {
    const result = detectProtobuf(headers('application/grpc'), headers('application/json'));
    expect(result).not.toBeNull();
    expect(result!.isGrpc).toBe(true);
  });

  it('detects gRPC from response content-type', () => {
    const result = detectProtobuf(headers('application/x-protobuf'), headers('application/grpc'));
    expect(result).not.toBeNull();
    expect(result!.isGrpc).toBe(true);
    expect(result!.isRequest).toBe(true);
    expect(result!.isResponse).toBe(true);
  });

  it('detects grpc-web content types', () => {
    const result = detectProtobuf(headers('application/grpc-web'), null);
    expect(result).not.toBeNull();
    expect(result!.isGrpc).toBe(true);
  });

  it('detects grpc-web+proto content types', () => {
    const result = detectProtobuf(headers('application/grpc-web+proto'), null);
    expect(result).not.toBeNull();
    expect(result!.isGrpc).toBe(true);
  });

  it('detects application/grpc+proto', () => {
    const result = detectProtobuf(null, headers('application/grpc+proto'));
    expect(result).not.toBeNull();
    expect(result!.isGrpc).toBe(true);
  });

  it('detects vnd.google.protobuf', () => {
    const result = detectProtobuf(headers('application/vnd.google.protobuf'), null);
    expect(result).not.toBeNull();
    expect(result!.isGrpc).toBe(false);
  });

  it('is case-insensitive for header keys', () => {
    const h = JSON.stringify({ 'content-type': 'application/x-protobuf' });
    const result = detectProtobuf(h, null);
    expect(result).not.toBeNull();
    expect(result!.isRequest).toBe(true);
  });

  it('handles malformed JSON headers gracefully', () => {
    expect(detectProtobuf('not json', null)).toBeNull();
    expect(detectProtobuf('{invalid', headers('application/json'))).toBeNull();
  });

  it('isGrpc is true when request is protobuf but response is grpc', () => {
    const result = detectProtobuf(headers('application/x-protobuf'), headers('application/grpc'));
    expect(result).not.toBeNull();
    expect(result!.isGrpc).toBe(true);
  });
});

// ── stripGrpcFrame ──────────────────────────────────────────────────

describe('stripGrpcFrame', () => {
  it('strips a valid gRPC frame header', () => {
    const framed = wrapGrpcFrame(SIMPLE_PROTOBUF);
    const stripped = stripGrpcFrame(framed);
    expect(stripped).toEqual(SIMPLE_PROTOBUF);
  });

  it('returns data unchanged if too short for gRPC frame', () => {
    const short = new Uint8Array([0x08, 0x01]);
    expect(stripGrpcFrame(short)).toEqual(short);
  });

  it('returns data unchanged if compressed flag is invalid', () => {
    const bad = new Uint8Array([0x05, 0x00, 0x00, 0x00, 0x03, 0x08, 0x96, 0x01]);
    expect(stripGrpcFrame(bad)).toEqual(bad);
  });

  it('returns data unchanged if length does not match', () => {
    const mismatch = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x99, 0x08, 0x96, 0x01]);
    expect(stripGrpcFrame(mismatch)).toEqual(mismatch);
  });

  it('handles compressed flag = 1', () => {
    const payload = SIMPLE_PROTOBUF;
    const frame = new Uint8Array(5 + payload.length);
    frame[0] = 0x01; // compressed
    frame[4] = payload.length;
    frame.set(payload, 5);
    const stripped = stripGrpcFrame(frame);
    expect(stripped).toEqual(payload);
  });
});

// ── decodeProtobufSchemaless ────────────────────────────────────────

describe('decodeProtobufSchemaless', () => {
  it('decodes a simple varint field', () => {
    const fields = decodeProtobufSchemaless(toBase64(SIMPLE_PROTOBUF));
    expect(fields).not.toBeNull();
    expect(fields!.length).toBe(1);
    expect(fields![0].fieldNumber).toBe(1);
    expect(fields![0].wireType).toBe(0);
    expect(fields![0].value).toBe(150);
  });

  it('decodes multiple fields including strings', () => {
    const fields = decodeProtobufSchemaless(toBase64(MULTI_FIELD_PROTOBUF));
    expect(fields).not.toBeNull();
    expect(fields!.length).toBe(2);
    expect(fields![0].fieldNumber).toBe(1);
    expect(fields![0].value).toBe(42);
    expect(fields![1].fieldNumber).toBe(2);
    expect(fields![1].value).toBe('test');
  });

  it('returns null for invalid base64', () => {
    expect(decodeProtobufSchemaless('!!!invalid!!!')).toBeNull();
  });

  it('returns null for empty data', () => {
    expect(decodeProtobufSchemaless(toBase64(new Uint8Array([])))).toBeNull();
  });

  it('strips gRPC frame when isGrpc is true', () => {
    const framed = wrapGrpcFrame(SIMPLE_PROTOBUF);
    const fields = decodeProtobufSchemaless(toBase64(framed), true);
    expect(fields).not.toBeNull();
    expect(fields!.length).toBe(1);
    expect(fields![0].fieldNumber).toBe(1);
    expect(fields![0].value).toBe(150);
  });

  it('does not strip gRPC frame when isGrpc is false', () => {
    // The gRPC-framed data should still attempt to decode as raw protobuf
    // (may produce different/garbage results or null depending on the bytes)
    const framed = wrapGrpcFrame(SIMPLE_PROTOBUF);
    const fields = decodeProtobufSchemaless(toBase64(framed), false);
    // Without stripping, the decoded fields will differ from the actual payload
    if (fields) {
      // Should NOT cleanly decode as field 1 = 150
      const hasCorrectField = fields.some(f => f.fieldNumber === 1 && f.value === 150);
      expect(hasCorrectField).toBe(false);
    }
  });

  it('handles URL-safe base64', () => {
    const b64 = toBase64(SIMPLE_PROTOBUF).replace(/\+/g, '-').replace(/\//g, '_');
    const fields = decodeProtobufSchemaless(b64);
    expect(fields).not.toBeNull();
    expect(fields![0].value).toBe(150);
  });
});

// ── decodeProtobufBytes edge cases ──────────────────────────────────

describe('decodeProtobufBytes', () => {
  it('handles nested protobuf messages', () => {
    // Field 1 = message { field 1 = varint 42 }
    // Inner: 0x08 0x2a (field 1 varint 42)
    // Outer: field 3 length-delimited, length 2, inner bytes
    const nested = new Uint8Array([
      0x1a, 0x02, // field 3, length 2
      0x08, 0x2a, // inner field 1, varint 42
    ]);
    const fields = decodeProtobufBytes(nested, 0, nested.length);
    expect(fields).not.toBeNull();
    expect(fields!.length).toBe(1);
    expect(fields![0].fieldNumber).toBe(3);
    // Value should be nested fields array
    expect(Array.isArray(fields![0].value)).toBe(true);
  });

  it('respects max recursion depth', () => {
    // Should return null at excessive depth
    const result = decodeProtobufBytes(SIMPLE_PROTOBUF, 0, SIMPLE_PROTOBUF.length, 11);
    expect(result).toBeNull();
  });

  it('decodes fixed32 fields', () => {
    // Field 5, wire type 5 (fixed32), value
    // Tag: (5 << 3) | 5 = 0x2d
    const data = new Uint8Array([0x2d, 0x01, 0x00, 0x00, 0x00]);
    const fields = decodeProtobufBytes(data, 0, data.length);
    expect(fields).not.toBeNull();
    expect(fields![0].fieldNumber).toBe(5);
    expect(fields![0].wireTypeName).toBe('fixed32');
    expect(fields![0].value).toBe(1);
  });

  it('decodes fixed64 fields', () => {
    // Field 3, wire type 1 (fixed64)
    // Tag: (3 << 3) | 1 = 0x19
    const data = new Uint8Array([0x19, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const fields = decodeProtobufBytes(data, 0, data.length);
    expect(fields).not.toBeNull();
    expect(fields![0].fieldNumber).toBe(3);
    expect(fields![0].wireTypeName).toBe('fixed64');
  });

  it('handles raw bytes for non-string length-delimited fields', () => {
    // Field 4, wire type 2, length 3, binary data that is not valid UTF-8
    const data = new Uint8Array([0x22, 0x03, 0xff, 0xfe, 0xfd]);
    const fields = decodeProtobufBytes(data, 0, data.length);
    expect(fields).not.toBeNull();
    expect(fields![0].fieldNumber).toBe(4);
    expect(fields![0].rawHex).toBeDefined();
  });

  it('rejects field number 0', () => {
    // Tag with field number 0 is invalid
    const data = new Uint8Array([0x00]);
    const fields = decodeProtobufBytes(data, 0, data.length);
    expect(fields).toBeNull();
  });
});

// ── formatProtobufTree ──────────────────────────────────────────────

describe('formatProtobufTree', () => {
  it('formats a simple field', () => {
    const fields: DecodedProtobufField[] = [
      { fieldNumber: 1, wireType: 0, wireTypeName: 'varint', value: 150 },
    ];
    const tree = formatProtobufTree(fields);
    expect(tree).toContain('field 1');
    expect(tree).toContain('varint');
    expect(tree).toContain('150');
  });

  it('formats nested fields with indentation', () => {
    const fields: DecodedProtobufField[] = [
      {
        fieldNumber: 2,
        wireType: 2,
        wireTypeName: 'bytes',
        value: [
          { fieldNumber: 1, wireType: 0, wireTypeName: 'varint', value: 42 },
        ],
      },
    ];
    const tree = formatProtobufTree(fields);
    expect(tree).toContain('field 2 {');
    expect(tree).toContain('  field 1');
    expect(tree).toContain('}');
  });

  it('includes interpretation comments', () => {
    const fields: DecodedProtobufField[] = [
      { fieldNumber: 1, wireType: 0, wireTypeName: 'varint', value: 1, interpretation: 'true' },
    ];
    const tree = formatProtobufTree(fields);
    expect(tree).toContain('// true');
  });

  it('includes raw hex for byte fields', () => {
    const fields: DecodedProtobufField[] = [
      { fieldNumber: 1, wireType: 2, wireTypeName: 'bytes', value: '(3 bytes)', rawHex: 'ff fe fd', interpretation: 'bytes' },
    ];
    const tree = formatProtobufTree(fields);
    expect(tree).toContain('hex: ff fe fd');
  });
});
