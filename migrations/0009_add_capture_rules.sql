ALTER TABLE automations ADD COLUMN is_capture_rule INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE automations ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
