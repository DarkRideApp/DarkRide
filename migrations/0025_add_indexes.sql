CREATE INDEX IF NOT EXISTS idx_captured_traffic_session_id ON captured_traffic(session_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_captured_traffic_device_id ON captured_traffic(device_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_captured_traffic_captured_at ON captured_traffic(captured_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_captured_traffic_type ON captured_traffic(type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automation_sessions_automation_id ON automation_sessions(automation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automation_sessions_started_at ON automation_sessions(started_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_automation_sessions_status ON automation_sessions(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_screenshots_session_id ON screenshots(session_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cloud_files_sync_state ON cloud_files(sync_state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_apk_version_id ON analysis_jobs(apk_version_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_credentials_app_id ON credentials(app_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ai_models_provider_id ON ai_models(provider_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_saved_traffic_url_method ON saved_traffic(url, method);
