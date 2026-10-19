ALTER TABLE runs ADD COLUMN input_hash TEXT;
ALTER TABLE sessions ADD COLUMN runtime_initialized BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE session_files(session_id UUID NOT NULL REFERENCES sessions(id),file_id UUID NOT NULL REFERENCES files(id),PRIMARY KEY(session_id,file_id));
