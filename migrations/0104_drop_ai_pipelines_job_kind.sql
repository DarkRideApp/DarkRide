-- Pipelines don't carry a "job kind" identity — a Trigger binds to an event, or a pipeline is run
-- directly by id. The one real consumer of the old job_kind='apk-analysis' lookup was
-- apk-analyzer.ts's own internal pointer to "the" APK Analysis pipeline; that's now a settings row
-- instead of a pipeline column. Backfill it from any existing row before the column is gone, or an
-- already-seeded pipeline would silently get duplicated on next boot.
INSERT OR IGNORE INTO settings (key, value)
  SELECT 'apk_analysis_pipeline_id', CAST(id AS TEXT) FROM ai_pipelines WHERE job_kind = 'apk-analysis' ORDER BY id LIMIT 1;
--> statement-breakpoint
ALTER TABLE ai_pipelines DROP COLUMN job_kind;
