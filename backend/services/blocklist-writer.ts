import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { blockedDomains } from '../db/schema';
import type { AppDatabase } from '../db/index';

export function getBlocklistPath(): string {
  return './data/blocklist.json';
}

export function syncBlocklistFile(db: AppDatabase): void {
  const rows = db.select({ domain: blockedDomains.domain }).from(blockedDomains).all();
  const domains = rows.map(r => r.domain);
  const filePath = getBlocklistPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(domains));
}
