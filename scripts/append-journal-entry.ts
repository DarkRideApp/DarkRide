import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface AppendOptions {
  projectRoot: string;
  idx: number;
  tag: string;
}

export interface AppendResult {
  sqlPath: string;
  when: number;
}

export function appendJournalEntry(opts: AppendOptions): AppendResult {
  const journalPath = join(opts.projectRoot, 'migrations', 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as Journal;

  const usedIdx = new Set(journal.entries.map(e => e.idx));
  if (usedIdx.has(opts.idx)) throw new Error(`idx ${opts.idx} already used`);
  const expectedNext = journal.entries.length === 0 ? 0 : Math.max(...journal.entries.map(e => e.idx)) + 1;
  if (opts.idx !== expectedNext) {
    throw new Error(`idx must be sequential — expected idx ${expectedNext}, got ${opts.idx}`);
  }

  const sqlPath = join(opts.projectRoot, 'migrations', `${opts.tag}.sql`);
  if (existsSync(sqlPath)) {
    throw new Error(`migration file already exists at ${sqlPath}`);
  }

  const maxWhen = journal.entries.length === 0 ? 0 : Math.max(...journal.entries.map(e => e.when));
  const when = Math.max(Date.now(), maxWhen + 1);

  journal.entries.push({
    idx: opts.idx,
    version: '7',
    when,
    tag: opts.tag,
    breakpoints: true,
  });

  writeFileSync(journalPath, JSON.stringify(journal, null, '\t'));
  writeFileSync(sqlPath, '');

  return { sqlPath, when };
}

// CLI entry point: `npx tsx scripts/append-journal-entry.ts <idx> <tag>`
if (require.main === module) {
  const [idxStr, tag] = process.argv.slice(2);
  if (!idxStr || !tag) {
    console.error('Usage: npx tsx scripts/append-journal-entry.ts <idx> <tag>');
    process.exit(1);
  }
  const result = appendJournalEntry({
    projectRoot: process.cwd(),
    idx: Number(idxStr),
    tag,
  });
  console.log(`Created ${result.sqlPath} with when=${result.when}`);
}
