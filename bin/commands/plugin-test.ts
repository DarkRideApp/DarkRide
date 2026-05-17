import { execSync } from 'child_process';
import { resolve, join } from 'path';
import { existsSync, readdirSync } from 'fs';

const HELP = `
Run tests for a DarkRide plugin.

Usage: darkride plugin test <plugin-name> [options]

Options:
  --unit            Run only unit tests (__tests__/*.test.ts)
  --integration     Run only integration tests (__tests__/integration.test.ts)
  --e2e             Run only end-to-end tests (__tests__/e2e/)
  --all             Run all test types including e2e (default: unit + integration)
  --help, -h        Show this help message

Examples:
  darkride plugin test kitchen-sink
  darkride plugin test kitchen-sink --integration
  darkride plugin test kitchen-sink --all
`.trim();

export function runPluginTest(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const pluginName = args.find((a) => !a.startsWith('--'));
  const flags = args.filter((a) => a.startsWith('--'));

  if (!pluginName) {
    console.error(
      'Error: Plugin name required.\n\nUsage: darkride plugin test <plugin-name>\n\nRun \'darkride plugin test --help\' for options.',
    );
    process.exit(1);
  }

  const hasExplicitFlag =
    flags.includes('--unit') ||
    flags.includes('--integration') ||
    flags.includes('--e2e') ||
    flags.includes('--all');

  // Default: unit + integration. --all adds e2e.
  const runUnit =
    !hasExplicitFlag || flags.includes('--unit') || flags.includes('--all');
  const runIntegration =
    !hasExplicitFlag ||
    flags.includes('--integration') ||
    flags.includes('--all');
  const runE2e = flags.includes('--e2e') || flags.includes('--all');

  // Find plugin directory
  const pluginDir = resolve('plugins', pluginName);

  if (!existsSync(pluginDir)) {
    console.error(`Error: Plugin directory not found: ${pluginDir}`);
    process.exit(1);
  }

  const testDir = join(pluginDir, '__tests__');
  let hasFailure = false;

  console.log(`Testing plugin: ${pluginName} (${pluginDir})\n`);

  if (runUnit) {
    console.log('=== Unit Tests ===');
    if (existsSync(testDir)) {
      // Collect all *.test.ts files except integration.test.ts
      const unitFiles = readdirSync(testDir)
        .filter((f) => f.endsWith('.test.ts') && f !== 'integration.test.ts')
        .map((f) => join(testDir, f));

      if (unitFiles.length === 0) {
        console.log('  No unit test files found, skipping\n');
      } else {
        const paths = unitFiles.map((f) => `"${f}"`).join(' ');
        try {
          execSync(`npx vitest run ${paths} --reporter=verbose`, {
            stdio: 'inherit',
            cwd: resolve('.'),
            timeout: 120_000,
          });
        } catch {
          hasFailure = true;
        }
      }
    } else {
      console.log('  No __tests__/ directory found, skipping\n');
    }
  }

  if (runIntegration) {
    console.log('\n=== Integration Tests ===');
    const integrationFile = join(testDir, 'integration.test.ts');
    if (existsSync(integrationFile)) {
      try {
        execSync(
          `npx vitest run "${integrationFile}" --reporter=verbose`,
          {
            stdio: 'inherit',
            cwd: resolve('.'),
            timeout: 120_000,
          },
        );
      } catch {
        hasFailure = true;
      }
    } else {
      console.log('  No integration.test.ts found, skipping\n');
    }
  }

  if (runE2e) {
    console.log('\n=== E2E Tests ===');
    const e2eDir = join(testDir, 'e2e');
    if (existsSync(e2eDir)) {
      try {
        execSync(`npx playwright test "${e2eDir}"`, {
          stdio: 'inherit',
          cwd: resolve('.'),
          timeout: 180_000,
        });
      } catch {
        hasFailure = true;
      }
    } else {
      console.log('  No __tests__/e2e/ directory found, skipping\n');
    }
  }

  if (hasFailure) {
    process.exitCode = 1;
  }
}
