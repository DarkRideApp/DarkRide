-- One-shot repair: any ai_models row with NULL tier_id gets assigned to the
-- High tier. This catches rows created via paths that bypassed the High
-- default in the API (e.g. the UI's add-model modal sending tierId: null
-- before its tier list loaded).
--
-- The fix is also applied at the API layer (backend/api/ai-models.ts),
-- so this migration is a one-time data repair — future inserts/updates
-- will not produce orphans.
--
-- Idempotent: rows that already have a tier_id are left alone.
UPDATE ai_models
SET tier_id = (SELECT id FROM ai_tiers WHERE name = 'High')
WHERE tier_id IS NULL;
