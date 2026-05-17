import { createInterface } from 'readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// tsconfig uses CommonJS output, so __dirname is available natively at runtime
// (both in tsx dev mode and in the compiled dist/ output).

// --- Exported helper functions (used by tests) ---

export function toSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

export function toPascalCase(slug: string): string {
  return slug
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function toLabel(slug: string): string {
  return slug
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.split(`{{${key}}}`).join(value);
  }
  return result;
}

// --- Interactive prompt helper ---
//
// rl.question() is unreliable with piped stdin in Node v24: remaining lines
// are consumed as 'line' events before the next question() call resolves.
// We buffer all lines upfront and dequeue them for each prompt instead.

interface PromptInterface {
  ask(question: string): Promise<string>;
  close(): void;
}

function createPromptInterface(): PromptInterface {
  const lineQueue: string[] = [];
  const waiters: Array<(line: string) => void> = [];

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  rl.on('line', (line: string) => {
    if (waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter(line);
    } else {
      lineQueue.push(line);
    }
  });

  return {
    ask(question: string): Promise<string> {
      process.stdout.write(question);
      if (lineQueue.length > 0) {
        const line = lineQueue.shift()!;
        process.stdout.write(line + '\n');
        return Promise.resolve(line);
      }
      return new Promise(resolve => {
        waiters.push((line: string) => {
          process.stdout.write(line + '\n');
          resolve(line);
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

// --- Main command ---

export async function pluginCreate(): Promise<void> {
  const prompter = createPromptInterface();

  try {
    console.log('\nDarkRide Plugin Scaffolder\n');

    // Collect plugin name
    let rawName = '';
    while (!rawName) {
      rawName = (await prompter.ask('Plugin name (e.g. "My Cool Plugin"): ')).trim();
      if (!rawName) {
        console.error('  Name cannot be empty.');
      }
    }

    const slug = toSlug(rawName);
    const defaultDescription = `${toLabel(slug)} plugin`;

    const description = (await prompter.ask(`Description [${defaultDescription}]: `)).trim() || defaultDescription;

    const pluginsDir = resolve('./plugins');
    const pluginDir = join(pluginsDir, slug);

    if (existsSync(pluginDir)) {
      console.error(`\nError: Plugin directory already exists: ${pluginDir}`);
      process.exit(1);
    }

    const label = toLabel(slug);
    const pascalName = toPascalCase(slug);
    const slugUnderscore = slug.replace(/-/g, '_');
    const npmName = `@darkrideapp/plugin-${slug}`;

    const vars: Record<string, string> = {
      name: npmName,
      slug,
      label,
      pascalName,
      description,
      slug_underscore: slugUnderscore,
    };

    // Templates are .tpl files — tsc doesn't copy them to dist/ during build.
    // In dev (__dirname = bin/commands) → bin/templates/plugin
    // In prod (__dirname = dist/bin/commands) → ../../bin/templates/plugin (source tree)
    const devTemplates = join(__dirname, '..', 'templates', 'plugin');
    const prodTemplates = join(__dirname, '..', '..', '..', 'bin', 'templates', 'plugin');
    const templatesDir = existsSync(devTemplates) ? devTemplates : prodTemplates;

    // Confirm
    console.log(`\nCreating plugin "${slug}" at plugins/${slug}/`);
    const confirm = (await prompter.ask('Continue? [Y/n]: ')).trim().toLowerCase();
    if (confirm === 'n' || confirm === 'no') {
      console.log('Aborted.');
      return;
    }

    // Create directory structure
    const dirs = [
      pluginDir,
      join(pluginDir, 'backend'),
      join(pluginDir, 'frontend'),
      join(pluginDir, 'frontend', 'pages'),
      join(pluginDir, '__tests__'),
      join(pluginDir, 'migrations', 'meta'),
    ];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
    }

    // Helper to read a template and render it
    const writeFromTemplate = (tplName: string, outPath: string) => {
      const tplPath = join(templatesDir, tplName);
      const template = readFileSync(tplPath, 'utf-8');
      const rendered = renderTemplate(template, vars);
      writeFileSync(outPath, rendered, 'utf-8');
    };

    // Write migration journal stub
    const journalStub = JSON.stringify({ version: '7', dialect: 'sqlite', entries: [] }, null, 2) + '\n';
    writeFileSync(join(pluginDir, 'migrations', 'meta', '_journal.json'), journalStub, 'utf-8');

    // Write files
    writeFromTemplate('package.json.tpl', join(pluginDir, 'package.json'));
    writeFromTemplate('darkride-plugin.ts.tpl', join(pluginDir, 'darkride-plugin.ts'));
    writeFromTemplate('backend-schema.ts.tpl', join(pluginDir, 'backend', 'schema.ts'));
    writeFromTemplate('backend-routes.ts.tpl', join(pluginDir, 'backend', 'routes.ts'));
    writeFromTemplate('frontend-plugin.ts.tpl', join(pluginDir, 'frontend', 'plugin.ts'));
    writeFromTemplate('frontend-page.tsx.tpl', join(pluginDir, 'frontend', 'pages', 'Main.tsx'));
    writeFromTemplate('test-plugin-load.ts.tpl', join(pluginDir, '__tests__', 'plugin-load.test.ts'));

    // frontend/plugins.ts uses import.meta.glob to auto-discover plugins —
    // no manual import registration needed. The new plugin is picked up
    // automatically on the next Vite start.

    console.log(`\nPlugin "${slug}" created successfully!\n`);
    console.log(`  plugins/${slug}/`);
    console.log(`  ├── package.json`);
    console.log(`  ├── darkride-plugin.ts`);
    console.log(`  ├── backend/`);
    console.log(`  │   ├── schema.ts`);
    console.log(`  │   └── routes.ts`);
    console.log(`  ├── frontend/`);
    console.log(`  │   ├── plugin.ts`);
    console.log(`  │   └── pages/Main.tsx`);
    console.log(`  ├── migrations/`);
    console.log(`  │   └── meta/_journal.json`);
    console.log(`  └── __tests__/`);
    console.log(`      └── plugin-load.test.ts`);
    console.log('');
    console.log(`Next steps:`);
    console.log(`  1. Edit plugins/${slug}/darkride-plugin.ts to add features`);
    console.log(`  2. Run: npx vitest run plugins/${slug}/__tests__/`);
    console.log('');
    console.log(`Note: plugins/* is gitignored in this repo except for kitchen-sink.`);
    console.log(`Your scaffold will show as untracked in 'git status' — that's expected.`);
    console.log(`For a standalone (publishable) plugin, see docs/development.md > "Plugins`);
    console.log(`outside the core tree" or set DARKRIDE_PLUGIN_DIRS.`);
    console.log('');
  } finally {
    prompter.close();
  }
}
