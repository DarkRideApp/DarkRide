ALTER TABLE ai_conversations ADD COLUMN user_id INTEGER;
--> statement-breakpoint
ALTER TABLE ai_conversations ADD COLUMN origin_path TEXT;
--> statement-breakpoint
ALTER TABLE ai_conversations ADD COLUMN unfinished INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE ai_conversations ADD COLUMN automated INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE ai_conversations SET automated = 1 WHERE page_context = 'apk-diff';
