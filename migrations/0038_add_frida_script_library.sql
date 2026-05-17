ALTER TABLE frida_scripts ADD COLUMN category TEXT;
--> statement-breakpoint
ALTER TABLE frida_scripts ADD COLUMN is_builtin INTEGER DEFAULT 0;