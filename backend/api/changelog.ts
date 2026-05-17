import { execFile } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { registerEndpoint } from './api-service';

const execFileAsync = promisify(execFile);

interface Commit {
  hash: string;
  shortHash: string;
  title: string;
  body: string;
  author: string;
  date: string;
}

const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';
const GIT_FORMAT = ['%H', '%h', '%s', '%b', '%an', '%aI'].join(FIELD_SEP) + RECORD_SEP;

const CHANGELOG_PATH = join(process.cwd(), 'changelog.json');

interface ChangelogData {
  total: number;
  commits: Commit[];
}

let cachedChangelog: ChangelogData | null = null;

function loadChangelogFile(): ChangelogData | null {
  if (cachedChangelog) return cachedChangelog;
  if (!existsSync(CHANGELOG_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(CHANGELOG_PATH, 'utf-8'));
    cachedChangelog = data;
    return data;
  } catch {
    return null;
  }
}

async function getChangelogFromGit(limit: number, offset: number): Promise<{ items: Commit[]; total: number; limit: number; offset: number }> {
  const { stdout: countOut } = await execFileAsync('git', ['rev-list', '--count', 'HEAD']);
  const total = parseInt(countOut.trim(), 10) || 0;

  const { stdout } = await execFileAsync('git', [
    'log',
    `--format=${GIT_FORMAT}`,
    `--skip=${offset}`,
    `-n`, String(limit),
  ]);

  const commits: Commit[] = stdout
    .split(RECORD_SEP)
    .filter((record) => record.trim())
    .map((record) => {
      const fields = record.trim().split(FIELD_SEP);
      return {
        hash: fields[0] || '',
        shortHash: fields[1] || '',
        title: fields[2] || '',
        body: (fields[3] || '').trim(),
        author: fields[4] || '',
        date: fields[5] || '',
      };
    });

  return { items: commits, total, limit, offset };
}

function getChangelogFromFile(limit: number, offset: number): { items: Commit[]; total: number; limit: number; offset: number } {
  const data = loadChangelogFile()!;
  const items = data.commits.slice(offset, offset + limit);
  return { items, total: data.total, limit, offset };
}

export function registerChangelogEndpoints(): void {
  registerEndpoint('GET', '/v1/changelog', async (req, res) => {
    let limit = Number(req.query.limit) || 100;
    let offset = Number(req.query.offset) || 0;

    if (limit < 1) limit = 1;
    if (limit > 500) limit = 500;
    if (offset < 0) offset = 0;

    try {
      const useFile = loadChangelogFile() !== null;
      const data = useFile
        ? getChangelogFromFile(limit, offset)
        : await getChangelogFromGit(limit, offset);

      res.json({ data });
    } catch (err: any) {
      console.error('Changelog API error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });
}
