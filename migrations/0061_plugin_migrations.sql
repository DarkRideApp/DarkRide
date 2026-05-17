CREATE TABLE IF NOT EXISTS `pluginMigrations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `plugin` text NOT NULL,
  `version` text NOT NULL,
  `migrated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_plugin_migrations_plugin` ON `pluginMigrations` (`plugin`);
