import { describe, it, expect } from 'vitest';
import { inferResponseSpec } from './response-spec-inferrer';

describe('inferResponseSpec', () => {
  it('returns null for empty input', () => {
    expect(inferResponseSpec([])).toBeNull();
  });

  it('returns null when all bodies fail to parse', () => {
    expect(inferResponseSpec(['not json', 'also not json', ''])).toBeNull();
  });

  it('skips non-JSON bodies and processes valid ones', () => {
    const result = inferResponseSpec(['not json', '{"ok":true}']);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('object');
  });

  it('infers correct types from a single simple object', () => {
    const body = JSON.stringify({ success: true, count: 5, name: 'Alice', score: 9.5 });
    const result = inferResponseSpec([body]);

    expect(result!.type).toBe('object');
    expect(result!.properties!.success.type).toBe('boolean');
    expect(result!.properties!.count.type).toBe('number');
    expect(result!.properties!.name.type).toBe('string');
    expect(result!.properties!.name.examples).toEqual(['Alice']);
    expect(result!.properties!.score.type).toBe('number');
    expect(result!.properties!.score.min).toBe(9.5);
    expect(result!.properties!.score.max).toBe(9.5);
  });

  it('marks fields as required when present in all responses', () => {
    const bodies = [
      JSON.stringify({ id: 1, name: 'Alice', email: 'alice@example.com' }),
      JSON.stringify({ id: 2, name: 'Bob' }),
    ];
    const result = inferResponseSpec(bodies);

    expect(result!.properties!.id.required).toBe(true);
    expect(result!.properties!.name.required).toBe(true);
    expect(result!.properties!.email.required).toBe(false);
  });

  it('detects optional fields when missing from some responses', () => {
    const bodies = [
      JSON.stringify({ a: 1 }),
      JSON.stringify({ a: 2 }),
      JSON.stringify({ a: 3, b: 'hello' }),
    ];
    const result = inferResponseSpec(bodies);

    expect(result!.properties!.a.required).toBe(true);
    expect(result!.properties!.b.required).toBe(false);
  });

  it('infers nested object types', () => {
    const bodies = [
      JSON.stringify({ data: { id: 1, name: 'Alice' } }),
      JSON.stringify({ data: { id: 2, name: 'Bob' } }),
    ];
    const result = inferResponseSpec(bodies);

    const data = result!.properties!.data;
    expect(data.type).toBe('object');
    expect(data.required).toBe(true);
    expect(data.properties!.id.type).toBe('number');
    expect(data.properties!.name.type).toBe('string');
  });

  it('infers array item types', () => {
    const bodies = [
      JSON.stringify({ roles: ['admin', 'user'] }),
      JSON.stringify({ roles: ['viewer'] }),
    ];
    const result = inferResponseSpec(bodies);

    const roles = result!.properties!.roles;
    expect(roles.type).toBe('array');
    expect(roles.items).toBeDefined();
    expect(roles.items!.type).toBe('string');
    expect(roles.items!.examples).toEqual(expect.arrayContaining(['admin', 'user', 'viewer']));
  });

  it('tracks number min/max across multiple responses', () => {
    const bodies = [
      JSON.stringify({ score: 42 }),
      JSON.stringify({ score: 7 }),
      JSON.stringify({ score: 892 }),
      JSON.stringify({ score: 1 }),
    ];
    const result = inferResponseSpec(bodies);

    expect(result!.properties!.score.min).toBe(1);
    expect(result!.properties!.score.max).toBe(892);
  });

  it('collects up to 3 string examples', () => {
    const bodies = [
      JSON.stringify({ tag: 'alpha' }),
      JSON.stringify({ tag: 'beta' }),
      JSON.stringify({ tag: 'gamma' }),
      JSON.stringify({ tag: 'delta' }),
    ];
    const result = inferResponseSpec(bodies);

    expect(result!.properties!.tag.examples).toHaveLength(3);
  });

  it('does not duplicate string examples', () => {
    const bodies = [
      JSON.stringify({ status: 'active' }),
      JSON.stringify({ status: 'active' }),
      JSON.stringify({ status: 'inactive' }),
    ];
    const result = inferResponseSpec(bodies);

    expect(result!.properties!.status.examples).toEqual(['active', 'inactive']);
  });

  it('produces union type for mixed types', () => {
    const bodies = [
      JSON.stringify({ value: 'hello' }),
      JSON.stringify({ value: 42 }),
    ];
    const result = inferResponseSpec(bodies);

    const value = result!.properties!.value;
    expect(Array.isArray(value.type)).toBe(true);
    expect(value.type).toContain('string');
    expect(value.type).toContain('number');
  });

  it('handles null values as type null', () => {
    const bodies = [
      JSON.stringify({ data: null }),
      JSON.stringify({ data: { id: 1 } }),
    ];
    const result = inferResponseSpec(bodies);

    const data = result!.properties!.data;
    expect(Array.isArray(data.type)).toBe(true);
    expect(data.type).toContain('null');
    expect(data.type).toContain('object');
  });

  it('handles top-level array responses', () => {
    const bodies = [
      JSON.stringify([{ id: 1 }, { id: 2 }]),
    ];
    const result = inferResponseSpec(bodies);

    expect(result!.type).toBe('array');
    expect(result!.items).toBeDefined();
    expect(result!.items!.type).toBe('object');
    expect(result!.items!.properties!.id.type).toBe('number');
  });

  it('handles deeply nested structures', () => {
    const bodies = [
      JSON.stringify({ user: { address: { city: 'London', zip: 'SW1' } } }),
      JSON.stringify({ user: { address: { city: 'Paris', zip: '75001' } } }),
    ];
    const result = inferResponseSpec(bodies);

    const city = result!.properties!.user.properties!.address.properties!.city;
    expect(city.type).toBe('string');
    expect(city.examples).toContain('London');
    expect(city.examples).toContain('Paris');
  });

  it('skips strings longer than 100 characters for examples', () => {
    const longStr = 'a'.repeat(101);
    const bodies = [
      JSON.stringify({ token: longStr }),
    ];
    const result = inferResponseSpec(bodies);

    expect(result!.properties!.token.examples).toBeUndefined();
  });
});
