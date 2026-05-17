import type { PluginDefinition } from '@darkrideapp/plugin-sdk';

export interface LoadOrderEntry {
  name: string;
  definition: PluginDefinition;
}

/**
 * Topologically sort plugin definitions by their `dependencies` and
 * `optionalDependencies` fields. Returns the names in a load-safe order
 * (a dependency always appears before its dependents).
 *
 * Throws on missing required dependencies or circular dependencies.
 * Optional dependencies are followed if present, ignored if not.
 */
export function computeLoadOrder(plugins: LoadOrderEntry[]): string[] {
  const byName = new Map<string, PluginDefinition>();
  for (const { name, definition } of plugins) byName.set(name, definition);

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular dependency detected involving plugin "${name}"`);
    }

    const def = byName.get(name);
    if (!def) {
      throw new Error(`Missing required dependency: "${name}"`);
    }

    visiting.add(name);

    for (const dep of def.dependencies) {
      if (!byName.has(dep)) {
        throw new Error(`Missing required dependency: "${dep}" (required by "${name}")`);
      }
      visit(dep);
    }

    for (const dep of def.optionalDependencies ?? []) {
      if (byName.has(dep)) {
        visit(dep);
      }
    }

    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };

  for (const { name } of plugins) {
    visit(name);
  }

  return order;
}
