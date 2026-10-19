ALTER TABLE ai_run ADD COLUMN config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
