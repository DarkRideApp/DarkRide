# DarkRide Development Guide

This guide is for developers working on DarkRide itself. If you maintain private plugins on the side, the multi-repo workflow below describes how to develop them alongside the core.

## Repo structure

DarkRide is a public core; plugins live in their own repos and are loaded at runtime (or symlinked in for active workspace dev). The host loader picks up whatever is present.

| Repo | Visibility | Role |
|---|---|---|
| `DarkRideApp/DarkRide` | Public | Core platform — backend, frontend, CLI, in-tree `kitchen-sink` example plugin. |
| `your-org/your-plugin` | Yours | Whatever you build on top of the core. Multiple are common. |

## First-time setup

```bash
# 1. Clone the public core
gh repo clone DarkRideApp/DarkRide ~/projects/darkride
cd ~/projects/darkride

# 2. Install dependencies
npm install

# 3. Run the dev server
npm run dev
```

The core ships with a single in-tree plugin (`plugins/kitchen-sink`) as a
worked example. You can develop the entire core without any other plugins;
it boots fine with just kitchen-sink present.

### Adding plugins for dev

Plugins live in their own repos and are loaded at runtime — they don't
need to be checked into `plugins/`. Point the loader at the plugin's
working tree with `DARKRIDE_PLUGIN_DIRS`:

```bash
# Linux/macOS — colon-separated list of plugin source trees
DARKRIDE_PLUGIN_DIRS=~/projects/your-plugin-a:~/projects/your-plugin-b \
  npm run dev
```

For active plugin development where you want npm workspace semantics
(shared peer-deps, HMR), symlink the plugin into `plugins/<name>/`:

```bash
ln -s ~/projects/your-plugin ~/projects/darkride/plugins/your-plugin
npm install  # picks up the new workspace
```

Don't commit the lockfile after symlinking — the CI lockfile-hygiene job
fails the build if any `plugins/*` workspace other than `kitchen-sink`
appears in `package-lock.json`. Either unlink before committing or
revert the lockfile.

**Run with a subset of plugins:** Set the `DARKRIDE_PLUGINS` env var to a
comma-separated list of plugin names to load only those (and their required
dependencies). Useful when working on a single plugin without spinning up
external service deps from unrelated plugins.

```bash
DARKRIDE_PLUGINS=kitchen-sink npm run dev
```

## Day-to-day workflow

### Editing core

```bash
cd ~/projects/darkride
# edit backend/, frontend/, shared/, plugins/kitchen-sink/, etc.
git commit -am "fix: …"
git push
```

Changes go to `DarkRideApp/DarkRide`.

### Editing a private plugin

```bash
cd ~/projects/darkride/plugins/your-private-plugin
# edit any files inside this plugin
git commit -am "feat: …"
git push
```

Changes go to that plugin's own repo. The cwd determines which remote you push to — there's no submodule `git submodule update` ceremony.

To avoid booting unrelated plugins while iterating on one, use `DARKRIDE_PLUGINS`:

```bash
DARKRIDE_PLUGINS=your-private-plugin npm run dev
```

### Coordinated changes (core + plugin together)

When a core change requires updates to one or more plugins (e.g. the `PluginContext` API gains a new method), the workflow is:

1. Make all the changes locally — across core and the affected plugins.
2. Run the full test suite + boot test (`npm run dev`) to confirm everything works together.
3. Push core first: `cd ~/projects/darkride && git push`.
4. Push each affected plugin: `cd plugins/<name> && git push`.

Brief race window: between step 3 and step 4, anyone cloning `DarkRideApp/DarkRide` and pulling the latest plugin gets new core + old plugin. For a single-developer project this is acceptable; for a team, push core last after plugins are ready and use a clear PR title indicating the coupling.

### Pulling updates

```bash
cd ~/projects/darkride
git pull
# also pull each plugin you have:
for p in plugins/*/; do
  ( cd "$p" && [ -d .git ] && git pull )
done
```

