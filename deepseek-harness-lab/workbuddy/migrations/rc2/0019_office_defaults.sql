CREATE TABLE ai_office_defaults (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
 model_id UUID REFERENCES ai_model(id),
 version BIGINT NOT NULL DEFAULT 1,
 updated_by BIGINT REFERENCES sys_user(user_id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO ai_office_defaults(singleton,model_id)
SELECT TRUE,id FROM ai_model WHERE enabled AND streaming ORDER BY created_at,id LIMIT 1;
INSERT INTO ai_office_defaults(singleton) VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING;
