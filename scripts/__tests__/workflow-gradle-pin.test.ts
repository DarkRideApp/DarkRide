import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOWS_DIR = path.resolve(__dirname, '../../.github/workflows');

// A bare `gradle` command (not ./gradlew) uses whatever the runner image ships.
const BARE_GRADLE = /^\s*gradle\s+\S/m;
const SETUP_GRADLE = /uses:\s*gradle\/actions\/setup-gradle@\S+[\s\S]*?gradle-version:\s*'?\d+\.\d+/;

function usesUnpinnedGradle(source: string): boolean {
  return BARE_GRADLE.test(source) && !SETUP_GRADLE.test(source);
}

describe('workflow gradle pin', () => {
  it('flags a bare gradle command with no pinned setup step', () => {
    expect(usesUnpinnedGradle('run: |\n  gradle wrapper --gradle-version 8.10\n')).toBe(true);
  });

  it('accepts a bare gradle command after a setup step that pins the version', () => {
    const source = [
      '- uses: gradle/actions/setup-gradle@v4',
      '  with:',
      "    gradle-version: '8.10'",
      '- run: |',
      '    gradle assembleDebug',
    ].join('\n');
    expect(usesUnpinnedGradle(source)).toBe(false);
  });

  it('does not flag the project wrapper', () => {
    expect(usesUnpinnedGradle('run: |\n  ./gradlew assembleDebug\n')).toBe(false);
  });

  for (const file of readdirSync(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    it(`${file} pins the Gradle it runs`, () => {
      const source = readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
      expect(usesUnpinnedGradle(source)).toBe(false);
    });
  }
});
