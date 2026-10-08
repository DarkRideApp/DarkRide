// backend/test-utils/provider-branch-scan.test.ts
import { describe, it, expect } from 'vitest';
import { scanSource } from './provider-branch-scan';

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
});
