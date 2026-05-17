import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

interface PluginInfo {
  name: string;
  version: string;
  description?: string;
}

export function formatPluginTable(plugins: PluginInfo[]): string {
  if (plugins.length === 0) {
    return 'No plugins installed.\n\nRun `darkride plugin create` to scaffold a new plugin.';
  }

  const nameWidth = Math.max(4, ...plugins.map(p => p.name.length));
  const versionWidth = Math.max(7, ...plugins.map(p => p.version.length));

  const header = `  ${'Name'.padEnd(nameWidth)}  ${'Version'.padEnd(versionWidth)}  Description`;
  const rows = plugins.map(p =>
    `  ${p.name.padEnd(nameWidth)}  ${p.version.padEnd(versionWidth)}  ${p.description || ''}`
  );

  return [header, ...rows, '', `  ${plugins.length} plugin${plugins.length === 1 ? '' : 's'} installed`].join('\n');
}

export async function pluginList(): Promise<void> {
  const pluginsDir = resolve('./plugins');

  if (!existsSync(pluginsDir)) {
    console.log(formatPluginTable([]));
    return;
  }

  const entries = readdirSync(pluginsDir, { withFileTypes: true });
  const plugins: PluginInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = join(pluginsDir, entry.name, 'package.json');
    if (!existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (!pkg.keywords?.includes('darkride-plugin')) continue;
      plugins.push({
        name: pkg.name?.replace(/^@[^/]+\//, '') || entry.name,
        version: pkg.version || '0.0.0',
        description: pkg.description,
      });
    } catch {}
  }

  console.log(formatPluginTable(plugins));
}
