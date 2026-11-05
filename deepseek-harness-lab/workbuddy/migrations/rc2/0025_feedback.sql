CREATE TABLE ai_task_feedback_provenance (
    id UUID PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
    task_id VARCHAR(100) NOT NULL,
    attempt_id UUID NOT NULL,
    assistant_id UUID,
    assistant_version INTEGER,
    model_id UUID,
    model_version BIGINT,
    provider_id UUID,
    provider_version BIGINT,
    skills JSONB,
    mcps JSONB,
    tools JSONB,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_user_id, task_id, attempt_id)
);

CREATE INDEX ai_task_feedback_provenance_task
    ON ai_task_feedback_provenance(owner_user_id, task_id, captured_at DESC);

CREATE TABLE ai_feedback (
    id UUID PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES sys_user(user_id),
    task_id VARCHAR(100) NOT NULL,
    attempt_id UUID NOT NULL,
    provenance_id UUID REFERENCES ai_task_feedback_provenance(id),
    category VARCHAR(32) NOT NULL CHECK(category IN('correct','data_calculation','citation','tool','artifact','other')),
    note VARCHAR(500) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'NEW' CHECK(status IN('NEW','IN_PROGRESS','RESOLVED','CLOSED')),
    badcase_description VARCHAR(2000),
    root_cause VARCHAR(2000),
    cause_evidence VARCHAR(1000),
    expected_result VARCHAR(2000),
    resolution VARCHAR(2000),
    resolution_revision INTEGER NOT NULL DEFAULT 0 CHECK(resolution_revision >= 0),
    record_version INTEGER NOT NULL DEFAULT 1 CHECK(record_version > 0),
    handled_by BIGINT REFERENCES sys_user(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    UNIQUE(owner_user_id, task_id, attempt_id)
);

CREATE INDEX ai_feedback_admin_queue ON ai_feedback(status, created_at DESC, id);
CREATE INDEX ai_feedback_owner ON ai_feedback(owner_user_id, created_at DESC, id);

CREATE TABLE ai_feedback_recheck (
    id UUID PRIMARY KEY,
    feedback_id UUID NOT NULL REFERENCES ai_feedback(id),
    resolution_revision INTEGER NOT NULL CHECK(resolution_revision >= 0),
    check_description VARCHAR(500) NOT NULL,
    expected_result VARCHAR(1000) NOT NULL,
    actual_result VARCHAR(1000) NOT NULL,
    evidence VARCHAR(1000) NOT NULL,
    result VARCHAR(8) NOT NULL CHECK(result IN('PASSED','FAILED')),
    checked_by BIGINT NOT NULL REFERENCES sys_user(user_id),
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ai_feedback_recheck_history
    ON ai_feedback_recheck(feedback_id, checked_at DESC, id DESC);

INSERT INTO sys_menu(menu_id,menu_name,parent_id,order_num,path,component,menu_type,visible,status,perms,icon)
VALUES(1802000000000003003,'反馈与 Badcase',1802000000000003000,3,'feedback','ai/feedback/index','C','0','0','ai:audit:view','message');

INSERT INTO sys_role_menu(role_id,menu_id)
SELECT role_id,1802000000000003003
FROM sys_role_menu
WHERE menu_id=1802000000000003002
ON CONFLICT DO NOTHING;
