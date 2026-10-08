-- OpenRouter and Gemini ignored ai_providers.base_url until the provider registry.
-- The settings form always posted a value, so stale rows exist (for example a retyped
-- Ollama URL). Null them so honouring the field does not point live traffic at them.
UPDATE ai_providers SET base_url = NULL WHERE type IN ('openrouter', 'gemini') AND base_url IS NOT NULL;
