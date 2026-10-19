-- Audit and usage queries introduced in P6 use bounded date windows and exact actors/actions.
CREATE INDEX audit_actor_time_idx ON audit_events(actor_id, created_at DESC, seq DESC);
CREATE INDEX audit_action_time_idx ON audit_events(action, created_at DESC, seq DESC);
CREATE INDEX usage_department_time_idx ON usage_events(department_id, created_at DESC);
CREATE INDEX usage_model_time_idx ON usage_events(model_code, created_at DESC);
