import { describe, it, expect } from 'vitest';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';
import { resolve } from 'path';

// Test the public entry point — the Node wrapper that users actually invoke
// via `npx darkride`. This exercises the dev-mode tsx fallback path and
// ensures the wrapper's command routing works end to end.
const CLI = resolve('./bin/darkride.js');
const opts: ExecSyncOptionsWithStringEncoding = {
  cwd: resolve('.'),
  encoding: 'utf-8',
  stdio: 'pipe',
};

function run(args: string): string {
  return execSync(`node ${CLI} ${args}`, opts);
}

function runExpectFail(args: string): { stderr: string; status: number } {
  try {
    execSync(`node ${CLI} ${args}`, opts);
    return { stderr: '', status: 0 };
  } catch (err: any) {
    return { stderr: err.stderr || '', status: err.status || 1 };
  }
}

describe('darkride CLI', () => {
  it('shows help with --help', () => {
    const output = run('--help');
    expect(output).toContain('DarkRide CLI');
    expect(output).toContain('plugin list');
    expect(output).toContain('plugin create');
    expect(output).toContain('plugin dev');
  });

  it('shows help with -h', () => {
    const output = run('-h');
    expect(output).toContain('DarkRide CLI');
  });

  it('shows help with no args', () => {
    const output = run('');
    expect(output).toContain('DarkRide CLI');
  });

  it('shows version with --version', () => {
    const output = run('--version');
    expect(output).toMatch(/^darkride v\d+\.\d+\.\d+/);
  });

  it('shows version with -v', () => {
    const output = run('-v');
    expect(output).toMatch(/^darkride v/);
  });

  it('shows plugin subcommand help', () => {
    const output = run('plugin --help');
    expect(output).toContain('Plugin Commands');
    expect(output).toContain('list');
    expect(output).toContain('create');
    expect(output).toContain('dev');
  });

  it('shows plugin help with no subcommand', () => {
    const output = run('plugin');
    expect(output).toContain('Plugin Commands');
  });

  it('errors on unknown command', () => {
    const { stderr, status } = runExpectFail('bogus');
    expect(status).toBe(1);
    expect(stderr).toContain('Unknown command');
  });

  it('errors on unknown plugin subcommand', () => {
    const { stderr, status } = runExpectFail('plugin bogus');
    expect(status).toBe(1);
    expect(stderr).toContain('Unknown command');
  });

  it('plugin list runs successfully', () => {
    const output = run('plugin list');
    expect(output).toMatch(/\d+ plugins? installed/);
  });
});
