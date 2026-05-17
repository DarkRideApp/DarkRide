import { describe, it, expect } from 'vitest';
import { parseNalUnits, NalType } from './nal-parser';

const sc4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const sc3 = Buffer.from([0x00, 0x00, 0x01]);

function nalHeader(type: number): Buffer {
  // forbidden_zero_bit=0, nal_ref_idc=3 (binary 11), nal_unit_type=type
  return Buffer.from([(0x60 | (type & 0x1f))]);
}

describe('parseNalUnits', () => {
  it('extracts a single NAL unit with 4-byte start code', () => {
    const payload = Buffer.from([0x42, 0x43]);
    const stream = Buffer.concat([sc4, nalHeader(7), payload]);
    const units = parseNalUnits(stream);
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe(NalType.SPS);
    expect(units[0].data.length).toBe(3); // header + payload (no start code)
  });

  it('extracts multiple NAL units with mixed 3- and 4-byte start codes', () => {
    const stream = Buffer.concat([
      sc4, nalHeader(7), Buffer.from([0x01]),
      sc3, nalHeader(8), Buffer.from([0x02]),
      sc4, nalHeader(5), Buffer.from([0x03, 0x04]),
    ]);
    const units = parseNalUnits(stream);
    expect(units.map(u => u.type)).toEqual([NalType.SPS, NalType.PPS, NalType.IDR]);
  });

  it('classifies non-IDR slice (type 1) as NON_IDR', () => {
    const stream = Buffer.concat([sc4, nalHeader(1), Buffer.from([0xaa])]);
    const units = parseNalUnits(stream);
    expect(units[0].type).toBe(NalType.NON_IDR);
  });

  it('returns empty array for input without start codes', () => {
    expect(parseNalUnits(Buffer.from([0x01, 0x02, 0x03]))).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(parseNalUnits(Buffer.alloc(0))).toEqual([]);
  });

  it('extracts NAL unit with a 3-byte start code and single-byte payload', () => {
    const stream = Buffer.concat([sc3, nalHeader(7)]);
    const units = parseNalUnits(stream);
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe(NalType.SPS);
  });

  it('does not split on emulation prevention byte 0x000003 inside NAL payload', () => {
    const epbPayload = Buffer.from([0x00, 0x00, 0x03, 0x01]);
    const stream = Buffer.concat([sc4, nalHeader(7), epbPayload]);
    const units = parseNalUnits(stream);
    expect(units).toHaveLength(1);
    expect(units[0].data.length).toBe(5); // header + 4 payload bytes
  });
});
