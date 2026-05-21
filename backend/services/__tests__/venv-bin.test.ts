import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, join } from 'path';
import { resolveVenvBin } from '../venv-bin';

describe('resolveVenvBin', () => {
  let tmpRoot: string;
  let origCwd: string;

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'darkride-venv-bin-test-'));
    origCwd = process.cwd();
    // Create a fake `.venv/bin/<tool>` so resolveVenvBin can find it.
    const binDir = join(tmpRoot, '.venv', 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'mitmdump'), '#!/bin/sh\necho fake', { mode: 0o755 });
    process.chdir(tmpRoot);
  });

  afterAll(() => {
    process.chdir(origCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns the absolute path when the venv binary exists', () => {
    const r = resolveVenvBin('mitmdump');
    expect(r).toBe(resolve(tmpRoot, '.venv', 'bin', 'mitmdump'));
  });

  it('falls back to the bare name when the venv binary is missing', () => {
    const r = resolveVenvBin('not-installed-tool');
    expect(r).toBe('not-installed-tool');
  });
});
