CREATE TABLE IF NOT EXISTS `ai_conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_context` text NOT NULL,
	`context_id` text NOT NULL,
	`title` text,
	`messages` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
