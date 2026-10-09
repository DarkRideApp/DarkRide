# Installing plugins

## The Plugins page

Open **Plugins** in the sidebar (`/ui/plugins`). It has two tabs:

- **Installed**: what you have. Enable or disable a plugin with its switch, update it, open its details, uninstall it. Plugins that need attention (errors, missing files, updates) sort first, and the filters at the top narrow the list to updates, disabled plugins or errors.
- **Discover**: everything the marketplace lists, with the plugins you already have marked. Search by name, description, author or category, or filter by category.

Click a plugin for its details: author, license, source, signature status, what it needs, what it provides, the AI permissions it asks for, and its settings page when it has one.

**Installing.** Click Install. If the plugin is not signed by a trusted publisher you are asked to confirm first. When the install finishes the plugin shows *Restart to activate*; restart the server from the banner at the top of the page. If the plugin asks for AI permissions, a *Review permissions* button appears on its row once it has loaded.

**Updating.** An update shows as `v1.0.0 → v1.1.0` with an Update button on the row, on either tab. The strip above Installed offers *Update all*. The sidebar badge counts available updates.

**Sources.** *Sources* in the page header opens the source manager. Adding, editing, removing or toggling a source refreshes the marketplace straight away. *Refresh* fetches the latest marketplace data.

Older links keep working: `/ui/marketplace` and `/ui/settings/plugins` redirect to the matching tab, and each plugin's own settings page is still at `/ui/settings/plugins/<name>/settings`.

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
the registry and DarkRide surfaces the error on the Plugins page.

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
