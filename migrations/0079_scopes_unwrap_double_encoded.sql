-- Unwrap double-encoded JSON in scope columns.
--
-- Several writers (claim-manager, bootstrap, system-user, api-key-manager,
-- admin-users) pre-stringified scopes before handing them to Drizzle's
-- mode:'json' columns (users.scopes, api_keys.scopes). Drizzle stringifies
-- again on write, so the stored row is a double-encoded JSON string
-- ('"[\"scope\"]"') instead of a single-encoded array ('["scope"]').
--
-- Every reader defensively parses today, but the single-encoded form is the
-- contract; this migration normalises the data so we can trust the column.
--
-- Safe to re-run: json_type returns 'text' only for the corrupted rows
-- (top-level JSON string). Correctly-encoded array rows are json_type='array'
-- and are skipped.
UPDATE users
SET scopes = json_extract(scopes, '$')
WHERE json_valid(scopes) AND json_type(scopes) = 'text';
--> statement-breakpoint
UPDATE api_keys
SET scopes = json_extract(scopes, '$')
WHERE json_valid(scopes) AND json_type(scopes) = 'text';
