CREATE UNIQUE INDEX ai_resource_review_pending ON ai_resource_review(resource_id) WHERE state='PENDING';
CREATE TABLE ai_review_document (
 review_id UUID NOT NULL REFERENCES ai_resource_review(id),document_id UUID NOT NULL,version INTEGER NOT NULL,
 PRIMARY KEY(review_id,document_id),FOREIGN KEY(document_id,version) REFERENCES ai_knowledge_document_version(document_id,version)
);
CREATE TABLE ai_public_document (
 resource_id UUID NOT NULL REFERENCES ai_resource(id),document_id UUID NOT NULL,version INTEGER NOT NULL,
 PRIMARY KEY(resource_id,document_id),FOREIGN KEY(document_id,version) REFERENCES ai_knowledge_document_version(document_id,version)
);
CREATE OR REPLACE FUNCTION ai_document_version_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Document versions cannot be deleted'; END IF;
 IF OLD.document_id IS DISTINCT FROM NEW.document_id OR OLD.version IS DISTINCT FROM NEW.version OR OLD.created_at IS DISTINCT FROM NEW.created_at OR OLD.file_id IS DISTINCT FROM NEW.file_id OR OLD.text_content IS DISTINCT FROM NEW.text_content OR OLD.content_hash IS DISTINCT FROM NEW.content_hash THEN RAISE EXCEPTION 'Document version content is immutable'; END IF;RETURN NEW; END $$;
INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,component,menu_type,visible,status,perms,icon) VALUES
(1802000000000002002,'资源管理',1802000000000002000,2,'resources','ai/resources/index','C','0','0','ai:resource:enterprise','component'),
(1802000000000002003,'资源审核',1802000000000002000,3,'reviews','ai/reviews/index','C','0','0','ai:resource:review','validCode');
