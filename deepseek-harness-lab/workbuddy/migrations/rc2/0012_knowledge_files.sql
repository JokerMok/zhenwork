CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE ai_file (
 id UUID PRIMARY KEY,oss_id BIGINT NOT NULL UNIQUE REFERENCES sys_oss(oss_id),owner_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
 purpose VARCHAR(16) NOT NULL CHECK(purpose IN('KNOWLEDGE','CHAT','BRAND')),resource_id UUID REFERENCES ai_resource(id),session_id UUID REFERENCES ai_session(id),
 filename VARCHAR(120) NOT NULL,media_type VARCHAR(80) NOT NULL,byte_size BIGINT NOT NULL,sha256 CHAR(64) NOT NULL,
 storage_key UUID NOT NULL UNIQUE,auth_version BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),deleted_at TIMESTAMPTZ,
 CHECK((purpose='KNOWLEDGE' AND resource_id IS NOT NULL AND session_id IS NULL) OR (purpose='CHAT' AND session_id IS NOT NULL AND resource_id IS NULL) OR (purpose='BRAND' AND resource_id IS NULL AND session_id IS NULL))
);
CREATE INDEX ai_file_session ON ai_file(session_id,created_at) WHERE deleted_at IS NULL;
CREATE TABLE ai_knowledge_base (
 resource_id UUID PRIMARY KEY REFERENCES ai_resource(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE ai_knowledge_document (
 id UUID PRIMARY KEY,base_id UUID NOT NULL REFERENCES ai_knowledge_base(resource_id),title VARCHAR(120) NOT NULL,
 latest_version INTEGER NOT NULL DEFAULT 1,indexed_version INTEGER,auth_version BIGINT NOT NULL DEFAULT 1,
 created_by BIGINT NOT NULL REFERENCES sys_user(user_id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),deleted_at TIMESTAMPTZ
);
CREATE TABLE ai_knowledge_document_version (
 document_id UUID NOT NULL REFERENCES ai_knowledge_document(id),version INTEGER NOT NULL,file_id UUID NOT NULL UNIQUE REFERENCES ai_file(id),
 text_content TEXT NOT NULL,content_hash CHAR(64) NOT NULL,status VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','INDEXING','READY','ERROR')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(document_id,version)
);
CREATE TABLE ai_knowledge_index (
 document_id UUID NOT NULL,version INTEGER NOT NULL,chunk_index INTEGER NOT NULL,line_start INTEGER NOT NULL,line_end INTEGER NOT NULL,
 content TEXT NOT NULL,search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',content)) STORED,
 PRIMARY KEY(document_id,version,chunk_index),FOREIGN KEY(document_id,version) REFERENCES ai_knowledge_document_version(document_id,version)
);
CREATE INDEX ai_knowledge_index_words ON ai_knowledge_index USING GIN(search_vector);
CREATE INDEX ai_knowledge_index_trigram ON ai_knowledge_index USING GIN(content gin_trgm_ops);
CREATE TABLE ai_knowledge_job (
 id UUID PRIMARY KEY,document_id UUID NOT NULL,version INTEGER NOT NULL,requested_by BIGINT NOT NULL REFERENCES sys_user(user_id),
 status VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK(status IN('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
 error_code VARCHAR(80),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),finished_at TIMESTAMPTZ,
 FOREIGN KEY(document_id,version) REFERENCES ai_knowledge_document_version(document_id,version)
);
CREATE UNIQUE INDEX ai_knowledge_job_active ON ai_knowledge_job(document_id,version) WHERE status IN('QUEUED','RUNNING');
CREATE VIEW ai_knowledge_acl AS SELECT a.* FROM ai_resource_acl a JOIN ai_knowledge_base b ON b.resource_id=a.resource_id;
CREATE TABLE ai_run_document (
 run_id UUID NOT NULL REFERENCES ai_run(id),document_id UUID NOT NULL,version INTEGER NOT NULL,auth_version BIGINT NOT NULL,
 PRIMARY KEY(run_id,document_id),FOREIGN KEY(document_id,version) REFERENCES ai_knowledge_document_version(document_id,version)
);
CREATE TABLE ai_run_file (
 run_id UUID NOT NULL REFERENCES ai_run(id),file_id UUID NOT NULL REFERENCES ai_file(id),auth_version BIGINT NOT NULL,PRIMARY KEY(run_id,file_id)
);
CREATE TABLE ai_knowledge_citation (
 id UUID PRIMARY KEY,run_id UUID NOT NULL REFERENCES ai_run(id),document_id UUID NOT NULL,version INTEGER NOT NULL,chunk_index INTEGER NOT NULL,reference VARCHAR(20) NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(run_id,document_id,version,chunk_index),UNIQUE(run_id,reference),
 FOREIGN KEY(document_id,version,chunk_index) REFERENCES ai_knowledge_index(document_id,version,chunk_index)
);
CREATE FUNCTION ai_document_version_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Document versions cannot be deleted'; END IF;
 IF OLD.file_id IS DISTINCT FROM NEW.file_id OR OLD.text_content IS DISTINCT FROM NEW.text_content OR OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN RAISE EXCEPTION 'Document version content is immutable'; END IF;RETURN NEW; END $$;
CREATE TRIGGER ai_document_version_immutable BEFORE UPDATE OR DELETE ON ai_knowledge_document_version FOR EACH ROW EXECUTE FUNCTION ai_document_version_immutable();

INSERT INTO ai_knowledge_base(resource_id) SELECT id FROM ai_resource WHERE resource_type='KNOWLEDGE';
