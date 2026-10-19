CREATE TABLE ai_command (
 actor_user_id BIGINT NOT NULL REFERENCES sys_user(user_id), operation VARCHAR(60) NOT NULL,
 idempotency_key UUID NOT NULL, input_hash CHAR(64) NOT NULL, result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(actor_user_id,operation,idempotency_key)
);
