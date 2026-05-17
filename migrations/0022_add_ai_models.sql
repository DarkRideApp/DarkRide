CREATE TABLE IF NOT EXISTS `ai_models` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`api_key` text,
	`base_url` text,
	`oauth_access_token` text,
	`oauth_refresh_token` text,
	`oauth_expires_at` integer,
	`enabled` integer DEFAULT true,
	`priority` integer NOT NULL DEFAULT 0,
	`cooldown_minutes` integer DEFAULT 10,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
