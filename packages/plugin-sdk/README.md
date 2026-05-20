# @darkrideapp/plugin-sdk

Plugin authoring SDK for [DarkRide](https://github.com/DarkRideApp/DarkRide).

Plugins use this package to:

- Get the `definePlugin()` helper for declaring plugin metadata.
- Type their `register(ctx)`, `start(ctx)`, and `stop(ctx)` functions against `PluginContext`.
- Type host service shapes they receive via `ctx` (`CloudStorageService`, `FileStorageService`, etc.).

## Quick start

```typescript
import { definePlugin } from '@darkrideapp/plugin-sdk';

export default definePlugin({
  name: 'my-plugin',

  // Synchronous declarative setup — declare contributions, no I/O.
  register(ctx) {
    ctx.nav([{ group: 'Tools', label: 'My Plugin', path: '/my-plugin', icon: 'box' }]);
    ctx.pages([{ path: '/my-plugin' }]);
  },

  // Async runtime setup — services constructed here, register routes that
  // need them. Runs after every plugin's register() has completed.
  async start(ctx) {
    ctx.api(api => {
      api.get('/v1/my-plugin/ping', (_req, res) => res.json({ pong: true }));
    });
  },
});
```

See `docs/plugins/` in the host repo for the full plugin authoring guide,
including the per-plugin migration layout, the `ctx` surface (`ctx.db`,
`ctx.files`, `ctx.notify`, `ctx.settings`, `ctx.dispatcher`, etc.), and the
peer-service pattern.

## Subpath imports

- `@darkrideapp/plugin-sdk` — main entry: `definePlugin`, all types,
  `HookBusImpl`.
- `@darkrideapp/plugin-sdk/utils` — small utilities (`matchesCrontab`).
- `@darkrideapp/plugin-sdk/test-utils` — `createTestDb`, `makePluginHarness`.
- `@darkrideapp/plugin-sdk/react` — `pluginRegistry`, React hooks
  (`useAuth`, `useWebSocket`, `useRestartRequired`, etc.). Only import from
  frontend code; never bundle this into your backend.

## Development

The SDK uses two tsconfig files: `tsconfig.json` (backend, CommonJS, no JSX) and
`tsconfig.react.json` (React subpath, JSX). `npm run build` runs both passes.
`npm run watch` only watches the backend pass; if you're iterating on the
`/react` subpath, run `tsc -p tsconfig.react.json -w` in a separate terminal.

## License

AGPL-3.0
