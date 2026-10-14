import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR = path.resolve(__dirname, '../../.github/workflows');

// The first major of each action whose action.yml runs on Node 24. Earlier majors
// run on Node 20, which GitHub is retiring. Add a row when a workflow uses a new action.
const MIN_NODE24_MAJOR: Record<string, number> = {
  'actions/checkout': 5,
  'actions/setup-node': 5,
  'actions/cache': 5,
  'actions/setup-python': 6,
  'actions/setup-java': 5,
  'gradle/actions/setup-gradle': 5,
  'docker/setup-buildx-action': 4,
  'docker/login-action': 4,
  'docker/build-push-action': 7,
  'android-actions/setup-android': 4,
};

function floatingRunners(source: string): string[] {
  return [...source.matchAll(/^\s*runs-on:\s*(\S+)/gm)].map((m) => m[1]).filter((v) => v.endsWith('-latest'));
}

function actionsBelowNode24(source: string): string[] {
  const outdated: string[] = [];
  for (const m of source.matchAll(/^\s*-?\s*uses:\s*([\w./-]+)@v(\d+)/gm)) {
    const [, action, major] = m;
    const min = MIN_NODE24_MAJOR[action];
    if (min === undefined) outdated.push(`${action} (not in MIN_NODE24_MAJOR)`);
    else if (Number(major) < min) outdated.push(`${action}@v${major} (needs v${min}+)`);
  }
  return outdated;
}

// /tmp is a RAM-backed tmpfs capped at about 8 GB on ubuntu-26.04 (it is on the disk on 24.04),
// so a cache path there fills it and tar writes a truncated file while the cache step reports success.
function tmpfsPaths(source: string): string[] {
  return [...source.matchAll(/^\s*path:\s*(\/tmp\S*)/gm)].map((m) => m[1]);
}

describe('workflow runtime helpers', () => {
  it('flags a path under /tmp and accepts one in the home directory', () => {
    expect(tmpfsPaths('          path: /tmp/docker-image-cache\n')).toEqual(['/tmp/docker-image-cache']);
    expect(tmpfsPaths('          path: ~/docker-image-cache\n')).toEqual([]);
  });

  it('flags a floating runner label and accepts a pinned one', () => {
    expect(floatingRunners('    runs-on: ubuntu-latest\n')).toEqual(['ubuntu-latest']);
    expect(floatingRunners('    runs-on: ubuntu-26.04\n')).toEqual([]);
  });

  it('flags an action older than its first Node 24 major', () => {
    expect(actionsBelowNode24('      - uses: actions/checkout@v4\n')).toEqual(['actions/checkout@v4 (needs v5+)']);
    expect(actionsBelowNode24('        uses: actions/setup-python@v5\n')).toEqual(['actions/setup-python@v5 (needs v6+)']);
    expect(actionsBelowNode24('      - uses: actions/checkout@v7\n')).toEqual([]);
  });

  it('flags an action it has no minimum for', () => {
    expect(actionsBelowNode24('      - uses: someone/new-action@v1\n')).toEqual(['someone/new-action (not in MIN_NODE24_MAJOR)']);
  });
});

describe('workflow runtime', () => {
  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const source = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');

    it(`${file} runs on a pinned runner image, not a -latest label`, () => {
      expect(floatingRunners(source)).toEqual([]);
    });

    it(`${file} uses only action versions that run on Node 24`, () => {
      expect(actionsBelowNode24(source)).toEqual([]);
    });

    it(`${file} keeps no cache or artifact path under /tmp`, () => {
      expect(tmpfsPaths(source)).toEqual([]);
    });
  }
});
