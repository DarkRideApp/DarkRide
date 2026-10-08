// backend/test-utils/provider-branch-scan.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanSource, scanTree } from './provider-branch-scan';

// Records every createSourceFile call so the scanTree prefilter is observable:
// the TypeScript parser never throws on bad input, so "was this file parsed"
// cannot be seen from the return value alone. Everything else passes through.
const parsed = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<{ default: any }>();
  const real = actual.default;
  return {
    default: {
      ...real,
      createSourceFile: (...args: any[]) => {
        parsed.files.push(args[0]);
        return real.createSourceFile(...args);
      },
    },
  };
});

const IDS = ['anthropic', 'gemini', 'ollama', 'openrouter', 'codestral', 'claude-cli'];
const hits = (src: string) => scanSource('x.ts', src, IDS).map((h) => h.line);

describe('provider branch scanner', () => {
  it('flags case labels', () => { expect(hits(`switch (t) {\n case 'anthropic': break;\n}`)).toEqual([2]); });
  it('flags === and !== against an id on either side', () => {
    expect(hits(`if (t === 'gemini') {}`)).toEqual([1]);
    expect(hits(`if ('ollama' !== t) {}`)).toEqual([1]);
  });
  it('flags == and !=', () => { expect(hits(`if (t == 'claude-cli') {}`)).toEqual([1]); });
  it('flags literal arguments and array-literal elements of includes', () => {
    expect(hits(`['anthropic','gemini'].includes(t)`)).toEqual([1]);
    expect(hits(`list.includes('codestral')`)).toEqual([1]);
  });
  it('does not flag plain assignments, object values, or unrelated strings', () => {
    expect(hits(`const x = 'gemini';`)).toEqual([]);
    expect(hits(`const o = { type: 'gemini' };`)).toEqual([]);
    expect(hits(`if (t === 'other') {}`)).toEqual([]);
    expect(hits(`const s = "anthropic is a company";`)).toEqual([]);
  });
  it('parses tsx', () => {
    expect(scanSource('x.tsx', `const A = () => <div>{t === 'ollama' && 1}</div>;`, IDS)).toHaveLength(1);
  });
  it('does not flag a tsx file with no provider id comparison', () => {
    expect(scanSource('x.tsx', `const A = () => <div>{t === 'other' && 1}</div>;`, IDS)).toEqual([]);
    expect(scanSource('x.tsx', `const A = () => <div title="gemini">{t}</div>;`, IDS)).toEqual([]);
  });

  describe('wrapped array literals on includes', () => {
    it.each([
      ['as const', `(['gemini','x'] as const).includes(t)`],
      ['as readonly string[]', `(['gemini'] as readonly string[]).includes(t)`],
      ['angle-bracket assertion', `(<string[]>['gemini']).includes(t)`],
      ['satisfies', `(['gemini'] satisfies string[]).includes(t)`],
      ['non-null assertion', `['gemini']!.includes(t)`],
      ['plain parentheses', `(['gemini']).includes(t)`],
      ['nested wrappers', `((['gemini'] as const) as readonly string[]).includes(t)`],
      ['optional call', `(['gemini'] as const)?.includes(t)`],
    ])('flags %s', (_name, src) => {
      expect(hits(src)).toEqual([1]);
    });
    it('does not flag a wrapped array of unrelated strings or a wrapped non-literal target', () => {
      expect(hits(`(['other', 'x'] as const).includes(t)`)).toEqual([]);
      expect(hits(`(list as string[]).includes(t)`)).toEqual([]);
    });
  });

  describe('wrapped literal operands, case expressions and includes arguments', () => {
    it.each([
      ['as on the right', `if (t === ('gemini' as string)) {}`],
      ['as on the left', `if (('gemini' as string) !== t) {}`],
      ['satisfies', `if (t == ('gemini' satisfies string)) {}`],
      ['angle-bracket assertion', `if (t === <string>'gemini') {}`],
      ['non-null assertion', `if (t != 'gemini'!) {}`],
      ['plain parentheses', `if (t === ('gemini')) {}`],
      ['nested wrappers', `if (t === (('gemini' as const) as string)) {}`],
    ])('flags an equality operand with %s', (_name, src) => {
      expect(hits(src)).toEqual([1]);
    });
    it('flags wrapped case expressions', () => {
      expect(hits(`switch (t) {\n case ('anthropic' as string): break;\n}`)).toEqual([2]);
      expect(hits(`switch (t) {\n case ('ollama'): break;\n}`)).toEqual([2]);
    });
    it('flags a wrapped literal argument to includes', () => {
      expect(hits(`list.includes('gemini' as string)`)).toEqual([1]);
    });
    it('does not flag wrapped literals that are not ids', () => {
      expect(hits(`if (t === ('other' as string)) {}`)).toEqual([]);
      expect(hits(`switch (t) {\n case ('other' as string): break;\n}`)).toEqual([]);
    });
  });

  describe('no-substitution template literals', () => {
    it('flags case labels and equality against a plain template literal', () => {
      expect(hits('switch (t) {\n case `anthropic`: break;\n}')).toEqual([2]);
      expect(hits('if (t === `gemini`) {}')).toEqual([1]);
      expect(hits('if (`ollama` !== t) {}')).toEqual([1]);
      expect(hits('list.includes(`codestral`)')).toEqual([1]);
    });
    it('does not flag a template literal with a substitution', () => {
      expect(hits('if (t === `gemini${x}`) {}')).toEqual([]);
      expect(hits('if (t === `${x}`) {}')).toEqual([]);
      expect(hits('switch (t) {\n case `anthropic${x}`: break;\n}')).toEqual([]);
    });
  });

  describe('hit shape', () => {
    it('reports a single hit when includes matches through both the argument and the array literal', () => {
      expect(scanSource('x.ts', `['gemini'].includes('gemini')`, IDS)).toHaveLength(1);
    });
    it('still reports one hit per matching call', () => {
      expect(hits(`['gemini'].includes(t) && list.includes('gemini')`)).toEqual([1, 1]);
    });
    it('reports only the case expression as hit text, not the clause body', () => {
      const src = `switch (t) {\n case 'anthropic':\n  doThing();\n  break;\n}`;
      expect(scanSource('x.ts', src, IDS)).toEqual([{ line: 2, text: `'anthropic'` }]);
    });
    it('reports the wrapped case expression as written', () => {
      const src = `switch (t) {\n case ('anthropic' as string): break;\n}`;
      expect(scanSource('x.ts', src, IDS)).toEqual([{ line: 2, text: `('anthropic' as string)` }]);
    });
    it('reports the comparison as hit text for equality', () => {
      expect(scanSource('x.ts', `if (t === 'gemini') {}`, IDS)).toEqual([{ line: 1, text: `t === 'gemini'` }]);
    });
    it('caps hit text at 80 characters', () => {
      const long = `['gemini', ${Array.from({ length: 30 }, (_, i) => `'pad${i}'`).join(', ')}].includes(t)`;
      const [h] = scanSource('x.ts', long, IDS);
      expect(h.text).toHaveLength(80);
    });
  });
});

