import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR = path.resolve(__dirname, '../../.github/workflows');

// `echo "NAME=$VAR" >> "$GITHUB_ENV"` where the value comes from a shell variable.
const ENV_WRITE = /echo\s+"[A-Z0-9_]+=\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"\s*>>\s*"?\$GITHUB_ENV"?/g;

function unmaskedEnvWrites(source: string): string[] {
  const unmasked: string[] = [];
  for (const match of source.matchAll(ENV_WRITE)) {
    const variable = match[1];
    const before = source.slice(0, match.index);
    const masked = new RegExp(`::add-mask::\\$\\{?${variable}\\}?`).test(before);
    if (!masked) unmasked.push(variable);
  }
  return unmasked;
}

describe('workflow secret masking', () => {
  it('flags a shell variable written to GITHUB_ENV without add-mask', () => {
    const source = [
      'API_KEY=$(mint-key)',
      'echo "DARKRIDE_API_KEY=$API_KEY" >> "$GITHUB_ENV"',
    ].join('\n');
    expect(unmaskedEnvWrites(source)).toEqual(['API_KEY']);
  });

  it('accepts a variable masked before it is written', () => {
    const source = [
      'API_KEY=$(mint-key)',
      'echo "::add-mask::$API_KEY"',
      'echo "DARKRIDE_API_KEY=$API_KEY" >> "$GITHUB_ENV"',
    ].join('\n');
    expect(unmaskedEnvWrites(source)).toEqual([]);
  });

  it('does not accept a mask that comes after the write', () => {
    const source = [
      'echo "DARKRIDE_API_KEY=$API_KEY" >> "$GITHUB_ENV"',
      'echo "::add-mask::$API_KEY"',
    ].join('\n');
    expect(unmaskedEnvWrites(source)).toEqual(['API_KEY']);
  });

  it('ignores literal values', () => {
    expect(unmaskedEnvWrites('echo "MODE=ci" >> "$GITHUB_ENV"')).toEqual([]);
  });

  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    it(`${file} masks every shell variable it writes to GITHUB_ENV`, () => {
      const source = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
      expect(unmaskedEnvWrites(source)).toEqual([]);
    });
  }
});
