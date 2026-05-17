CREATE TABLE IF NOT EXISTS `blocked_domains` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `blocked_domains_domain_unique` ON `blocked_domains` (`domain`);