A simple shell alias makes this one command:

```bash
alias dr-pull='git pull && for p in plugins/*/; do (cd "$p" && [ -d .git ] && git pull); done'
```

## Testing

```bash
npm test                    # full suite (backend + frontend + plugins)
npm run test:frontend       # frontend-only
npx vitest run plugins/<name>/  # one plugin's tests
npx playwright test         # E2E
```

Tests work whether or not private plugins are present. The test-utils helper applies migrations from each `plugins/<name>/migrations/` directory it finds.

Backend test pattern:
- In-memory SQLite (`new Database(':memory:')`) with raw SQL table creation
- `clearEndpoints()` + `getApiRouter()` for API tests via supertest
- Mock services with `vi.fn()` / `vi.mock()`

Frontend runs in jsdom (`vitest.config.frontend.ts`); Python tests run via pytest (`.venv/bin/python -m pytest python/`).

## Adding a plugin migration

Each plugin owns its own migration sequence under `plugins/<name>/migrations/`. Use the CLI to add one:

```bash
darkride plugin add-migration <plugin-name> <migration-name>
# Example:
darkride plugin add-migration my-plugin add_user_settings
```

This creates `plugins/<plugin-name>/migrations/<NNNN>_<migration-name>.sql` with a starter template and appends a correctly sequenced entry to the plugin's `migrations/meta/_journal.json`. Edit the generated SQL file, then restart the dev server — migrations apply at boot.

**Don't edit `_journal.json` by hand.** The `when` timestamp must be strictly greater than every prior entry across the whole file; the CLI computes this correctly. A bad `when` silently skips the migration on any existing database.

Migrations apply at server boot: core first, then each plugin in topological dependency order. Hash-based dedup means already-applied migrations are skipped.

There is no `drizzle-kit generate` integration per-plugin — write the SQL by hand. The plugin loader doesn't require Drizzle snapshots at runtime.

For the full migration API reference, see [docs/plugins/backend.md — Adding a migration](plugins/backend.md#adding-a-migration).

## Releasing

### Public DarkRide

Push to `DarkRideApp/DarkRide` triggers the GitHub Actions CI (build + tests). When green, the change is live for anyone tracking that repo.

### Private plugins

Push to your own plugin repo. Each private plugin's main branch is the source of truth; whoever needs a private plugin clones it directly into `plugins/<name>/`.

### Coordinating versions

There's no formal versioning between core and plugins today. Both move together. If a plugin starts requiring a specific core API version, declare it via `darkride: '^X.Y.Z'` in the plugin's `package.json` (the field is read by the plugin loader; see `shared/plugins/types.ts`).

## Troubleshooting

**`Cannot find module '@octokit/rest'`** (or similar plugin dep)
- Run `npm install` from the repo root. With npm workspaces enabled, this walks every `plugins/*/` and installs each plugin's deps.

**`Plugin "<name>" failed to start: <error>`**
- A required peer plugin is missing or threw during `start()`. Check the plugin's `dependencies` in its `darkride-plugin.ts`. Install the missing private plugin or remove the dependent one.

**Migration applied twice**
- If `__drizzle_migrations` shows duplicate hashes for the same migration, this happened during the per-plugin migration cutover (one entry from when the migration lived in core, one after relocation). It's harmless — content is byte-identical and the migrator skips re-application.

**`pluginManager.startAll()` aborts with timeout**
- A plugin's `start()` hung past 30s. Check the plugin's `start()` for awaited operations that could block. Override per-plugin via `startTimeoutMs` in the plugin manifest if you genuinely need longer.

## Reference

- Plugin authoring (lifecycle, peer services, ctx APIs): `docs/plugins/README.md` (and sub-docs under `docs/plugins/`)
- Architecture overview: `docs/ARCHITECTURE.md`
- Database / migrations: `docs/db-migrations.md`
