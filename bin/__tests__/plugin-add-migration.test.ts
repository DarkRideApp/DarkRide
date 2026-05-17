import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  padIdx,
  isValidMigrationName,
  nextIdxFromDir,
  runAddMigrationCore,
  UserError,
} from '../commands/plugin-add-migration';

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

describe('padIdx', () => {
  it('zero-pads to 4 digits', () => {
    expect(padIdx(0)).toBe('0000');
    expect(padIdx(3)).toBe('0003');
    expect(padIdx(42)).toBe('0042');
    expect(padIdx(1000)).toBe('1000');
  });
});

describe('isValidMigrationName', () => {
  it('accepts lowercase letters, digits, underscores', () => {
    expect(isValidMigrationName('add_user_settings')).toBe(true);
    expect(isValidMigrationName('initial')).toBe(true);
    expect(isValidMigrationName('add123')).toBe(true);
    expect(isValidMigrationName('a_b_c_1')).toBe(true);
  });

  it('rejects uppercase letters', () => {
    expect(isValidMigrationName('AddUser')).toBe(false);
  });

  it('rejects hyphens', () => {
    expect(isValidMigrationName('add-user')).toBe(false);
  });

  it('rejects spaces and punctuation', () => {
    expect(isValidMigrationName('add user')).toBe(false);
    expect(isValidMigrationName('add.user')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isValidMigrationName('')).toBe(false);
  });
});

describe('nextIdxFromDir', () => {
  let tmp: string;

  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'next-idx-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns 0 when the directory does not exist', () => {
    expect(nextIdxFromDir(join(tmp, 'nonexistent'))).toBe(0);
  });

  it('returns 0 when the directory has no .sql files', () => {
    const dir = join(tmp, 'migs'); mkdirSync(dir);
    writeFileSync(join(dir, 'README.md'), '');
    expect(nextIdxFromDir(dir)).toBe(0);
  });

  it('returns 1 when the only file is 0000_*.sql', () => {
    const dir = join(tmp, 'migs'); mkdirSync(dir);
    writeFileSync(join(dir, '0000_init.sql'), '');
    expect(nextIdxFromDir(dir)).toBe(1);
  });

  it('returns max+1 with multiple files', () => {
    const dir = join(tmp, 'migs'); mkdirSync(dir);
    writeFileSync(join(dir, '0000_a.sql'), '');
    writeFileSync(join(dir, '0001_b.sql'), '');
    writeFileSync(join(dir, '0042_late.sql'), '');
    expect(nextIdxFromDir(dir)).toBe(43);
  });

  it('ignores .sql files without a leading numeric prefix', () => {
    const dir = join(tmp, 'migs'); mkdirSync(dir);
    writeFileSync(join(dir, 'manual.sql'), '');
    writeFileSync(join(dir, '0000_init.sql'), '');
    expect(nextIdxFromDir(dir)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: runAddMigrationCore
// ---------------------------------------------------------------------------

describe('runAddMigrationCore', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'add-migration-'));
    process.chdir(tmp);
    // Set up a fake plugin
    mkdirSync(join(tmp, 'plugins', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'plugins', 'foo', 'package.json'), JSON.stringify({
      name: 'foo', keywords: ['darkride-plugin'],
    }));
  });
  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a 0000_ file when no migrations exist', () => {
    runAddMigrationCore('foo', 'init');
    const files = readdirSync(join(tmp, 'plugins', 'foo', 'migrations'));
    expect(files).toContain('0000_init.sql');
  });

  it('numbers subsequent migrations consecutively', () => {
    runAddMigrationCore('foo', 'first');
    runAddMigrationCore('foo', 'second');
    runAddMigrationCore('foo', 'third');
    const files = readdirSync(join(tmp, 'plugins', 'foo', 'migrations')).filter(f => f.endsWith('.sql')).sort();
    expect(files).toEqual(['0000_first.sql', '0001_second.sql', '0002_third.sql']);
  });

  it('does NOT create or update a journal file', () => {
    runAddMigrationCore('foo', 'init');
    const metaDir = join(tmp, 'plugins', 'foo', 'migrations', 'meta');
    expect(existsSync(metaDir)).toBe(false);
  });

  it('throws UserError for invalid migration name', () => {
    expect(() => runAddMigrationCore('foo', 'BadName')).toThrow(UserError);
  });

  it('throws UserError for unknown plugin', () => {
    expect(() => runAddMigrationCore('does-not-exist', 'init')).toThrow(UserError);
  });

  it('writes a sensible SQL stub to the new file', () => {
    runAddMigrationCore('foo', 'add_users');
    const sql = readFileSync(join(tmp, 'plugins', 'foo', 'migrations', '0000_add_users.sql'), 'utf-8');
    expect(sql).toMatch(/foo: add_users/);
    expect(sql).toMatch(/statement-breakpoint/);
  });

  it('calling twice with the same name produces two distinct numbered files', () => {
    // Since the index is computed from existing files on disk, the same migration
    // name can be used twice and each call produces a unique sequential file.
    runAddMigrationCore('foo', 'init');
    runAddMigrationCore('foo', 'init');
    const files = readdirSync(join(tmp, 'plugins', 'foo', 'migrations')).filter(f => f.endsWith('.sql')).sort();
    expect(files).toEqual(['0000_init.sql', '0001_init.sql']);
  });
});
