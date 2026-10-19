-- Persistent per-account login throttling. Keys are HMACs, never email addresses.
CREATE TABLE auth_attempt_limits(key TEXT PRIMARY KEY, window_start TIMESTAMPTZ NOT NULL, count INTEGER NOT NULL CHECK(count>=0));
CREATE INDEX auth_attempt_limits_expiry_idx ON auth_attempt_limits(window_start);
