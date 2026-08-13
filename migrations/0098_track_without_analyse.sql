-- Separate "track this app's version" from "download and analyse its APK", and
-- keep the store metadata the version check already fetches.
--
-- Until now `app_sources.enabled` meant both: any enabled source that saw a new
-- version immediately downloaded and decompiled it, so watching a version cost a
-- full APK pull. `auto_analyse` splits the two.
--
-- The default is 0 (off) so tracking a NEW app is cheap, but every EXISTING row
-- is backfilled to 1 below: those apps are being analysed today, and shipping a
-- migration that silently stops that would be a regression dressed as a default.
ALTER TABLE tracked_apps ADD COLUMN auto_analyse integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE tracked_apps SET auto_analyse = 1;
--> statement-breakpoint
-- Store-listing metadata captured beside `last_version`. The source already has
-- all of it in the response it makes to read the version; it was discarded
-- because VersionCheckResult modelled only the version string. Per-source
-- because two stores list the same app differently. All nullable.
ALTER TABLE app_sources ADD COLUMN last_icon_url text;
--> statement-breakpoint
ALTER TABLE app_sources ADD COLUMN last_release_notes text;
--> statement-breakpoint
ALTER TABLE app_sources ADD COLUMN last_size_label text;
--> statement-breakpoint
ALTER TABLE app_sources ADD COLUMN last_store_updated_at integer;
