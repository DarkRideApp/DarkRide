# @darkrideapp/plugin-sdk

Plugin authoring SDK for [DarkRide](https://github.com/DarkRideApp/DarkRide).

Plugins use this package to:

- Get the `definePlugin()` helper for declaring plugin metadata.
- Type their `register(ctx)` and `start(ctx)` functions against `PluginContext`.
- Type host service shapes they receive via `ctx` (`CloudStorageService`, `FileStorageService`, etc.).

## Quick start

```typescript
import { definePlugin } from '@darkrideapp/plugin-sdk';

export default definePlugin({
  name: 'my-plugin',
  version: '0.1.0',
  register(ctx) {
    ctx.api(api => {
      api.get('/v1/my-plugin/ping', (_req, res) => res.json({ pong: true }));
    });
  },
});
```

See the host repo for the full plugin authoring guide.

## Development

The SDK uses two tsconfig files: `tsconfig.json` (backend, CommonJS, no JSX) and
`tsconfig.react.json` (React subpath, JSX). `npm run build` runs both passes.
`npm run watch` only watches the backend pass; if you're iterating on the
`/react` subpath, run `tsc -p tsconfig.react.json -w` in a separate terminal.

## License

AGPL-3.0
