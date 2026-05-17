# Database Migrations

DarkRide owns its migration runner — see `backend/db/migrator.ts`. Migrations
are applied in **idx order** (the journal index, monotonic by definition), not
by `when` timestamp. This avoids the silent-skip class of bug Drizzle's
default migrator suffered from in this codebase.

## Adding a new migration

### Schema-only change (CREATE TABLE, ADD COLUMN, DROP COLUMN, …)

1. Edit `backend/db/schema.ts`.
2. Run `npm run db:generate`.
3. Inspect the generated `migrations/<NNNN>_<auto>.sql` and the new entry in
   `migrations/meta/_journal.json`. drizzle-kit writes `when = Date.now()`
   automatically.
4. Commit `migrations/` and `backend/db/schema.ts`.

### Data migration / seed / cleanup

drizzle-kit can't infer non-schema changes. Use the helper:

1. Find the next free idx (look at `migrations/meta/_journal.json`'s last
   entry, add 1).
2. `npx tsx scripts/append-journal-entry.ts <NEW_IDX> <NNNN_my_change>`
3. Edit the generated empty `migrations/<NNNN>_my_change.sql`.
4. Commit.

The helper guarantees `when > max(prior when)` so the migration can never be
silently skipped on existing DBs.

## Plugin migrations

Each plugin manages its own migration sequence separately from core. Use the CLI rather than editing files by hand:

```bash
darkride plugin add-migration <plugin-name> <migration-name>
```

See [docs/plugins/backend.md — Adding a migration](plugins/backend.md#adding-a-migration) for the full workflow and the rules around `when` monotonicity.

## Repair script for affected DBs

If you discover a DB is missing migrations that should have applied, see
`scripts/repair-skipped-migrations.md`.
