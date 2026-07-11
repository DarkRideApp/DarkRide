import { describe, it, expect } from 'vitest';
import {
  diffLines,
  hasLineChanges,
  diffHeaders,
  prettyForDiff,
} from './response-diff';

describe('diffLines', () => {
  it('marks identical text as all equal', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc');
    expect(d.every((l) => l.op === 'equal')).toBe(true);
    expect(hasLineChanges(d)).toBe(false);
  });

  it('detects a changed middle line as remove + add', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc');
    expect(d).toEqual([
      { op: 'equal', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'B' },
      { op: 'equal', text: 'c' },
    ]);
    expect(hasLineChanges(d)).toBe(true);
  });

  it('handles pure additions', () => {
    const d = diffLines('a', 'a\nb');
    expect(d).toEqual([
      { op: 'equal', text: 'a' },
      { op: 'add', text: 'b' },
    ]);
  });

  it('handles pure removals', () => {
    const d = diffLines('a\nb', 'a');
    expect(d).toEqual([
      { op: 'equal', text: 'a' },
      { op: 'remove', text: 'b' },
    ]);
  });

  it('treats empty old text as all-add', () => {
    const d = diffLines('', 'x\ny');
    expect(d).toEqual([
      { op: 'add', text: 'x' },
      { op: 'add', text: 'y' },
    ]);
  });
});

describe('diffHeaders', () => {
  it('classifies added / removed / changed / unchanged (case-insensitive keys)', () => {
    const oldH = { 'Content-Type': 'application/json', 'X-Old': '1', 'ETag': 'abc' };
    const newH = { 'content-type': 'text/html', 'X-New': '2', 'etag': 'abc' };
    const changes = diffHeaders(oldH, newH);

    const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));
    expect(byKey['content-type'].kind).toBe('changed');
    expect(byKey['content-type'].oldValue).toBe('application/json');
    expect(byKey['content-type'].newValue).toBe('text/html');
    expect(byKey['x-old'].kind).toBe('removed');
    expect(byKey['x-new'].kind).toBe('added');
    expect(byKey['etag'].kind).toBe('unchanged');
  });

  it('returns a sorted, stable key order', () => {
    const changes = diffHeaders({ b: '1', a: '1' }, { a: '1', c: '1' });
    expect(changes.map((c) => c.key)).toEqual(['a', 'b', 'c']);
  });

  it('tolerates null / undefined maps', () => {
    expect(diffHeaders(null, { a: '1' })).toEqual([{ key: 'a', kind: 'added', newValue: '1' }]);
    expect(diffHeaders({ a: '1' }, undefined)).toEqual([{ key: 'a', kind: 'removed', oldValue: '1' }]);
  });
});

describe('prettyForDiff', () => {
  it('pretty-prints JSON objects onto multiple lines', () => {
    const out = prettyForDiff('{"a":1,"b":2}');
    expect(out).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('leaves non-JSON untouched', () => {
    expect(prettyForDiff('<html></html>')).toBe('<html></html>');
    expect(prettyForDiff('plain text')).toBe('plain text');
  });

  it('returns empty string for null/empty', () => {
    expect(prettyForDiff(null)).toBe('');
    expect(prettyForDiff('')).toBe('');
  });

  it('leaves malformed JSON untouched', () => {
    expect(prettyForDiff('{not json')).toBe('{not json');
  });
});
