import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../../test-utils/create-test-db';
import { adbProxyDevices, deviceInstances, devices } from '../../db/schema';
import { PortAllocator, PortError } from './port-allocator';

function setup(range = { start: 6500, end: 6502 }) {
  const db = createTestDb([deviceInstances, devices, adbProxyDevices], { foreignKeys: true });
  for (const id of ['A', 'B', 'C', 'D']) db.insert(devices).values({ id }).run();
  let current = range;
  const alloc = new PortAllocator(db, () => current, () => new Date('2026-10-11T10:00:00Z'));
  return { db, alloc, setRange: (r: typeof range) => { current = r; } };
}

const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { return e instanceof PortError ? e.code : 'other-error'; }
  return 'no-throw';
};

describe('PortAllocator', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  it('hands out the lowest free port and enables the device', () => {
    const a = ctx.alloc.ensure('A');
    expect(a).toMatchObject({ deviceId: 'A', port: 6500, enabled: true });
    expect(ctx.alloc.ensure('B')).toMatchObject({ port: 6501 });
  });

  it('reuses the lowest free port once an earlier one is vacated', () => {
    ctx.alloc.ensure('A');
    ctx.alloc.setPort('A', 6502);
    expect(ctx.alloc.ensure('B')).toMatchObject({ port: 6500 });
  });

  it('returns the same port for the same device, including from a new allocator', () => {
    const first = ctx.alloc.ensure('A') as { port: number };
    expect((ctx.alloc.ensure('A') as { port: number }).port).toBe(first.port);
    const again = new PortAllocator(ctx.db, () => ({ start: 6500, end: 6502 }));
    expect((again.ensure('A') as { port: number }).port).toBe(first.port);
  });

  it('reports range-full when every port is taken', () => {
    ctx.alloc.ensure('A'); ctx.alloc.ensure('B'); ctx.alloc.ensure('C');
    expect(ctx.alloc.ensure('D')).toEqual({ error: 'range-full' });
    expect(ctx.alloc.get('D')).toBeUndefined();
  });

  it('hasFree is false only while every port in range is taken, and allocates nothing', () => {
    expect(ctx.alloc.hasFree()).toBe(true);
    ctx.alloc.ensure('A'); ctx.alloc.ensure('B'); ctx.alloc.ensure('C');
    expect(ctx.alloc.hasFree()).toBe(false);
    ctx.db.delete(adbProxyDevices).where(eq(adbProxyDevices.deviceId, 'B')).run();
    expect(ctx.alloc.hasFree()).toBe(true);
    expect(ctx.alloc.all().map((r) => r.deviceId)).toEqual(['A', 'C']);
  });

  it('hasFree ignores a port held outside the range', () => {
    ctx.alloc.ensure('A'); ctx.alloc.ensure('B'); ctx.alloc.ensure('C');
    ctx.setRange({ start: 7000, end: 7000 });
    expect(ctx.alloc.hasFree()).toBe(true);
  });

  it('throws for a device that is not in the devices table', () => {
    expect(() => ctx.alloc.ensure('NOPE')).toThrow(/FOREIGN KEY/);
    expect(ctx.alloc.all()).toEqual([]);
  });

  it('keeps existing ports when the range later changes', () => {
    ctx.alloc.ensure('A');
    ctx.setRange({ start: 7000, end: 7001 });
    expect((ctx.alloc.ensure('A') as { port: number }).port).toBe(6500);
    expect((ctx.alloc.ensure('B') as { port: number }).port).toBe(7000);
  });

  it('setPort moves a device to a free in-range port', () => {
    ctx.alloc.ensure('A');
    expect(ctx.alloc.setPort('A', 6502)?.port).toBe(6502);
    expect(ctx.alloc.get('A')?.port).toBe(6502);
  });

  it('setPort accepts the device\'s own current port', () => {
    ctx.alloc.ensure('A');
    expect(ctx.alloc.setPort('A', 6500)?.port).toBe(6500);
  });

  it('setPort rejects a port outside the range and a port another device holds', () => {
    ctx.alloc.ensure('A'); ctx.alloc.ensure('B');
    expect(codeOf(() => ctx.alloc.setPort('A', 6501))).toBe('in-use');
    expect(codeOf(() => ctx.alloc.setPort('A', 9000))).toBe('out-of-range');
    expect(ctx.alloc.get('A')?.port).toBe(6500);
  });

  it.each([[6500.5], [Number.NaN], [Number.POSITIVE_INFINITY]])('setPort rejects the non-integer port %s', (port) => {
    ctx.alloc.ensure('A');
    expect(codeOf(() => ctx.alloc.setPort('A', port))).toBe('out-of-range');
    expect(ctx.alloc.get('A')?.port).toBe(6500);
  });

  it('setPort returns undefined and writes nothing for a device with no row', () => {
    expect(ctx.alloc.setPort('D', 6501)).toBeUndefined();
    expect(ctx.alloc.all()).toEqual([]);
  });

  it('setPort checks the range and ownership before it looks for the device row', () => {
    ctx.alloc.ensure('A');
    expect(codeOf(() => ctx.alloc.setPort('D', 9000))).toBe('out-of-range');
    expect(codeOf(() => ctx.alloc.setPort('D', 6500))).toBe('in-use');
  });

  it('setEnabled flips the flag and returns undefined for an unknown device', () => {
    ctx.alloc.ensure('A');
    expect(ctx.alloc.setEnabled('A', false)?.enabled).toBe(false);
    expect(ctx.alloc.setEnabled('NOPE', false)).toBeUndefined();
  });

  it('lists every row', () => {
    ctx.alloc.ensure('A'); ctx.alloc.ensure('B');
    expect(ctx.alloc.all().map((r) => r.deviceId)).toEqual(['A', 'B']);
  });
});
