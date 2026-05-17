ALTER TABLE devices ADD COLUMN platform TEXT NOT NULL DEFAULT 'android';
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN ios_version TEXT;
