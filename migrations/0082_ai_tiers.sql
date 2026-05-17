CREATE TABLE ai_tiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL,
  is_hardcoded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO ai_tiers (name, sort_order, is_hardcoded, created_at, updated_at)
VALUES ('High', 0, 1, 1776900000000, 1776900000000);
--> statement-breakpoint
INSERT INTO ai_tiers (name, sort_order, is_hardcoded, created_at, updated_at)
VALUES ('Low', 1, 1, 1776900000000, 1776900000000);
--> statement-breakpoint
ALTER TABLE ai_models ADD COLUMN tier_id INTEGER REFERENCES ai_tiers(id);
--> statement-breakpoint
UPDATE ai_models SET tier_id = (SELECT id FROM ai_tiers WHERE name = 'High') WHERE tier_id IS NULL;
--> statement-breakpoint
ALTER TABLE ai_models DROP COLUMN task_type;
--> statement-breakpoint
DELETE FROM settings WHERE key IN ('analysis_tier_research_model', 'analysis_tier_write_model');
--> statement-breakpoint
INSERT OR IGNORE INTO settings (key, value) VALUES ('analysis_tier_research', 'Low');
--> statement-breakpoint
INSERT OR IGNORE INTO settings (key, value) VALUES ('analysis_tier_write', 'High');
