# Plugin Testing and Dependencies

## Dependencies

Declare plugin dependencies in the definition:

```typescript
definePlugin({
  name: 'my-plugin',
  dependencies: ['other-plugin'],           // required — fails to load without it
  optionalDependencies: ['nice-to-have'],   // enhanced if present
  // ...
});
```

The plugin manager resolves load order from the dependency graph and rejects circular dependencies.

## Testing

Two patterns depending on where the plugin lives:

- **In-tree (workspace) plugins** under `plugins/<slug>/` can import directly from `backend/` since the host's source tree is right there. This is the simplest path and what the examples below show.
- **Standalone (published) plugins** in their own repo can't reach `backend/`. Instead, import the SDK + your own decoders/services directly and exercise them with stubs. See the BLIP / MQTT decoder repos for a working pattern, or the "Standalone plugins → `:memory:` + stubs" section of the `authoring-darkride-plugins` skill.

### In-tree: smoke test

Write a plugin load test at `__tests__/plugin-load.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PluginManager } from '../../../backend/plugins/plugin-manager';

describe('My Plugin', () => {
  it('loads and registers all extension points', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);

    const meta = manager.getPluginMetadata()[0];
    expect(meta.name).toBe('my-plugin');
    expect(meta.nav).toHaveLength(1);
    expect(meta.pages).toHaveLength(1);
  });

  it('does not collide with other plugin table names', async () => {
    const module = await import('../darkride-plugin');
    const manager = new PluginManager();
    manager.loadPlugin(module.default);
    expect(() => manager.validateTableNames()).not.toThrow();
  });
});
```

Run with: `npx vitest run plugins/my-plugin/`

### Full lifecycle testing with createPluginTestHarness

For integration tests that need real DB queries, routes, or service interactions, use `createPluginTestHarness` from `backend/test-utils/plugin-harness.ts`. It spins up an in-memory SQLite database with all core and plugin migrations applied, loads the plugin, wires a full Express app, and exposes an `AiToolRegistry` with the plugin's tools registered.

```typescript
import { createPluginTestHarness } from '../../../backend/test-utils/plugin-harness';
import request from 'supertest';

describe('My Plugin — integration', () => {
  it('returns items from the API', async () => {
    const harness = await createPluginTestHarness({
      pluginDir: 'plugins/my-plugin',
      start: true,   // runs register() → start() so routes from start() are available
    });

    const res = await request(harness.app).get('/v1/my-plugin/items');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeInstanceOf(Array);

    await harness.cleanup();
  });
});
```

**Key options:**

| Option | Type | Description |
|---|---|---|
| `pluginDir` | `string` | Path to the plugin directory (e.g. `'plugins/my-plugin'`) |
| `start` | `boolean` | When `true`, runs the full `register() → start()` lifecycle. Default: `false` (only `register()` is called — backward-compatible) |
| `additionalPlugins` | `string[]` | Extra plugin directories to load alongside (useful for dependency testing) |
| `seed` | `(db) => void` | Called after DB setup with the raw `better-sqlite3` instance for direct SQL seeding |
| `coreServices` | `object` | Override any stub core service (`cloudStorage`, `notify`, `runner`, `fileSync`) — useful for spying on notifications |

When `start: true`, cleanup() returns a Promise (because `stopAll()` is async) — always `await harness.cleanup()` in that case.

## Reference

The `plugins/kitchen-sink/` directory is a complete reference plugin that exercises every extension point. Read its `darkride-plugin.ts` and `frontend/plugin.ts` to see the full pattern in action.
