// Plugin frontend manifest.
//
// Plugin frontend entries are auto-discovered at build time via Vite's
// import.meta.glob. Two source paths are scanned:
//
// 1. `<host>/plugins/<name>/frontend/plugin.ts` — workspace plugins (in-tree
//    development; e.g. kitchen-sink, or `git clone` of an extracted plugin
//    into the workspace).
// 2. `<host>/data/installed-plugins/node_modules/@<scope>/plugin-<name>/frontend/plugin.ts`
//    — plugins installed via the marketplace UI. Vite's glob runs at build
//    time, so installing a new plugin requires the dev server to restart
//    (or production rebuild) before the plugin's frontend executes.
//
// The `eager: true` option resolves the imports synchronously so plugin side
// effects (e.g. pluginRegistry.registerPages, pluginRegistry.registerDecoders)
// run before the main App component mounts.
//
// Note: this assumes the default DARKRIDE_DATA_ROOT (`./data/`). Hosts that
// override the data root via env var won't have their managed plugins
// frontend-loaded by this glob — they need to use workspace mode.

const pluginModules = {
  ...import.meta.glob('../plugins/*/frontend/plugin.ts', { eager: true }),
  ...import.meta.glob('../data/installed-plugins/node_modules/@*/plugin-*/frontend/plugin.ts', { eager: true }),
};

// Reference the result so Vite doesn't tree-shake the imports away.
// The side effects inside each plugin.ts are what register the plugin.
export const loadedPluginCount = Object.keys(pluginModules).length;
