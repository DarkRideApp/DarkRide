# Installing plugins

DarkRide installs plugins via `npm install` into a managed prefix outside
the host repo. Public plugins published to npmjs.com require no extra
setup. Plugins published to a private npm-compatible registry need an
`.npmrc` so npm can authenticate.

## Private registries

If a plugin lives in a private npm registry, configure your host's
`~/.npmrc` (or the host directory's `./.npmrc`) with the standard npm
mechanism:

```
@your-scope:registry=https://your-registry.example.com/api/packages/your-org/npm/
//your-registry.example.com/api/packages/your-org/npm/:_authToken=YOUR_TOKEN
```

Replace `your-scope`, `your-org`, and the registry URL with the values
your registry administrator provides. The `_authToken` is a personal
access token with read access to the registry.

DarkRide does not manage these credentials; the host operator owns them.
If `.npmrc` is missing or malformed, `npm install` returns a 401 from
the registry and DarkRide surfaces the error in the marketplace UI.

## Workspace-mode development

For active plugin development, you can also point DarkRide at a plugin
source tree on disk by setting `DARKRIDE_PLUGIN_DIRS` to a path-delimiter-
separated list of directories:

```bash
# Linux/macOS
DARKRIDE_PLUGIN_DIRS=/path/to/plugin-foo:/path/to/plugin-bar npm run dev

# Windows
set DARKRIDE_PLUGIN_DIRS=C:\path\to\plugin-foo;C:\path\to\plugin-bar
npm run dev
```

DarkRide scans each listed directory for plugin entry files
(`darkride-plugin.ts` or `darkride-plugin.js`). Plugins not found in
any listed directory are not loaded.

If `DARKRIDE_PLUGIN_DIRS` is unset, DarkRide falls back to scanning
`<host>/plugins/` (the default).
