ALTER TABLE ai_resource ADD COLUMN security_disabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ai_resource_version ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
UPDATE ai_resource_version v SET metadata=jsonb_build_object('name',r.name,'description',r.description) FROM ai_resource r WHERE r.id=v.resource_id;
CREATE OR REPLACE FUNCTION workspace_resource_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.config IS DISTINCT FROM OLD.config OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
 OR NEW.version IS DISTINCT FROM OLD.version OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
 OR NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.created_by IS DISTINCT FROM OLD.created_by
 OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
  RAISE EXCEPTION 'Resource versions are immutable';
 END IF;
 RETURN NEW;
END $$;
