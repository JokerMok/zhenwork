CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE ai_knowledge_document_version
 ADD COLUMN source_media_type VARCHAR(120) NOT NULL DEFAULT 'text/plain; charset=utf-8',
 ADD COLUMN extraction_method VARCHAR(40) NOT NULL DEFAULT 'LEGACY_TEXT',
 ADD COLUMN extraction_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ai_knowledge_index
 ADD COLUMN location_type VARCHAR(24) NOT NULL DEFAULT 'LINE',
 ADD COLUMN location_label VARCHAR(200) NOT NULL DEFAULT '全文';

DROP TRIGGER IF EXISTS ai_document_version_immutable ON ai_knowledge_document_version;
CREATE OR REPLACE FUNCTION ai_document_version_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Document versions cannot be deleted'; END IF;
 IF OLD.file_id IS DISTINCT FROM NEW.file_id OR OLD.source_media_type IS DISTINCT FROM NEW.source_media_type THEN
  RAISE EXCEPTION 'Document version source cannot be changed';
 END IF;
 IF OLD.text_content IS DISTINCT FROM NEW.text_content OR OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN
  IF OLD.extraction_method<>'PENDING' OR OLD.text_content<>'' OR NEW.text_content='' OR OLD.status NOT IN('QUEUED','INDEXING') THEN
   RAISE EXCEPTION 'Document version content is immutable';
  END IF;
 END IF;
 IF OLD.extraction_method<>'PENDING' AND (OLD.extraction_method IS DISTINCT FROM NEW.extraction_method OR OLD.extraction_metadata IS DISTINCT FROM NEW.extraction_metadata) THEN
  RAISE EXCEPTION 'Document extraction metadata is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_document_version_immutable BEFORE UPDATE OR DELETE ON ai_knowledge_document_version FOR EACH ROW EXECUTE FUNCTION ai_document_version_immutable();

CREATE INDEX IF NOT EXISTS ai_knowledge_document_visible ON ai_knowledge_document(base_id,updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ai_knowledge_job_queue ON ai_knowledge_job(created_at) WHERE status='QUEUED';
