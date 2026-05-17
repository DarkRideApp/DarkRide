# DarkRide Plugin Authoring

A DarkRide plugin is a self-contained TypeScript package under `plugins/` that hooks into the server's lifecycle and UI without modifying core code. Plugins declare what they contribute — nav items, pages, API endpoints, DB tables, AI tools, jobs, settings — and the plugin manager wires everything together at startup. Plugins can also expose typed services to each other through a peer registry, letting them build on each other in a structured way.

## Hello World (5 minutes)

The fastest way to go from "I want to build a plugin" to "it's running in my browser":

```bash
# Scaffold a new plugin — prompts for name and description
npx darkride plugin create
# Plugin name: hello-world
# Description: My first DarkRide plugin

# Plugins are auto-discovered via Vite's import.meta.glob.
# Just restart the dev server and your new plugin appears.
npx darkride plugin dev
```

Open http://localhost:5173/ui in your browser. You'll see "Hello World" in the sidebar (under the Tools group). Click it — the default scaffolded page loads.

Now open `plugins/hello-world/frontend/pages/Main.tsx` in your editor. Change the heading, save, and the page hot-reloads.

That's the full development loop. Next:

- Edit `plugins/hello-world/darkride-plugin.ts` to register more extension points (routes, tools, settings, etc. — see below)
- Edit `plugins/hello-world/backend/routes.ts` to add API endpoints
- Run `npx vitest run plugins/hello-world/` to execute the generated plugin-load test

> **Note:** `plugins/*` is gitignored in this repo (except `plugins/kitchen-sink/`). Your scaffold will show as untracked in `git status`; that's intentional — the host repo is core-only, plugins live in their own repos. For a publishable standalone plugin, see [`development.md` → "Plugins outside the core tree"](../development.md) or set `DARKRIDE_PLUGIN_DIRS`.

## Core concepts

**Lifecycle.** Every plugin goes through three phases: `register(ctx)`, `start(ctx)`, and `stop(ctx)`. `register` is synchronous — use it to declare contributions (nav, pages, settings, DB tables). `start` runs after all plugins have registered, in dependency order — use it to build services, call peer plugins, and register routes or jobs that need constructed services. `stop` runs in reverse order during graceful shutdown.

**The ctx surface.** Everything a plugin needs is injected through `ctx`: `ctx.db(schema)` for typed DB access, `ctx.notify(...)` for user notifications, `ctx.files()` for namespaced file storage, `ctx.peer<T>(name)` to get a peer plugin's service, `ctx.hooks` for the event bus, and `ctx.logger()` for structured logging. There is no per-plugin wiring file.

**Extension points.** Plugins contribute to the app by calling `ctx` methods in `register` or `start`: `ctx.nav()`, `ctx.pages()`, `ctx.api()`, `ctx.tools()`, `ctx.jobs()`, `ctx.settingsDefs()`, `ctx.uiSlots()`, `ctx.uiContributions()`, and more. Each contribution type is handled by the plugin manager and made available to the rest of the app without any manual wiring.

## Deep-dive docs

- [Lifecycle and core dependencies](lifecycle.md) — `definePlugin`, `register`/`start`/`stop`, `exposeService`/`peer`, `ctx` surface reference
- [UI: nav, pages, slots, typed primitives](ui.md) — sidebar nav, page routes, `<ExtensionSlot>`, `<ButtonList>`, `<NavItemList>`
- [Backend: APIs, DB, tools, jobs, settings, hooks, files](backend.md) — `ctx.api()`, `ctx.routes()`, Drizzle tables, migrations, tools, tool contexts, jobs, settings, commands, notification events, hooks, file storage
- [Frontend wiring](frontend.md) — `frontend/plugin.ts`, `pluginRegistry`, auto-discovery
- [Testing and dependencies](testing.md) — plugin load tests, `createPluginTestHarness`, dependency declarations

## Where to look for X

| Question | Doc |
|---|---|
| How do I add a sidebar link? | [ui.md — Navigation](ui.md#navigation) |
| How do I add a page? | [ui.md — Pages](ui.md#pages) |
| How do I let other plugins inject UI into my page? | [ui.md — UI Slots](ui.md#ui-slots) |
| How do I contribute a button to another plugin's toolbar? | [ui.md — Typed UI primitives](ui.md#typed-ui-primitives) |
| How do I expose a REST endpoint? | [backend.md — API Endpoints](backend.md#api-endpoints) |
| How do I create a DB table? | [backend.md — Database Tables](backend.md#database-tables) |
| How do I run a database migration? | [backend.md — Adding a migration](backend.md#adding-a-migration) |
| How do I register an AI / MCP tool? | [backend.md — Unified Tools](backend.md#unified-tools) |
| How do I schedule a background job? | [backend.md — Jobs](backend.md#jobs) |
| How do I add a setting? | [backend.md — Settings](backend.md#settings) |
| How do I subscribe to core events? | [backend.md — Hooks](backend.md#hooks) |
| How do I store files? | [backend.md — File Storage](backend.md#file-storage) |
| How do I call another plugin's service? | [lifecycle.md — Service registry](lifecycle.md#service-registry-exposeservice--peer--hasPeer) |
| What's available on ctx? | [lifecycle.md — Core dependencies on ctx](lifecycle.md#core-dependencies-on-ctx) |
| How do I register frontend pages? | [frontend.md](frontend.md) |
| How do I write a plugin test? | [testing.md](testing.md) |
| How do I test with a real DB and routes? | [testing.md — createPluginTestHarness](testing.md#full-lifecycle-testing-with-createplugintestharness) |
