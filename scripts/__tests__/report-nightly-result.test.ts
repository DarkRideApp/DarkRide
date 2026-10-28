import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../report-nightly-result.sh');
const RUN_URL = 'https://github.com/example/repo/actions/runs/42';

// A `gh` that records its arguments and answers `issue list` with FAKE_OPEN_ISSUE.
const FAKE_GH = `#!/bin/bash
echo "$@" >> "$FAKE_GH_LOG"
if [ "$1 $2" = "issue list" ]; then echo "\${FAKE_OPEN_ISSUE:-}"; fi
exit 0
`;

let dir: string;

function run(result: string, openIssue = ''): string[] {
  const log = path.join(dir, 'gh.log');
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_GH_LOG: log,
      FAKE_OPEN_ISSUE: openIssue,
      RESULT: result,
      REPO: 'example/repo',
      RUN_URL,
    },
  });
  expect(r.status, r.stderr).toBe(0);
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

const writes = (calls: string[]) => calls.filter((c) => !c.startsWith('issue list'));

describe.skipIf(process.platform === 'win32')('report-nightly-result.sh', () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'fake-gh-'));
    writeFileSync(path.join(dir, 'gh'), FAKE_GH);
    chmodSync(path.join(dir, 'gh'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens an issue that mentions the owner and links the run when a night fails and none is open', () => {
    const calls = run('failure');
    const create = calls.find((c) => c.startsWith('issue create'));
    expect(create).toBeDefined();
    expect(create).toContain('--repo example/repo');
    expect(create).toContain('--label nightly-emulator');
    expect(create).toContain(RUN_URL);
    expect(create).toContain('@cubehouse');
    expect(calls.some((c) => c.startsWith('issue comment'))).toBe(false);
  });

  it('creates the label first so the issue can carry it', () => {
    const calls = run('failure');
    const labelAt = calls.findIndex((c) => c.startsWith('label create nightly-emulator'));
    const issueAt = calls.findIndex((c) => c.startsWith('issue create'));
    expect(labelAt).toBeGreaterThanOrEqual(0);
    expect(labelAt).toBeLessThan(issueAt);
  });

  it('comments on the open issue instead of opening another one when a night fails again', () => {
    const calls = run('failure', '7');
    const comment = calls.find((c) => c.startsWith('issue comment 7'));
    expect(comment).toContain(RUN_URL);
    expect(comment).not.toContain('@cubehouse');
    expect(calls.some((c) => c.startsWith('issue create'))).toBe(false);
  });

  it('closes the open issue with a link to the run when a night passes', () => {
    const calls = run('success', '7');
    const close = calls.find((c) => c.startsWith('issue close 7'));
    expect(close).toContain('--repo example/repo');
    expect(close).toContain(RUN_URL);
  });

  it('does nothing when a night passes and no issue is open', () => {
    expect(writes(run('success'))).toEqual([]);
  });

  it.each(['cancelled', 'skipped', ''])('does nothing for a %j result', (result) => {
    expect(writes(run(result, '7'))).toEqual([]);
  });
});
