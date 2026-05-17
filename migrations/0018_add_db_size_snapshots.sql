CREATE TABLE IF NOT EXISTS `db_size_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`size_bytes` integer NOT NULL,
	`captured_at` integer NOT NULL
);