describe('scanTree', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
    parsed.files.length = 0;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (rel: string, text: string) => {
    const full = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  const HIT = `if (t === 'gemini') {}\n`;
  const allowNothing = () => false;

  it('finds a hit in a nested .tsx file and reports a forward-slash relative path', () => {
    write('src/deep/er/Panel.tsx', `const A = () => <div>{t === 'ollama' && 1}</div>;\n`);
    const out = scanTree(root, IDS, allowNothing);
    expect(out).toEqual([{ file: 'src/deep/er/Panel.tsx', line: 1, text: `t === 'ollama'` }]);
    expect(out[0].file).not.toContain('\\');
  });

  it('reports line numbers and finds hits across several files', () => {
    write('a.ts', `const x = 1;\n\n${HIT}`);
    write('b/c.ts', `switch (t) {\n case 'anthropic': break;\n}\n`);
    const out = scanTree(root, IDS, allowNothing).sort((l, r) => l.file.localeCompare(r.file));
    expect(out.map((h) => [h.file, h.line])).toEqual([['a.ts', 3], ['b/c.ts', 2]]);
  });

  it('skips node_modules, dist, dot-directories, test, spec and declaration files', () => {
    write('node_modules/pkg/index.ts', HIT);
    write('src/node_modules/pkg/index.ts', HIT);
    write('dist/out.ts', HIT);
    write('src/dist/out.ts', HIT);
    write('.hidden/x.ts', HIT);
    write('src/.cache/x.ts', HIT);
    write('src/.dotfile.ts', HIT);
    write('src/thing.test.ts', HIT);
    write('src/Thing.spec.tsx', HIT);
    write('src/types.d.ts', HIT);
    write('src/real.ts', HIT);
    const seen: string[] = [];
    const out = scanTree(root, IDS, (rel) => { seen.push(rel); return false; });
    expect(out.map((h) => h.file)).toEqual(['src/real.ts']);
    // Skipped files are filtered before `allow` is consulted.
    expect(seen).toEqual(['src/real.ts']);
  });

  it('passes forward-slash relative paths to allow and does not scan an allowed file', () => {
    write('a/b/c.ts', HIT);
    write('a/b/d.ts', HIT);
    const seen: string[] = [];
    const out = scanTree(root, IDS, (rel) => { seen.push(rel); return rel === 'a/b/c.ts'; });
    expect(seen.sort()).toEqual(['a/b/c.ts', 'a/b/d.ts']);
    expect(seen.every((p) => !p.includes('\\') && !path.isAbsolute(p))).toBe(true);
    expect(out.map((h) => h.file)).toEqual(['a/b/d.ts']);
    // The allowed file is not even parsed.
    expect(parsed.files.map((f) => path.basename(f))).toEqual(['d.ts']);
  });

  it('finds ids containing a hyphen end to end through the text prefilter', () => {
    write('a.ts', `if (t === 'claude-cli') {}\n`);
    write('b.ts', `switch (t) {\n case 'openai-compatible': break;\n}\n`);
    write('c.ts', `list.includes('openai-compatible');\n`);
    const ids = ['claude-cli', 'openai-compatible'];
    const out = scanTree(root, ids, allowNothing).sort((l, r) => l.file.localeCompare(r.file));
    expect(out.map((h) => h.file)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('treats regex metacharacters in ids literally in the prefilter', () => {
    write('a.ts', `if (t === 'a.b') {}\n`);
    write('b.ts', `if (t === 'axb') {}\n`);
    const out = scanTree(root, ['a.b'], allowNothing);
    expect(out.map((h) => h.file)).toEqual(['a.ts']);
    // 'axb' contains no 'a.b', so the prefilter must not even parse it.
    expect(parsed.files.map((f) => path.basename(f))).toEqual(['a.ts']);
  });

  it('does not parse a file that mentions no id, and that is not an error', () => {
    write('clean.ts', `export const answer: number = 42;\n`);
    write('broken.ts', `export const = ;;; {{{ not valid typescript\n`);
    write('hit.ts', HIT);
    let out: ReturnType<typeof scanTree> = [];
    expect(() => { out = scanTree(root, IDS, allowNothing); }).not.toThrow();
    expect(out.map((h) => h.file)).toEqual(['hit.ts']);
    expect(parsed.files.map((f) => path.basename(f))).toEqual(['hit.ts']);
  });

  it('returns an empty list for an empty tree', () => {
    expect(scanTree(root, IDS, allowNothing)).toEqual([]);
  });

  it('survives a file that mentions an id but has no comparison', () => {
    write('mention.ts', `const o = { type: 'gemini' };\n`);
    expect(scanTree(root, IDS, allowNothing)).toEqual([]);
    expect(parsed.files.map((f) => path.basename(f))).toEqual(['mention.ts']);
  });
});
