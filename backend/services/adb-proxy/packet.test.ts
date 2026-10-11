import { describe, it, expect } from 'vitest';
import {
  A_AUTH, A_CNXN, A_WRTE, HEADER_SIZE,
  PacketError, PacketParser, commandName, encodePacket, isKnownCommand,
} from './packet';

describe('encodePacket', () => {
  it('writes a 24-byte little-endian header, the byte-sum checksum and the magic', () => {
    const data = Buffer.from([1, 2, 3, 250]);
    const buf = encodePacket({ command: A_WRTE, arg0: 7, arg1: 9, data });
    expect(buf.length).toBe(HEADER_SIZE + 4);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('WRTE');
    expect(buf.readUInt32LE(4)).toBe(7);
    expect(buf.readUInt32LE(8)).toBe(9);
    expect(buf.readUInt32LE(12)).toBe(4);
    expect(buf.readUInt32LE(16)).toBe(1 + 2 + 3 + 250);
    expect(buf.readUInt32LE(20)).toBe((A_WRTE ^ 0xffffffff) >>> 0);
    expect(buf.subarray(HEADER_SIZE)).toEqual(data);
  });

  it('encodes an empty payload as a bare header', () => {
    const buf = encodePacket({ command: A_CNXN, arg0: 1, arg1: 2 });
    expect(buf.length).toBe(HEADER_SIZE);
    expect(buf.readUInt32LE(12)).toBe(0);
  });
});

describe('PacketParser', () => {
  it('round-trips a packet', () => {
    const parser = new PacketParser(1024);
    const [p] = parser.push(encodePacket({ command: A_AUTH, arg0: 2, arg1: 0, data: Buffer.from('sig') }));
    expect(p.command).toBe(A_AUTH);
    expect(p.arg0).toBe(2);
    expect(p.data.toString()).toBe('sig');
  });

  it('reassembles a packet delivered one byte at a time', () => {
    const parser = new PacketParser(1024);
    const wire = encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.from('hello world') });
    const out = [];
    for (const byte of wire) out.push(...parser.push(Buffer.from([byte])));
    expect(out).toHaveLength(1);
    expect(out[0].data.toString()).toBe('hello world');
  });

  it('splits two packets that arrive in one chunk', () => {
    const parser = new PacketParser(1024);
    const wire = Buffer.concat([
      encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.from('a') }),
      encodePacket({ command: A_WRTE, arg0: 3, arg1: 4, data: Buffer.from('bb') }),
    ]);
    const out = parser.push(wire);
    expect(out.map((p) => p.data.toString())).toEqual(['a', 'bb']);
  });

  it('keeps a partial trailing packet until the rest arrives', () => {
    const parser = new PacketParser(1024);
    const first = encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.from('a') });
    const second = encodePacket({ command: A_WRTE, arg0: 3, arg1: 4, data: Buffer.from('bb') });
    const wire = Buffer.concat([first, second]);
    expect(parser.push(wire.subarray(0, first.length + 10))).toHaveLength(1);
    expect(parser.push(wire.subarray(first.length + 10))).toHaveLength(1);
  });

  it('rejects a bad magic', () => {
    const parser = new PacketParser(1024);
    const wire = encodePacket({ command: A_CNXN, arg0: 1, arg1: 2 });
    wire.writeUInt32LE(0, 20);
    expect(() => parser.push(wire)).toThrow(PacketError);
  });

  it('rejects an oversize payload from the header alone, before the body arrives', () => {
    const parser = new PacketParser(16);
    const wire = encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.alloc(17) });
    expect(() => parser.push(wire.subarray(0, HEADER_SIZE))).toThrow(PacketError);
  });

  it('honours a raised limit', () => {
    const parser = new PacketParser(16);
    parser.setMaxPayload(64);
    const wire = encodePacket({ command: A_WRTE, arg0: 1, arg1: 2, data: Buffer.alloc(40) });
    expect(parser.push(wire)).toHaveLength(1);
  });

  it('passes an unknown command through for the caller to decide', () => {
    const parser = new PacketParser(1024);
    const wire = encodePacket({ command: 0x12345678, arg0: 0, arg1: 0 });
    const [p] = parser.push(wire);
    expect(p.command).toBe(0x12345678);
    expect(isKnownCommand(p.command)).toBe(false);
    expect(commandName(p.command)).toBe('0x12345678');
  });
});
