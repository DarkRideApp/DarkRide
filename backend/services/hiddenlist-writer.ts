import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { hiddenDomains } from '../db/schema';
import type { AppDatabase } from '../db/index';

export function getHiddenlistPath(): string {
  return './data/hiddenlist.json';
}

export function syncHiddenlistFile(db: AppDatabase): void {
  const rows = db.select({ domain: hiddenDomains.domain }).from(hiddenDomains).all();
  const domains = rows.map(r => r.domain);
  const filePath = getHiddenlistPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(domains));
}
