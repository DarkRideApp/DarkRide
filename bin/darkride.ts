// Entry point for the darkride CLI. Invoked via bin/darkride.js (the bootstrap
// wrapper) so we don't need a shebang here — whoever loads this file is
// already inside a Node/tsx process.
import { pluginList } from './commands/plugin-list';
import { pluginCreate } from './commands/plugin-create';
import { pluginDev } from './commands/plugin-dev';

const HELP = `
DarkRide CLI

Usage: darkride <command>

Commands:
  plugin list         List installed plugins
  plugin create       Scaffold a new plugin (interactive)
  plugin dev          Start development server
  plugin test         Run tests for a plugin
  plugin trust-key    Add a trusted signing key
  plugin revoke-key   Remove a trusted signing key
  admin create        Create an admin user

Options:
  --help, -h      Show this help message
  --version, -v   Show version

Run 'darkride <command> --help' for command-specific help.
`.trim();

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    try {
      const { readFileSync, existsSync } = await import('fs');
      const { resolve } = await import('path');
      // In dev (__dirname = bin/) → ../package.json
      // In prod (__dirname = dist/bin/) → ../../package.json (project root)
      const devPkg = resolve(__dirname, '..', 'package.json');
      const prodPkg = resolve(__dirname, '..', '..', 'package.json');
      const pkgPath = existsSync(devPkg) ? devPkg : prodPkg;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      console.log(`darkride v${pkg.version}`);
    } catch {
      console.log('darkride (unknown version)');
    }
    process.exit(0);
  }

  if (args[0] === 'admin' && args[1] === 'create') {
    const { adminCreate } = await import('./commands/admin-create');
    await adminCreate(args.slice(2));
    process.exit(0);
  }

  if (args[0] === 'admin') {
    const subcommand = args[1];
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      console.log(`
DarkRide Admin Commands

Usage: darkride admin <command>

Commands:
  create   Create an admin user
`.trim());
      process.exit(0);
    }
    console.error(`Unknown command: darkride admin ${subcommand}`);
    console.error(`Run 'darkride admin --help' for available commands.`);
    process.exit(1);
  }

  if (args[0] === 'plugin') {
    const subcommand = args[1];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      console.log(`
DarkRide Plugin Commands

Usage: darkride plugin <command>

Commands:
  list            List installed plugins
  create          Scaffold a new plugin (interactive)
  dev             Start development server
  test            Run tests for a plugin
  add-migration   Add a new SQL migration to a plugin
  sign            Sign a plugin registry file (or generate a keypair)
  trust-key       Add a trusted signing key
  revoke-key      Remove a trusted signing key
`.trim());
      process.exit(0);
    }

    switch (subcommand) {
      case 'list':
        await pluginList();
        break;
      case 'create':
        await pluginCreate();
        break;
      case 'dev':
        await pluginDev();
        break;
      case 'test': {
        const { runPluginTest } = await import('./commands/plugin-test');
        runPluginTest(args.slice(2));
        break;
      }
      case 'sign': {
        const { runPluginSign } = await import('./commands/plugin-sign');
        runPluginSign(args.slice(2));
        break;
      }
      case 'trust-key': {
        const { runPluginTrustKey } = await import('./commands/plugin-trust-key');
        runPluginTrustKey(args.slice(2));
        break;
      }
      case 'revoke-key': {
        const { runPluginRevokeKey } = await import('./commands/plugin-trust-key');
        runPluginRevokeKey(args.slice(2));
        break;
      }
      case 'add-migration': {
        const { pluginAddMigration } = await import('./commands/plugin-add-migration');
        await pluginAddMigration(args.slice(2));
        break;
      }
      default:
        console.error(`Unknown command: darkride plugin ${subcommand}`);
        console.error(`Run 'darkride plugin --help' for available commands.`);
        process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: darkride ${args[0]}`);
  console.error(`Run 'darkride --help' for available commands.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
