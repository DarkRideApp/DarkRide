import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendJournalEntry } from '../append-journal-entry';

function makeWorkdir(initialJournal: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'append-journal-test-'));
  const metaDir = join(dir, 'migrations', 'meta');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, '_journal.json'), JSON.stringify(initialJournal, null, '\t'));
  return dir;
}

describe('appendJournalEntry', () => {
  it('appends a new entry with idx = max+1 and when > max prior when', () => {
    const dir = makeWorkdir({
      version: '7', dialect: 'sqlite',
      entries: [
        { idx: 0, version: '7', when: 1000, tag: '0000_first', breakpoints: true },
        { idx: 1, version: '7', when: 9999999999999, tag: '0001_second', breakpoints: true },
      ],
    });

    const result = appendJournalEntry({ projectRoot: dir, idx: 2, tag: '0002_my_change' });

    const journal = JSON.parse(readFileSync(join(dir, 'migrations', 'meta', '_journal.json'), 'utf-8'));
    expect(journal.entries).toHaveLength(3);
    const appended = journal.entries[2];
    expect(appended.idx).toBe(2);
    expect(appended.tag).toBe('0002_my_change');
    expect(appended.breakpoints).toBe(true);
    expect(appended.version).toBe('7');
    expect(appended.when).toBeGreaterThan(9999999999999); // strictly greater than prior max

    // Empty SQL file created at the right path
    expect(existsSync(join(dir, 'migrations', '0002_my_change.sql'))).toBe(true);

    // Returned info matches
    expect(result.sqlPath.endsWith('0002_my_change.sql')).toBe(true);
    expect(result.when).toBe(appended.when);
  });

  it('rejects an idx that already exists', () => {
    const dir = makeWorkdir({
      version: '7', dialect: 'sqlite',
      entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_first', breakpoints: true }],
    });
    expect(() => appendJournalEntry({ projectRoot: dir, idx: 0, tag: '0000_dup' })).toThrow(/already/);
  });

  it('rejects an idx that skips ahead', () => {
    const dir = makeWorkdir({
      version: '7', dialect: 'sqlite',
      entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_first', breakpoints: true }],
    });
    expect(() => appendJournalEntry({ projectRoot: dir, idx: 5, tag: '0005_skips' })).toThrow(/expected idx 1/);
  });

  it('refuses to overwrite an existing SQL file', () => {
    const dir = makeWorkdir({
      version: '7', dialect: 'sqlite',
      entries: [{ idx: 0, version: '7', when: 1000, tag: '0000_first', breakpoints: true }],
    });
    writeFileSync(join(dir, 'migrations', '0001_existing.sql'), '-- pre-existing');
    expect(() =>
      appendJournalEntry({ projectRoot: dir, idx: 1, tag: '0001_existing' }),
    ).toThrow(/already exists/);
  });
});
